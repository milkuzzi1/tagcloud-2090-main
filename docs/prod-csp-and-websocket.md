# Прод-фиксы: CSP `style-src-attr` + WebSocket в adapter-node

Если в браузере на проде ловите такие ошибки:

```
Content-Security-Policy: …заблокировали применение встроенного стиля
(style-src-attr)… 'sha256-tcbDxjMo+xKqM21aCGYbs/QAJqB7yUXC06oPWDapBgc='
Source: display: contents

Firefox не может установить соединение с сервером wss://<домен>/ws/u
NS_ERROR_WEBSOCKET_CONNECTION_REFUSED
```

— это две независимые проблемы, обе чинятся в одном PR.

## Что было сломано

### 1. CSP `style-src-attr`

В `svelte.config.js` стояло `style-src 'self'`, а директивы `style-src-attr`
не было. CSP3 разводит inline-`<style>` и атрибут `style="…"`: для второго
нужен либо `'unsafe-inline'`, либо `'unsafe-hashes' + sha256-…`. SvelteKit
(`csp.mode: 'auto'`) сам атрибут не хеширует, поэтому всё, что попадает в
DOM как `<тег style="…">`, ловит CSP.

В наших страницах таких источников было три:

- `src/app.html`: `<div style="display: contents">%sveltekit.body%</div>`.
- a11y-аnnouncer SvelteKit (`<div aria-live="…" style="position: absolute; …">`),
  который рантайм добавляет в DOM при гидрации.
- Svelte 5 `<svelte-css-wrapper style="display: contents; …">`,
  оборачивающий компоненты со скоупом CSS.
- Наша динамическая палитра в `/new` (`style={…linear-gradient…}`).

### 2. WebSocket не отвечает в проде

`@sveltejs/adapter-node` (`build/index.js`) поднимает `http.Server`, но не
вешает на него listener для события `upgrade`. В dev-режиме это компенсирует
`vite-plugin-ws.ts` (он подписывается на `server.httpServer.on('upgrade', …)`),
а в продакшен-сборке такой обёртки не было. Поэтому `wss://<host>/ws/u`,
`/ws/<code>` и `/ws/c/<code>` молча отбивались (Caddy → Node возвращал 200/404
на `/ws/*`, апгрейд не происходил, клиент видел `CONNECTION_REFUSED`/
`closed before connection`).

## Что меняет правка

- `svelte.config.js` — добавлена директива `'style-src-attr': ['unsafe-inline']`.
- `src/app.html` + `src/app.css` — наш собственный wrapper `<div>` теперь без
  inline-стиля, `display: contents` лежит в классе `.app-shell`.
- `src/hooks.server.ts` — на старте кладёт `handleUpgrade` в
  `globalThis.__tagcloudWsUpgrade`. Импортируется из
  `$lib/server/realtime/ws-server.ts` (тот же модуль, что и в dev).
- `deploy/server.js` (новый) — кастомный Node-entry: импортирует
  `build/index.js` (запуск polka + `Server.init()`), достаёт `httpServer`
  через `polkaServer.server` и вешает `upgrade` listener, который дёргает
  `globalThis.__tagcloudWsUpgrade`.
- `deploy/tagcloud.service` и `deploy/tagcloud@.service` — `ExecStart` теперь
  ссылается на `/opt/tagcloud/deploy/server.js` вместо `build/index.js`.

Никаких изменений в схеме БД, поведение API и REST-эндпоинтов не меняется.

## Применение на сервере

Все шаги — из-под пользователя `tagcloud` там, где касается /opt/tagcloud,
и из-под `root` (через sudo) для systemd.

### 1. Подтянуть код и пересобрать

```bash
cd /opt/tagcloud
sudo -u tagcloud git fetch origin
sudo -u tagcloud git checkout main
sudo -u tagcloud git pull --ff-only

sudo -u tagcloud npm ci
sudo -u tagcloud npm run build
```

После сборки в `/opt/tagcloud/build/` будет обновлённый `handler.js`/`index.js`,
а `/opt/tagcloud/deploy/server.js` — новый entry-point.

### 2. Обновить systemd unit

#### Single-instance (`tagcloud.service`)

```bash
sudo cp /opt/tagcloud/deploy/tagcloud.service /etc/systemd/system/tagcloud.service
sudo systemctl daemon-reload
sudo systemctl restart tagcloud
sudo systemctl status tagcloud
sudo journalctl -u tagcloud -n 100 --no-pager
```

В логах должно быть `Listening on http://0.0.0.0:3000` (или ваш порт),
никаких сообщений вида `__tagcloudWsUpgrade не зарегистрирован` или
`polka.server не определён`.

#### Multi-instance (`tagcloud@.service`)

Если используете 4+ инстанса:

```bash
sudo cp /opt/tagcloud/deploy/tagcloud@.service /etc/systemd/system/tagcloud@.service
sudo systemctl daemon-reload
sudo systemctl restart 'tagcloud@*'
```

### 3. Smoke-test

#### CSP

1. Открыть `https://<ваш-домен>/my` в свежей вкладке (Ctrl+Shift+N в Firefox).
2. Открыть DevTools → Console.
3. Сообщений вида `Content-Security-Policy: …style-src-attr…` быть **не должно**.
4. На странице `/new` выбрать кастомную палитру: градиент должен
   применяться без CSP-ошибок.

#### WebSocket

1. Открыть `https://<ваш-домен>/my` залогиненным пользователем.
   В DevTools → Network → WS должен появиться коннект на `wss://<домен>/ws/u`
   со статусом 101 Switching Protocols.
2. Открыть `/p/<code>` в режиме презентации с активным опросом.
   В Network → WS видно `wss://<домен>/ws/<code>?t=…` со статусом 101.
3. Если в Caddy включено логирование WS — `caddy access` должен показывать
   `Upgrade: websocket` запросы с кодом 101 (а не 400/404).

### 4. Откат

Если что-то пошло не так и нужно откатиться на старый запуск без WS-фикса:

```bash
sudo sed -i 's|/opt/tagcloud/deploy/server.js|/opt/tagcloud/build/index.js|' \
  /etc/systemd/system/tagcloud.service \
  /etc/systemd/system/tagcloud@.service
sudo systemctl daemon-reload
sudo systemctl restart tagcloud           # либо 'tagcloud@*'
```

CSP-фикс отдельно откатывать не нужно — он только расширяет политику,
ничего не ломает.

## Замечания по безопасности

- `style-src-attr 'unsafe-inline'` — слабее, чем `'self'`, но касается
  **только** атрибутов `style="…"`, не `<style>`-блоков и не внешних CSS.
  Реальный риск — XSS-инъекция, которая впихивает `style="…"` в наш HTML;
  но любая XSS у нас уже даёт куда более жёсткий вектор (через `<script>`,
  `javascript:` и т.д.). Менять `style-src-attr` на хеши SvelteKit-аннсера
  не стоит: при апгрейде SvelteKit хеш поменяется, и снова всё ляжет.
- WS-апгрейд по-прежнему проходит через `handleUpgrade`: rate-limit по IP,
  проверка сессии для `/ws/u`, constant-time сверка `creatorToken` для
  `/ws/<code>`. `deploy/server.js` — лишь тонкая прокладка, без своей
  логики аутентификации.
