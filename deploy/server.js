// Production entry для tagcloud (single- и multi-instance деплои).
//
// `@sveltejs/adapter-node` (build/index.js) умеет только обычные HTTP-запросы:
// он создаёт http.Server и навешивает на него `request` listener через polka.
// Событие `upgrade` (HTTP→WebSocket) при этом ловить некому — поэтому
// wss://…/ws/u, wss://…/ws/<code> и wss://…/ws/c/<code> в проде падают с
// `NS_ERROR_WEBSOCKET_CONNECTION_REFUSED`. В dev эту работу делает
// vite-plugin-ws.ts, в проде — этот файл.
//
// Что мы делаем:
//   1. Импортируем `build/index.js`. Это запускает adapter-node: polka
//      создаёт http.Server, инициализирует SvelteKit Server.init() (top-level
//      await в build/handler.js), и начинает listen на $PORT/$HOST.
//   2. Server.init() триггерит загрузку src/hooks.server.ts, который
//      записывает `handleUpgrade` из $lib/server/realtime/ws-server в
//      globalThis.__tagcloudWsUpgrade.
//   3. Через `polkaServer.server` достаём сам http.Server и навешиваем
//      обработчик `upgrade`, который делегирует апгрейд в наш
//      handleUpgrade — там аутентификация по сессии, rate-limit, проверки
//      кода опроса/токена и т.д.
//
// Важные нюансы:
//   - polka.listen() вызван внутри build/index.js синхронно после
//     `httpServer = http.createServer()`, но navigation `.on('upgrade')` мы
//     можем повесить и потом — Node.js принимает listener'ы в любой момент
//     до того, как событие случится. На практике WS-handshake требует
//     несколько RTT, в течение которых наш listener уже стоит.
//   - Если по каким-то причинам globalThis.__tagcloudWsUpgrade не выставлен
//     (например, hooks.server.ts ещё не догрузился), отвечаем 503 и
//     закрываем сокет — клиент уйдёт в обычный backoff и попробует ещё раз.
//
// Запускается через systemd:
//   ExecStart=/usr/bin/node /opt/tagcloud/deploy/server.js
// (см. deploy/tagcloud.service / deploy/tagcloud@.service).

import { server as polkaServer } from '../build/index.js';

const httpServer = polkaServer.server;

if (!httpServer) {
  // Защита от изменения внутренней структуры polka в будущих версиях
  // adapter-node — лучше упасть громко на старте, чем тихо ломать WS.
  console.error('[tagcloud] polka.server не определён — апгрейд WS не будет работать');
  process.exit(1);
}

httpServer.on('upgrade', async (req, socket, head) => {
  if (!req.url || !req.url.startsWith('/ws/')) {
    // Любой не-/ws/ апгрейд (например, кто-то сканирует) — закрываем.
    socket.destroy();
    return;
  }

  const handle = /** @type {((req: any, socket: any, head: any) => Promise<void>) | undefined} */ (
    /** @type {any} */ (globalThis).__tagcloudWsUpgrade
  );

  if (typeof handle !== 'function') {
    console.error(
      '[tagcloud] __tagcloudWsUpgrade не зарегистрирован — hooks.server.ts не загрузился?'
    );
    try {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    } catch {
      /* socket already closed */
    }
    socket.destroy();
    return;
  }

  try {
    await handle(req, socket, head);
  } catch (err) {
    console.error('[tagcloud] ws upgrade failed:', err);
    socket.destroy();
  }
});
