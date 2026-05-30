import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { surveys, questions } from '../schema';
import { isValidCode } from '../surveys/codes';
import {
 addSubscriber,
 addUserSubscriber,
 getRoom,
 removeSubscriber,
 removeUserSubscriber
} from './broadcast';
import { checkWsRateLimit } from '../voting/rate-limit';
import { COOKIE_NAME, getSessionUser } from '../auth/sessions';
import { log } from '../log';
import { parseClientIp } from '../net/client-ip';

const wss = new WebSocketServer({ noServer: true });

wss.on(
 'connection',
 async (
   ws: WebSocket,
   _req: IncomingMessage,
   ctx: { code: string; questionIds: string[]; maxWords: number }
 ) => {
   const room = getRoom(ctx.code, ctx.questionIds, ctx.maxWords);
   await addSubscriber(room, ws);

   ws.on('close', () => removeSubscriber(room, ws));
   ws.on('error', () => removeSubscriber(room, ws));
   ws.on('message', (raw) => {
     try {
       const msg = JSON.parse(raw.toString());
       if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
     } catch {
       /* ignore */
     }
   });
 }
);

// Отдельный listener для авторизованного per-user канала: подписка
// на survey-status события для всех опросов одного пользователя.
const wssUser = new WebSocketServer({ noServer: true });
wssUser.on('connection', (ws: WebSocket, _req: IncomingMessage, ctx: { userId: string }) => {
 addUserSubscriber(ctx.userId, ws);
 ws.on('close', () => removeUserSubscriber(ctx.userId, ws));
 ws.on('error', () => removeUserSubscriber(ctx.userId, ws));
 ws.on('message', (raw) => {
   try {
     const msg = JSON.parse(raw.toString());
     if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
   } catch {
     /* ignore */
   }
 });
});

/**
* Парсит сессионное cookie из заголовков `Cookie` upgrade-запроса.
* SvelteKit во время WS handshake не вызывает hooks/+server, поэтому
* идём напрямую через `req.headers` — читаем сами.
*/
function readSessionCookie(req: IncomingMessage): string | null {
 const header = req.headers.cookie;
 if (!header) return null;
 for (const pair of header.split(';')) {
   const eq = pair.indexOf('=');
   if (eq < 0) continue;
   const name = pair.slice(0, eq).trim();
   if (name !== COOKIE_NAME) continue;
   return pair.slice(eq + 1).trim();
 }
 return null;
}

/**
* Безопасное декодирование URL-percent-encoded path: /ws/abc%20def → /ws/abc def.
* Без try/catch падает на одиночном `%` (URIError).
*/
function safeDecode(p: string): string {
 try {
   return decodeURIComponent(p);
 } catch {
   return p;
 }
}

/**
* Постоянное по времени сравнение строк одинаковой длины (ср.
* `auth/access.ts` — те же требования к creatorToken).
*/
function constantTimeEqual(a: string, b: string): boolean {
 if (a.length !== b.length) return false;
 return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
* Реальный IP клиента в WS-upgrade. SvelteKit при handshake не оборачивает
* request, поэтому идём напрямую: `req.headers['x-forwarded-for']` +
* `req.socket.remoteAddress`, отдаём общему парсеру (см. `net/client-ip.ts`).
* Тот доверяет XFF только когда socket-peer входит в TRUSTED_PROXY_CIDRS
* (дефолт — приватные диапазоны), защита от спуфинга снаружи.
*/
function getClientIp(req: IncomingMessage): string {
 return parseClientIp(req.headers['x-forwarded-for'], req.socket.remoteAddress);
}

export async function handleUpgrade(
 req: IncomingMessage,
 socket: Duplex,
 head: Buffer
): Promise<void> {
 const url = new URL(req.url ?? '/', 'http://localhost');
 const path = safeDecode(url.pathname);

 // /ws/u – per-user push для /my. Аутентификация по сессионному cookie,
 // как и REST routes под `requireUser`.
 if (path === '/ws/u') {
   const ip = getClientIp(req);
   const rl = await checkWsRateLimit(ip);
   if (!rl.allowed) {
     log.warn('ws_user_rate_limited', { retryAfterSec: rl.retryAfterSec });
     socket.write(
       `HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${rl.retryAfterSec}\r\n\r\n`
     );
     socket.destroy();
     return;
   }
   const sessionId = readSessionCookie(req);
   const user = await getSessionUser(sessionId);
   if (!user) {
     socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
     socket.destroy();
     return;
   }
   wssUser.handleUpgrade(req, socket, head, (ws) => {
     wssUser.emit('connection', ws, req, { userId: user.id });
   });
   return;
 }

 // Два endpoint'a:
 //   /ws/<code>     — creator-режим, требует ?t=<creatorToken>;
 //   /ws/c/<code>   — публичный read-only для /c/[code], без токена.
 const creatorMatch = path.match(/^\/ws\/([A-Z0-9]+)$/);
 const publicMatch = path.match(/^\/ws\/c\/([A-Z0-9]+)$/);
 const match = creatorMatch ?? publicMatch;
 if (!match) {
   socket.destroy();
   return;
 }
 const isPublic = !!publicMatch;
 const code = match[1];
 if (!isValidCode(code)) {
   socket.destroy();
   return;
 }
 const token = url.searchParams.get('t');
 if (!isPublic && !token) {
   socket.destroy();
   return;
 }

 // Rate-limit ДО запроса в Postgres: дешёвый INCR в Redis, защищает БД
 // от шторма handshake'ов. На публичном endpoint'e лимит особенно важен —
 // там нет токена, любой может пытаться открыть много соединений.
 const ip = getClientIp(req);
 const rl = await checkWsRateLimit(ip);
 if (!rl.allowed) {
   log.warn('ws_rate_limited', { surveyCode: code, retryAfterSec: rl.retryAfterSec });
   socket.write(
     `HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${rl.retryAfterSec}\r\n\r\n`
   );
   socket.destroy();
   return;
 }

 const [survey] = await db.select().from(surveys).where(eq(surveys.code, code)).limit(1);
 if (!survey) {
   socket.destroy();
   return;
 }
 // Креаторский режим — обязательная сверка токена в constant time.
 if (!isPublic && !constantTimeEqual(survey.creatorToken, token!)) {
   socket.destroy();
   return;
 }

 // Терминальные опросы (sent/failed) — короткий апгрейд только для
 // того, чтобы клиент получил 'closed' и обновил UI. На состоянии
 // 'expired' (transient) WS остаётся открытым: дальше processExpired
 // сам создаёт ?: 作是當前的片本的
 if (survey.status === 'sent' || survey.status === 'failed') {
   wss.handleUpgrade(req, socket, head, (ws) => {
     try {
       ws.send(JSON.stringify({ type: 'closed', reason: survey.status }));
     } finally {
       ws.close(1000, survey.status);
     }
   });
   return;
 }

 const qs = await db
   .select({ id: questions.id })
   .from(questions)
   .where(eq(questions.surveyId, survey.id))
   .orderBy(questions.position);

 wss.handleUpgrade(req, socket, head, (ws) => {
   wss.emit('connection', ws, req, {
     code,
     questionIds: qs.map((q) => q.id),
     maxWords: survey.maxWords
   });
 });
}
