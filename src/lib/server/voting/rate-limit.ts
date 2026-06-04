import { createHash, randomBytes } from 'node:crypto';
import { redis } from '../redis';

const SALT_TTL_SEC = 48 * 60 * 60;
const RATE_WINDOW_SEC = 60;
const RATE_MAX = 30;
const MIN_VOTED_TTL_SEC = 60;

// Auth-эндпоинты — отдельные более жёсткие бакеты, чтобы перебор пароля
// не попадал в общий "30 запросов/мин" бюджет голосовалок.
const AUTH_WINDOW_SEC = 15 * 60;
const AUTH_IP_MAX = 30; // 30 попыток с одного IP за 15 минут
const AUTH_EMAIL_MAX = 5; // 5 попыток на конкретный email за 15 минут

// WebSocket upgrade — отдельный бакет: легитимный клиент открывает
// 1 WS на дашборд, реконнект-петля 3с. 60 апгрейдов/мин с одного IP
// многократный запас, защита от бот-перебора creatorToken через
// массовые reconnect'ы.
const WS_WINDOW_SEC = 60;
const WS_MAX = 60;

function todaySaltKey(): string {
  const d = new Date();
  return `salt:${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

// In-process кэш на сегодняшний salt: раньше каждый rate-check / hasVoted /
// markVoted делал отдельный GET в Redis, на горячем пути это N×RTT в одном
// запросе (например, /answer = checkRateLimit + hasVoted + markVoted = 3 GET'а).
// Кэш живёт ровно до конца UTC-суток (полночь UTC); после — пересоздаётся.
type SaltEntry = { value: string; expiresAtMs: number };
let saltCache: SaltEntry | null = null;
let saltInflight: Promise<string> | null = null;

function nextUtcMidnightMs(now: Date = new Date()): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
}

async function getOrCreateSalt(): Promise<string> {
  const now = Date.now();
  if (saltCache && saltCache.expiresAtMs > now) return saltCache.value;
  // Дедуплицируем параллельные запросы за одним salt'ом — чтобы при rollover
  // мы не сделали 100 одинаковых GET+SETEX в Redis.
  if (saltInflight) return saltInflight;
  saltInflight = (async () => {
    try {
      const key = todaySaltKey();
      const existing = await redis.get(key);
      const value = existing ?? randomBytes(32).toString('hex');
      if (!existing) await redis.setex(key, SALT_TTL_SEC, value);
      saltCache = { value, expiresAtMs: nextUtcMidnightMs() };
      return value;
    } finally {
      saltInflight = null;
    }
  })();
  return saltInflight;
}

async function ipHash(ip: string): Promise<string> {
  const salt = await getOrCreateSalt();
  return createHash('sha256').update(`${ip}:${salt}`).digest('hex');
}

// --- Survey-stable IP hash for vote dedup ----------------------------------
//
// `ipHash` above mixes in a DAILY-rotating salt (good for privacy on the
// short-lived rate-limit / auth buckets). The `voted:` dedup key must instead
// stay stable for the WHOLE lifetime of a survey: a survey spanning UTC
// midnight would otherwise re-hash the same client to a new value the next day
// and let them vote again. Vote dedup therefore uses a PER-SURVEY salt created
// once and kept (with a generous cap) for the survey's lifetime.
const SURVEY_SALT_TTL_SEC = 90 * 24 * 60 * 60;

const surveySaltCache = new Map<string, string>();

async function getOrCreateSurveySalt(code: string): Promise<string> {
  const cached = surveySaltCache.get(code);
  if (cached) return cached;
  const key = `votesalt:${code}`;
  const existing = await redis.get(key);
  const value = existing ?? randomBytes(32).toString('hex');
  if (!existing) {
    await redis.setex(key, SURVEY_SALT_TTL_SEC, value);
  } else {
    await redis.expire(key, SURVEY_SALT_TTL_SEC);
  }
  surveySaltCache.set(code, value);
  return value;
}

async function voteIpHash(ip: string, code: string): Promise<string> {
  const salt = await getOrCreateSurveySalt(code);
  return createHash('sha256').update(`${ip}:${salt}`).digest('hex');
}

// Lua-скрипт: атомарный INCR + EXPIRE при первом увеличении.
// Возвращает [count, ttl].
//
// Раньше шла последовательная пара INCR → EXPIRE: между ними другой запрос
// мог увидеть существующий ключ (чужой INCR создал его) и пропустить EXPIRE,
// в итоге получался ключ без TTL → утечка в Redis. Lua делает эти команды
// в одном тике event loop сервера Redis — никакая другая команда между
// ними не вклинится.
const INCR_EXPIRE_LUA = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  return {n, tonumber(ARGV[1])}
end
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {n, ttl}
`;

async function incrWithExpire(key: string, windowSec: number): Promise<[number, number]> {
  const r = (await redis.eval(INCR_EXPIRE_LUA, 1, key, String(windowSec))) as [number, number];
  return r;
}

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSec: number };

export async function checkRateLimit(ip: string): Promise<RateLimitResult> {
  const hash = await ipHash(ip);
  const [cnt, ttl] = await incrWithExpire(`rl:${hash}`, RATE_WINDOW_SEC);
  if (cnt > RATE_MAX) {
    return { allowed: false, retryAfterSec: ttl > 0 ? ttl : RATE_WINDOW_SEC };
  }
  return { allowed: true };
}

export async function hasVoted(ip: string, code: string): Promise<boolean> {
  const hash = await voteIpHash(ip, code);
  return (await redis.exists(`voted:${hash}:${code}`)) === 1;
}

export async function markVoted(ip: string, code: string, expiresAt: Date): Promise<void> {
  const hash = await voteIpHash(ip, code);
  const ttlSec = Math.max(MIN_VOTED_TTL_SEC, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  await redis.setex(`voted:${hash}:${code}`, ttlSec, '1');
}

/**
 * Атомарно «занять» голос: SET key 1 NX EX ttl. Возвращает true, если ключ
 * был успешно создан (этот IP ещё не голосовал), и false, если уже голосовал.
 *
 * Заменяет пару `hasVoted` + `markVoted`: между ними был узкий race window —
 * два параллельных запроса с одного IP проходили `hasVoted=false` и оба
 * отправлялись в `submitAnswers` (двойной голос). NX делает проверку и запись
 * в одной команде Redis.
 *
 * Если БД/Redis потом отдают ошибку (overloaded), нужно явно освободить ключ
 * через `releaseVote`, чтобы клиент мог попробовать заново.
 */
export async function tryClaimVote(ip: string, code: string, expiresAt: Date): Promise<boolean> {
  const hash = await voteIpHash(ip, code);
  const ttlSec = Math.max(MIN_VOTED_TTL_SEC, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  const r = await redis.set(`voted:${hash}:${code}`, '1', 'EX', ttlSec, 'NX');
  return r === 'OK';
}

/**
 * Снимает «занятый» голос — нужно при ошибке принятия голоса (overloaded /
 * 5xx), чтобы клиент мог ретрайнуть. Без этого `tryClaimVote` оставлял бы
 * запись на TTL, и пользователь видел бы 409 «Уже голосовали» при повторе.
 */
export async function releaseVote(ip: string, code: string): Promise<void> {
  const hash = await voteIpHash(ip, code);
  await redis.del(`voted:${hash}:${code}`);
}

/**
 * Рейт-лимит для auth-эндпоинтов (`/api/auth/login`, `/register`).
 * Считаем два независимых бакета и блокируем, если превышен любой из них:
 *   - по IP (защита от brute-force с одного хоста);
 *   - по email (защита от перебора пароля для конкретного аккаунта,
 *     даже если идёт с пула IP).
 *
 * Email нормализуется (`trim().toLowerCase()`) и хэшируется тем же
 * salted-sha256, чтобы Redis не хранил адреса в открытом виде.
 */
export async function checkAuthRateLimit(ip: string, email: string): Promise<RateLimitResult> {
  const [ipH, emailH] = await Promise.all([ipHash(ip), emailHash(email)]);
  const ipKey = `auth_rl:ip:${ipH}`;
  const emailKey = `auth_rl:email:${emailH}`;

  // INCR-ы делаем параллельно: между ними никаких зависимостей нет, а оба
  // — атомарные Lua-скрипты с гарантированным TTL. Раньше шли последовательно
  // и без транзакции, что в дополнение к лишней RTT давало шанс пропустить
  // EXPIRE при гонке.
  const [[ipCnt, ipTtl], [emailCnt, emailTtl]] = await Promise.all([
    incrWithExpire(ipKey, AUTH_WINDOW_SEC),
    incrWithExpire(emailKey, AUTH_WINDOW_SEC)
  ]);

  if (ipCnt > AUTH_IP_MAX || emailCnt > AUTH_EMAIL_MAX) {
    const retryAfterSec = Math.max(ipTtl, emailTtl, 60);
    return { allowed: false, retryAfterSec };
  }
  return { allowed: true };
}

async function emailHash(email: string): Promise<string> {
  const salt = await getOrCreateSalt();
  return createHash('sha256').update(`email:${email.trim().toLowerCase()}:${salt}`).digest('hex');
}

/**
 * Лимит WebSocket-апгрейдов с одного IP. Защищает от bot-perebora
 * creatorToken через массовые reconnect'ы. На WS-handshake обычный
 * rate-limit не работает — там нет SvelteKit-обёртки.
 */
export async function checkWsRateLimit(ip: string): Promise<RateLimitResult> {
  const key = `ws_rl:${await ipHash(ip)}`;
  const [cnt, ttl] = await incrWithExpire(key, WS_WINDOW_SEC);
  if (cnt > WS_MAX) {
    return { allowed: false, retryAfterSec: ttl > 0 ? ttl : WS_WINDOW_SEC };
  }
  return { allowed: true };
}
