import { env } from '$env/dynamic/private';
import { db } from '../db';
import { responses } from '../schema';
import { redis } from '../redis';
import { log } from '../log';
import { incVotesAccepted, incVotesFlushed, setVotesPending } from '../metrics';
import type { ProcessedAnswer } from './validate';

type QueueItem = {
  questionId: string;
  word: string;
  wordNorm: string;
};

const FLUSH_INTERVAL_MS = 200;
const FLUSH_THRESHOLD = 100;
// Жёсткий потолок in-memory очереди. Если БД/Redis лежат и flush'и
// возвращают batch обратно, без потолка буфер растёт линейно с RPS до
// OOM. 100k items × ~100 байт = ~10 МБ — переживаемо, в 100 раз больше
// FLUSH_THRESHOLD; превышение → сервис отдаёт 503 в `/answer`, чтобы
// клиент попробовал позже, пока не дренируется очередь.
const MAX_BUFFER_SIZE = 100_000;

// --- Durability mode --------------------------------------------------------
//
// By default votes are buffered in memory and flushed periodically, keeping
// the hot /answer path fast. A HARD crash (OOM / kill -9 — not SIGTERM/SIGINT,
// which we drain via flushPending) can lose up to one buffer of already-acked
// votes. Durable writes are therefore ON by default: votes are flushed
// synchronously, so a 201 is only returned after the rows are persisted (costs
// ~1 DB round-trip of latency). Deployments that prefer the faster buffered
// path and accept the crash-loss trade-off can opt out with
// VOTE_DURABLE_WRITES=false.
const DURABLE_WRITES = env.VOTE_DURABLE_WRITES !== 'false';
// Чанк для bulk-INSERT'а: postgres-js по умолчанию имеет лимит ~65k параметров,
// при batch > ~5k items × 3 поля параметрический предел нарушался → пакет
// возвращался ошибкой и шёл по retry-петле. 1000 даёт 3000 параметров —
// в 20 раз меньше предела, оставляет запас на дополнительные поля schema.
const INSERT_CHUNK = 1000;
// Fallback-TTL для агрегатов в Redis (`cloud:${questionId}`).
// Первичная очистка — в `expiry/process.ts` после отправки email; этот TTL
// нужен только чтобы данные не висели вечно, если процесс завершения не дошёл
// до DEL (упал, был убит, опрос «застрял» в expired). 7 дней покрывает любой
// разумный срок жизни опроса (UI ограничивает создание `expires_at` ближайшим
// будущим, и cron форсит закрытие через ~5 мин после истечения).
const CLOUD_KEY_TTL_SEC = 7 * 24 * 60 * 60;
// Backoff после ошибки flush'а: первый ретрай через 200мс (FLUSH_INTERVAL_MS),
// дальше — экспоненциально до 5с. Без backoff'а при «легла БД» цикл
// retry × N ≈ 5/sec на воркер тратил CPU+коннект-pool впустую.
const FLUSH_BACKOFF_BASE_MS = 200;
const FLUSH_BACKOFF_MAX_MS = 5_000;
// Сколько раз дренаж пробует пробить буфер на graceful shutdown. 5×500мс =
// 2.5с — укладывается в типовой terminationGracePeriodSeconds=30.
const SHUTDOWN_RETRIES = 5;
const SHUTDOWN_RETRY_DELAY_MS = 500;

const buffer: QueueItem[] = [];
let timer: NodeJS.Timeout | null = null;
let flushing = false;
let consecutiveFailures = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function flush(): Promise<void> {
  if (flushing || buffer.length === 0) return;
  flushing = true;
  const batch = buffer.splice(0, buffer.length);
  try {
    // Чанкуем INSERT, чтобы не упереться в лимит параметров postgres-js.
    // Чанки идут последовательно: rollback одного чанка не должен «терять»
    // последующие — splice уже убрал items из буфера, при ошибке мы их
    // целиком возвращаем в начало буфера через unshift ниже.
    for (let i = 0; i < batch.length; i += INSERT_CHUNK) {
      await db.insert(responses).values(batch.slice(i, i + INSERT_CHUNK));
    }
    const pipeline = redis.pipeline();
    // Дедуплицируем questionId, чтобы EXPIRE вызывался один раз на ключ за
    // батч — это всё равно «sliding» TTL: каждый flush обновляет срок жизни.
    const seenKeys = new Set<string>();
    for (const item of batch) {
      const key = `cloud:${item.questionId}`;
      pipeline.zincrby(key, 1, item.wordNorm);
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        pipeline.expire(key, CLOUD_KEY_TTL_SEC);
      }
    }
    await pipeline.exec();
    incVotesFlushed(batch.length, 'ok');
    consecutiveFailures = 0;
  } catch (err) {
    // Возвращаем неотданный пакет в начало буфера, чтобы повторить попытку
    // на следующем тике — иначе голоса терялись бы при первой ошибке БД/Redis.
    buffer.unshift(...batch);
    incVotesFlushed(batch.length, 'failed');
    consecutiveFailures++;
    log.error('voting_flush_failed', {
      batchSize: batch.length,
      consecutiveFailures,
      err: String(err)
    });
  } finally {
    setVotesPending(buffer.length);
    flushing = false;
  }
}

function nextDelayMs(): number {
  if (consecutiveFailures === 0) return FLUSH_INTERVAL_MS;
  // Экспоненциальный backoff: 200ms × 2^(failures-1), кэп FLUSH_BACKOFF_MAX_MS.
  return Math.min(FLUSH_BACKOFF_MAX_MS, FLUSH_BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1));
}

function scheduleFlush(): void {
  if (timer) return;
  timer = setTimeout(async () => {
    timer = null;
    await flush();
    if (buffer.length > 0) scheduleFlush();
  }, nextDelayMs());
}

export type SubmitResult = { ok: true; accepted: number } | { ok: false; code: 'overloaded' };

/**
 * Кладёт обработанные ответы в in-memory буфер. Если буфер переполнен
 * (БД/Redis недоступны и flush'и возвращают batch обратно), отдаёт
 * `{ ok: false, code: 'overloaded' }` — вызывающий должен вернуть HTTP
 * 503 с Retry-After. Это защищает от OOM при затяжных авариях нижнего
 * стека: голос не теряется ради корректности, клиент ретраится.
 */
export async function submitAnswers(processed: ProcessedAnswer[]): Promise<SubmitResult> {
  let toAdd = 0;
  for (const answer of processed) toAdd += answer.words.length;

  if (buffer.length + toAdd > MAX_BUFFER_SIZE) {
    log.warn('voting_buffer_overflow', { pending: buffer.length, attempted: toAdd });
    return { ok: false, code: 'overloaded' };
  }

  let added = 0;
  for (const answer of processed) {
    for (let i = 0; i < answer.words.length; i++) {
      buffer.push({
        questionId: answer.questionId,
        word: answer.words[i],
        wordNorm: answer.normalized[i]
      });
      added++;
    }
  }
  if (added > 0) {
    incVotesAccepted(added);
    setVotesPending(buffer.length);
  }
  if (DURABLE_WRITES) {
    // Synchronous persistence: only acknowledge once rows are flushed. On
    // failure the batch stays buffered and we report overloaded so the client
    // retries, rather than acknowledging a vote that was never persisted.
    await flush();
    if (buffer.length > 0) {
      scheduleFlush();
      return { ok: false, code: 'overloaded' };
    }
    return { ok: true, accepted: added };
  }
  if (buffer.length >= FLUSH_THRESHOLD) {
    await flush();
  } else {
    scheduleFlush();
  }
  return { ok: true, accepted: added };
}

/**
 * Дренирует in-memory очередь. Используется обработчиком сигналов
 * остановки процесса в `hooks.server.ts`, чтобы не терять голоса при
 * graceful shutdown (SIGTERM/SIGINT).
 *
 * Между попытками держим `SHUTDOWN_RETRY_DELAY_MS` пауз: если БД/Redis
 * испытывают всплеск, повторное падение через 0мс не имеет смысла —
 * скорее всего тот же таймаут.
 */
export async function flushPending(): Promise<void> {
  for (let i = 0; i < SHUTDOWN_RETRIES && buffer.length > 0; i++) {
    if (i > 0) await sleep(SHUTDOWN_RETRY_DELAY_MS);
    await flush();
  }
}

export function pendingCount(): number {
  return buffer.length;
}
