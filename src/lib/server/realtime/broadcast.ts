import type { WebSocket } from 'ws';
import { redis } from '../redis';
import { encode, type ServerMsg } from './protocol';
import { incWsConnected, decWsConnected } from '../metrics';
import type { CloudWord, SurveyStatus } from '$lib/types/cloud';

const TICK_MS = 2500;
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
  lastTop: Map<string, string>;
};

const rooms = new Map<string, Room>();
let tickerHandle: NodeJS.Timeout | null = null;

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
  if (ws.readyState === ws.OPEN) ws.send(encode(msg));
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
      lastTop: new Map()
    };
    rooms.set(code, room);
  } else {
    room.questionIds = questionIds;
    room.topN = topN;
  }
  return room;
}

export async function addSubscriber(room: Room, ws: WebSocket): Promise<void> {
  room.subscribers.add(ws);
  incWsConnected();
  ensureTicker();
  // Параллельный fetchTop по всем вопросам опроса — экономит N×RTT до Redis
  // на handshake'е (на 5+ вопросах разница хорошо заметна).
  const snapshots = await Promise.all(
    room.questionIds.map(async (qid) => ({ qid, words: await fetchTop(qid, room.topN) }))
  );
  for (const { qid, words } of snapshots) {
    send(ws, { type: 'snapshot', questionId: qid, words });
    room.lastTop.set(qid, JSON.stringify(words));
  }
}

export function removeSubscriber(room: Room, ws: WebSocket): void {
  if (room.subscribers.delete(ws)) {
    decWsConnected();
  }
  if (room.subscribers.size === 0) {
    rooms.delete(room.code);
    maybeStopTicker();
  }
}

export function notifyClosed(code: string, reason: 'expired' | 'sent' | 'failed'): void {
  const room = rooms.get(code);
  if (!room) return;
  // Декрементируем счётчик ОДИН раз за фактически отписанный сокет.
  // Раньше `decWsConnected` вызывался здесь и ещё раз через `ws.close → 'close'-handler`
  // → счётчик уползал в минус.
  for (const ws of room.subscribers) {
    send(ws, { type: 'closed', reason });
    if (ws.readyState === ws.OPEN) ws.close(1000, reason);
  }
  decWsConnected(room.subscribers.size);
  rooms.delete(code);
  maybeStopTicker();
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

export function addUserSubscriber(userId: string, ws: WebSocket): void {
  let set = userChannels.get(userId);
  if (!set) {
    set = new Set();
    userChannels.set(userId, set);
  }
  set.add(ws);
  incWsConnected();
}

export function removeUserSubscriber(userId: string, ws: WebSocket): void {
  const set = userChannels.get(userId);
  if (!set) return;
  if (set.delete(ws)) {
    decWsConnected();
  }
  if (set.size === 0) userChannels.delete(userId);
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

function ensureTicker(): void {
  if (tickerHandle) return;
  tickerHandle = setInterval(() => {
    void tick();
  }, TICK_MS);
}

// Останавливаем глобальный таймер, когда подписчиков не осталось ни в одной
// комнате: иначе на простаивающем сервере висел бесконечный setInterval с
// пустым проходом по rooms (1 пустой Map.values() итератор каждые 2.5с — это
// мелочь, но предотвращает «paper handle leak» при graceful shutdown).
function maybeStopTicker(): void {
  if (!tickerHandle) return;
  if (rooms.size > 0) return;
  clearInterval(tickerHandle);
  tickerHandle = null;
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
