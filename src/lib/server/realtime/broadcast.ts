import type { WebSocket } from 'ws';
import { redis } from '../redis';
import { encode, type ServerMsg } from './protocol';
import { incWsConnected, decWsConnected } from '../metrics';
import { log } from '../log';
import type { CloudWord, SurveyStatus } from '$lib/types/cloud';

const TICK_MS = 2500;
// Heartbeat: пингуем сокеты раз в 30с и убиваем неответившие. Полу-открытые
// соединения (мобилка ушла в сон, прокси-таймаут, обрыв без FIN) иначе висели
// бы в комнате до TCP-таймаута, копя память и FD.
const HEARTBEAT_MS = 30_000;
// Лимиты для публичного (без аутентификации) /ws/c/{code}: держат ресурсы
// single-VPS под контролем. Один IP не должен занять всю комнату/память.
const MAX_SUBS_PER_ROOM = 500;
const MAX_SUBS_PER_IP = 10;
// Порог backpressure: если клиент не успевает вычитывать и серверный буфер
// сокета раздулся — дропаем его, чтобы не утекала память на медленных клиентах.
const MAX_BUFFERED_BYTES = 1 << 16; // 64 КБ
// Дефолтный лимит, если в room не пришёл `maxWords`. Совпадает с дефолтом
// `surveys.max_words` (см. schema.ts). Клиент в любом случае срежет до своего
// `survey.maxWords`, но без согласованного дефолта мы либо платим лишний
// сетевой трафик (TOP_N>maxWords), либо «теряем хвост» (TOP_N<maxWords).
const DEFAULT_TOP_N = 50;

type Room = {
  code: string;
  questionIds: string[];
  topN: number;
  subscribers: Set<WebSocket>;
  // Счётчик соединений на IP внутри комнаты — для MAX_SUBS_PER_IP.
  subsByIp: Map<string, number>;
  lastTop: Map<string, string>;
};

const rooms = new Map<string, Room>();
let tickerHandle: NodeJS.Timeout | null = null;
let heartbeatHandle: NodeJS.Timeout | null = null;

// IP сокета (для декремента per-IP при отключении) и liveness-флаг heartbeat'а.
// WeakMap — чтобы не держать ссылки на закрытые сокеты.
const wsIp = new WeakMap<WebSocket, string>();
const wsAlive = new WeakMap<WebSocket, boolean>();

async function fetchTop(questionId: string, topN: number): Promise<CloudWord[]> {
  const raw = await redis.zrevrange(`cloud:${questionId}`, 0, topN - 1, 'WITHSCORES');
  const out: CloudWord[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    const word = raw[i];
    const count = Number.parseInt(raw[i + 1], 10);
    if (Number.isFinite(count) && count > 0) out.push([word, count]);
  }
  return out;
}

function send(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState !== ws.OPEN) return;
  // Backpressure: медленный клиент не должен раздувать серверную память.
  if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
    log.warn('ws_slow_client_dropped', { buffered: ws.bufferedAmount });
    ws.close(1013, 'slow_client'); // 1013 = Try Again Later
    return;
  }
  ws.send(encode(msg));
}

export function getRoom(code: string, questionIds: string[], maxWords?: number): Room {
  const topN = Math.max(1, maxWords ?? DEFAULT_TOP_N);
  let room = rooms.get(code);
  if (!room) {
    room = {
      code,
      questionIds,
      topN,
      subscribers: new Set(),
      subsByIp: new Map(),
      lastTop: new Map()
    };
    rooms.set(code, room);
  } else {
    room.questionIds = questionIds;
    room.topN = topN;
  }
  return room;
}

/**
 * Подписывает сокет на комнату. Возвращает false, если превышены лимиты
 * (размер комнаты или число соединений с этого IP) — вызывающий тогда должен
 * закрыть сокет. `ip` — реальный IP клиента (см. net/client-ip.ts).
 */
export async function addSubscriber(room: Room, ws: WebSocket, ip: string): Promise<boolean> {
  if (room.subscribers.size >= MAX_SUBS_PER_ROOM) {
    log.warn('ws_room_full', { code: room.code, size: room.subscribers.size });
    return false;
  }
  const ipCount = room.subsByIp.get(ip) ?? 0;
  if (ipCount >= MAX_SUBS_PER_IP) {
    log.warn('ws_per_ip_limit', { code: room.code });
    return false;
  }

  room.subscribers.add(ws);
  room.subsByIp.set(ip, ipCount + 1);
  wsIp.set(ws, ip);
  registerHeartbeat(ws);
  incWsConnected();
  ensureTimers();
  // Параллельный fetchTop по всем вопросам опроса — экономит N×RTT до Redis
  // на handshake'е (на 5+ вопросах разница хорошо заметна).
  const snapshots = await Promise.all(
    room.questionIds.map(async (qid) => ({ qid, words: await fetchTop(qid, room.topN) }))
  );
  for (const { qid, words } of snapshots) {
    send(ws, { type: 'snapshot', questionId: qid, words });
    room.lastTop.set(qid, JSON.stringify(words));
  }
  return true;
}

export function removeSubscriber(room: Room, ws: WebSocket): void {
  if (room.subscribers.delete(ws)) {
    decWsConnected();
    const ip = wsIp.get(ws);
    if (ip !== undefined) {
      const n = (room.subsByIp.get(ip) ?? 1) - 1;
      if (n <= 0) room.subsByIp.delete(ip);
      else room.subsByIp.set(ip, n);
    }
  }
  if (room.subscribers.size === 0) {
    rooms.delete(room.code);
    maybeStopTimers();
  }
}

export function notifyClosed(code: string, reason: 'expired' | 'sent' | 'failed'): void {
  const room = rooms.get(code);
  if (!room) return;
  const count = room.subscribers.size;
  for (const ws of room.subscribers) {
    send(ws, { type: 'closed', reason });
    if (ws.readyState === ws.OPEN) ws.close(1000, reason);
  }
  // Очищаем set ДО того, как сработают 'close'-хендлеры сокетов: иначе
  // removeSubscriber для каждого закрытого сокета декрементировал бы счётчик
  // ещё раз (двойной декремент → gauge уходил в минус). Декрементируем один
  // раз на всю комнату здесь.
  room.subscribers.clear();
  room.subsByIp.clear();
  decWsConnected(count);
  rooms.delete(code);
  maybeStopTimers();
}

// ───────────────────────────────────────────────────────────
// Per-user push: для /my (страница со списком опросов).
//
// Раньше /my узнавал об изменении статуса (active→sent) только на
// следующем 30-сек polling-цикле. Это давало ощущение «зависшего»
// статуса «Истёк» даже после того, как письмо уже ушло.
//
// Теперь каждый авторизованный клиент `/ws/u` подписывается на
// канал `userChannels[userId]`, а `processExpired` / `/finish` /
// `/retry` пушат `survey-status` сразу после фактической смены
// статуса в БД.
// ───────────────────────────────────────────────────────────

const userChannels = new Map<string, Set<WebSocket>>();

// Лимит одновременных /ws/u-соединений на пользователя: вкладки/устройства
// легитимны, но без потолка скомпрометированный аккаунт мог бы открыть тысячи.
const MAX_USER_WS = 8;

export function addUserSubscriber(userId: string, ws: WebSocket): boolean {
  let set = userChannels.get(userId);
  if (!set) {
    set = new Set();
    userChannels.set(userId, set);
  }
  if (set.size >= MAX_USER_WS) {
    log.warn('ws_user_limit', { userId });
    return false;
  }
  set.add(ws);
  registerHeartbeat(ws);
  incWsConnected();
  ensureTimers();
  return true;
}

export function removeUserSubscriber(userId: string, ws: WebSocket): void {
  const set = userChannels.get(userId);
  if (!set) return;
  if (set.delete(ws)) {
    decWsConnected();
  }
  if (set.size === 0) userChannels.delete(userId);
  maybeStopTimers();
}

export function notifyUserSurveyStatus(
  userId: string | null | undefined,
  code: string,
  status: SurveyStatus
): void {
  if (!userId) return;
  const set = userChannels.get(userId);
  if (!set) return;
  const msg = encode({ type: 'survey-status', code, status });
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

function ensureTimers(): void {
  if (!tickerHandle) {
    tickerHandle = setInterval(() => {
      void tick();
    }, TICK_MS);
  }
  if (!heartbeatHandle) {
    heartbeatHandle = setInterval(heartbeat, HEARTBEAT_MS);
  }
}

// Останавливаем глобальные таймеры, когда подписчиков не осталось ни в одной
// комнате и ни в одном user-канале: иначе на простаивающем сервере висели бы
// бесконечные setInterval'ы.
function maybeStopTimers(): void {
  if (rooms.size > 0 || userChannels.size > 0) return;
  if (tickerHandle) {
    clearInterval(tickerHandle);
    tickerHandle = null;
  }
  if (heartbeatHandle) {
    clearInterval(heartbeatHandle);
    heartbeatHandle = null;
  }
}

// --- Heartbeat: ping/pong liveness, реапинг мёртвых сокетов ------------------

function registerHeartbeat(ws: WebSocket): void {
  wsAlive.set(ws, true);
  ws.on('pong', () => wsAlive.set(ws, true));
}

function* allSockets(): Generator<WebSocket> {
  for (const room of rooms.values()) for (const ws of room.subscribers) yield ws;
  for (const set of userChannels.values()) for (const ws of set) yield ws;
}

function heartbeat(): void {
  for (const ws of allSockets()) {
    if (wsAlive.get(ws) === false) {
      // Не ответил на прошлый ping за целый интервал — считаем мёртвым.
      ws.terminate();
      continue;
    }
    wsAlive.set(ws, false);
    try {
      ws.ping();
    } catch {
      ws.terminate();
    }
  }
}

async function tick(): Promise<void> {
  // Параллелим fetchTop по всем комнатам и вопросам сразу: на одиночном опросе
  // выигрыш минимален, но при 5–10 активных комнатах × 2–3 вопроса
  // sequential await 2.5с×N×K превращался в основной потолок задержки
  // обновления облака.
  const jobs: Array<{ room: Room; qid: string }> = [];
  for (const room of rooms.values()) {
    if (room.subscribers.size === 0) continue;
    for (const qid of room.questionIds) {
      jobs.push({ room, qid });
    }
  }
  if (jobs.length === 0) return;
  const fetched = await Promise.all(jobs.map((j) => fetchTop(j.qid, j.room.topN)));
  for (let i = 0; i < jobs.length; i++) {
    const { room, qid } = jobs[i];
    const words = fetched[i];
    const serialized = JSON.stringify(words);
    if (serialized === room.lastTop.get(qid)) continue;
    const msg = encode({ type: 'snapshot', questionId: qid, words });
    for (const ws of room.subscribers) {
      if (ws.readyState === ws.OPEN) ws.send(msg);
    }
    room.lastTop.set(qid, serialized);
  }
}
