import type { Handle, HandleServerError } from '@sveltejs/kit';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { dev } from '$app/environment';
import { startExpiryCron } from '$lib/server/expiry/cron';
import { COOKIE_NAME, getSessionUser } from '$lib/server/auth/sessions';
import { flushPending, pendingCount } from '$lib/server/voting/submit';
import { handleUpgrade } from '$lib/server/realtime/ws-server';
import { closeRenderPool } from '$lib/server/cloud/render-png';
import { closeDb } from '$lib/server/db';
import { disconnectRedis } from '$lib/server/redis';
import { log, withLogContext, genRequestId } from '$lib/server/log';
import { observeHttpRequest } from '$lib/server/metrics';
import { getClientIpFromKitEvent } from '$lib/server/net/client-ip';

// Production-режим (adapter-node) сам по себе не вешает HTTP `upgrade`
// listener — он обрабатывает только обычные запросы. Чтобы wss://…/ws/*
// работал в проде, кладём `handleUpgrade` в globalThis: deploy/server.js
// (кастомный Node-entry) подбирает функцию отсюда и регистрирует её на
// httpServer.on('upgrade', …). В dev этот же путь идёт через
// vite-plugin-ws.ts, и глобал просто остаётся неиспользуемым.
type WsUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => Promise<void>;
const wsGlobal = globalThis as unknown as { __tagcloudWsUpgrade?: WsUpgrade };
wsGlobal.__tagcloudWsUpgrade = handleUpgrade;

const STARTED_FLAG = '__tagcloud_server_started';
const g = globalThis as unknown as Record<string, boolean>;

if (!g[STARTED_FLAG]) {
  g[STARTED_FLAG] = true;
  startExpiryCron();

  // Graceful shutdown: дренируем in-memory очередь голосов и закрываем пулы
  // (worker-threads, Postgres, Redis) перед завершением — чтобы не оставлять
  // висящие коннекты/потоки при остановке контейнера/сервиса.
  const shutdown = (signal: string) => {
    log.info('shutdown signal received', { signal, pending: pendingCount() });
    flushPending()
      .then(() => Promise.allSettled([closeRenderPool(), closeDb(), disconnectRedis()]))
      .catch((err) => log.error('shutdown cleanup failed', { err: String(err) }))
      .finally(() => process.exit(0));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

export const handle: Handle = async ({ event, resolve }) => {
  // Каждый запрос получает свой requestId. Если фронт прислал X-Request-Id —
  // переиспользуем (помогает корреляции между upstream/downstream).
  const incoming = event.request.headers.get('x-request-id');
  const requestId = incoming && /^[a-zA-Z0-9_-]{1,128}$/.test(incoming) ? incoming : genRequestId();

  const start = performance.now();
  const sid = event.cookies.get(COOKIE_NAME);
  event.locals.user = await getSessionUser(sid);
  // Реальный IP клиента: XFF доверяем только когда socket-peer входит в
  // TRUSTED_PROXY_CIDRS (дефолт — приватные диапазоны, см. client-ip.ts).
  // Все downstream обработчики (rate-limit, аудит) читают отсюда вместо
  // вызова event.getClientAddress() напрямую.
  event.locals.clientIp = getClientIpFromKitEvent(event);

  return withLogContext(
    {
      requestId,
      userId: event.locals.user?.id,
      method: event.request.method,
      route: event.route.id ?? event.url.pathname
    },
    async () => {
      const response = await resolve(event);
      response.headers.set('x-request-id', requestId);
      // Security-заголовки на уровне приложения (а не только в Caddy): если
      // деплой идёт без обратного прокси или с другим, защита не теряется.
      // CSP проставляет SvelteKit (svelte.config.js). frame-ancestors 'none'
      // в CSP уже покрывает clickjacking, X-Frame-Options — для старых браузеров.
      response.headers.set('X-Content-Type-Options', 'nosniff');
      response.headers.set('X-Frame-Options', 'DENY');
      response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
      response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
      if (!dev) {
        response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      }
      // Запрещаем кешировать любые ответы JSON-API: они персонализированы
      // (cookie/session/IP), и попадание в shared-cache (proxy, CDN, edge)
      // может вернуть чужие данные. Не трогаем GET .csv (там уже выставлен
      // no-store вручную) и SSR-страницы — там SvelteKit сам управляет.
      if (event.url.pathname.startsWith('/api/')) {
        if (!response.headers.has('Cache-Control')) {
          response.headers.set('Cache-Control', 'no-store');
        }
      }
      const duration = performance.now() - start;
      // Не зашумляем лог запросами health-проб — их Caddy дёргает раз в секунду.
      if (event.url.pathname !== '/healthz' && event.url.pathname !== '/readyz') {
        log.info('http_request', { status: response.status, durationMs: Math.round(duration) });
      }
      observeHttpRequest({
        method: event.request.method,
        route: event.route.id ?? 'unmatched',
        status: response.status,
        durationSec: duration / 1000
      });
      return response;
    }
  );
};

/**
 * Глобальный обработчик ошибок: SvelteKit зовёт его при любом необработанном
 * исключении в load/+server-руте. Мы:
 *  - логируем стек со структурой через наш JSON-логгер (контекст requestId
 *    уже взят из AsyncLocalStorage, см. handle выше);
 *  - выдаём клиенту безопасное сообщение + errorId, чтобы пользователь
 *    мог процитировать его в баг-репорте, а мы — найти запись в логах.
 */
export const handleError: HandleServerError = ({ error, event, status, message }) => {
  const errorId = genRequestId();
  log.error('unhandled_exception', {
    errorId,
    status,
    message,
    method: event.request.method,
    route: event.route.id ?? event.url.pathname,
    err: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  });
  return {
    message: 'Внутренняя ошибка сервера',
    errorId
  };
};
