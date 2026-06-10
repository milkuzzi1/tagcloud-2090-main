# Tagcloud 2090

Интерактивные опросы с визуализацией ответов в виде **облака слов**. Создатель
делает опрос, участники сканируют QR / открывают короткую ссылку и присылают
слова, а облако обновляется в реальном времени. По завершении опроса создателю
уходит письмо с PNG-облаками и CSV-выгрузкой.

- **Стек:** SvelteKit 5 (runes) + TypeScript, Node (`adapter-node`), PostgreSQL +
  Drizzle ORM, Redis (ioredis), WebSocket (`ws`), рендер облака — `d3-cloud` +
  `canvas` в пуле worker-потоков (`piscina`), почта — SMTP (`nodemailer`).
- **Цель развёртывания:** один сервер с постоянным публичным IP, домен
  `2090.fun` (лендинг) и `cloud.2090.fun` (приложение), TLS от Let's Encrypt
  через Caddy.

---

## Содержание

- [Возможности](#возможности)
- [Локальная разработка](#локальная-разработка)
- [Переменные окружения](#переменные-окружения)
- [Развёртывание на статическом сервере](#развёртывание-на-статическом-сервере-2090fun)
- [Эксплуатация](#эксплуатация)
- [Почта (SMTP)](#почта-smtp)
- [Качество и тесты](#качество-и-тесты)
- [Структура репозитория](#структура-репозитория)

---

## Возможности

- Создание опросов с несколькими вопросами (одно слово / несколько слов),
  настройкой палитры облака, вертикальных слов и срока жизни.
- Голосование без регистрации: антифрод через дедуп по IP (Redis `SET NX` с
  посолённым хэшем на опрос) и rate-limit.
- Живое облако через WebSocket; режимы дашборда, презентации и «чистого» облака.
- Аккаунты создателей с подтверждением email, сбросом пароля и единым
  администратором (передача прав — handover).
- Экспорт CSV (с защитой от formula-injection) и письмо с итогами по истечении.
- Метрики Prometheus (`/metrics`), health-пробы (`/healthz`, `/readyz`).

---

## Локальная разработка

Нужны Node 22+ и Docker (для Postgres и Redis).

```bash
# 1. Зависимости
npm install

# 2. Локальный конфиг
cp .env.example .env
#   Заполните SMTP_* (или поднимите MailHog — см. ниже). Пароли Postgres/Redis
#   в .env должны совпадать с docker-compose (compose не стартует без них).

# 3. Postgres + Redis в контейнерах
npm run db:up

# 4. Миграции (готовые SQL уже в drizzle/, генерировать не нужно)
npm run db:migrate

# 5. Dev-сервер (Vite, WebSocket работает через vite-plugin-ws.ts)
npm run dev
```

Приложение поднимется на `http://localhost:5173`.

**Первый администратор** создаётся CLI-скриптом (нужен токен из
`ADMIN_CREATION_TOKEN_EXPECTED`):

```bash
ADMIN_CREATION_TOKEN="<тот же токен>" DATABASE_URL="postgres://..." \
  npx tsx scripts/create-admin.ts --email admin@example.com --baseUrl http://localhost:5173
```

**Почта в dev (MailHog):**

```bash
docker run -d -p 1025:1025 -p 8025:8025 mailhog/mailhog
# в .env: SMTP_HOST=127.0.0.1  SMTP_PORT=1025  SMTP_SECURE=false  (SMTP_USER/PASSWORD пустые)
```

> `npm run db:generate` запускайте **только** если меняете схему в
> `src/lib/server/schema.ts`. На свежем чек-ауте он создаст дубликат миграции,
> конфликтующий с baseline.

---

## Переменные окружения

Полный список с пояснениями — в `deploy/tagcloud.env.example` (прод) и
`.env.example` (локально). Ключевые:

| Переменная | Назначение |
|---|---|
| `DATABASE_URL` | строка подключения Postgres |
| `REDIS_URL` | строка подключения Redis |
| `ORIGIN` / `PUBLIC_BASE_URL` | публичный адрес; из него строятся ссылки в письмах. В проде **обязателен** (иначе приложение падает на старте) |
| `SMTP_HOST/PORT/SECURE/USER/PASSWORD/FROM` | отправка писем |
| `METRICS_TOKEN` | Bearer-токен для `/metrics`; пусто → endpoint fail-closed (404) |
| `TRUSTED_PROXY_CIDRS` | дополнительные доверенные прокси-сети для разбора `X-Forwarded-For` (дополняет дефолтные приватные диапазоны) |
| `AUTH_DISABLE_EMAIL_VERIFICATION` | временный kill-switch подтверждения email (см. предупреждение в env-файле) |
| `VOTE_DURABLE_WRITES` | `true` — подтверждать голос только после записи в БД (медленнее, но без потери при жёстком падении) |

---

## Развёртывание на статическом сервере (`2090.fun`)

Целевая конфигурация — **чистый сервер с постоянным публичным IP**:
Ubuntu 22.04+/Debian 12+, root-доступ, открытые порты 80/443, DNS-записи
`2090.fun`, `www.2090.fun`, `cloud.2090.fun` → IP сервера.

Все шаблоны лежат в `deploy/`. Приложение разворачивается в `/opt/tagcloud`,
работает под пользователем `tagcloud`, проксируется Caddy (TLS Let's Encrypt
по HTTP-01).

### 1. Системные пакеты

```bash
apt update
apt install -y postgresql redis-server caddy restic git build-essential
# Системные библиотеки для canvas (рендер PNG-облаков):
apt install -y --no-install-recommends \
  libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev pkg-config
# Node 22 (NodeSource):
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
systemctl enable --now postgresql redis-server
```

### 2. Пользователь и каталоги

```bash
id tagcloud >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin tagcloud
install -d -m 755 -o tagcloud -g tagcloud /opt/tagcloud /var/log/tagcloud
install -d -m 750 -o root -g root /etc/tagcloud
```

### 3. База данных

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE tagcloud LOGIN PASSWORD 'CHANGE_ME_DB_PASS';
CREATE DATABASE tagcloud OWNER tagcloud;
SQL
```

> Пароль должен быть URL-safe (`A-Z a-z 0-9 . _ -`) — он попадёт в `DATABASE_URL`.

### 4. Код, зависимости, сборка

```bash
cd /opt/tagcloud
sudo -u tagcloud git clone https://github.com/milkuzzi1/tagcloud-2090-main.git .
sudo -u tagcloud npm ci
sudo -u tagcloud npm run build
```

### 5. Конфиг рантайма

```bash
install -m 600 -o tagcloud -g tagcloud deploy/tagcloud.env.example /etc/tagcloud/tagcloud.env
$EDITOR /etc/tagcloud/tagcloud.env
#   DATABASE_URL=postgres://tagcloud:<пароль>@127.0.0.1:5432/tagcloud
#   REDIS_URL=redis://127.0.0.1:6379/0
#   ORIGIN / PUBLIC_BASE_URL = https://cloud.2090.fun
#   SMTP_* (см. раздел «Почта»)
#   METRICS_TOKEN=$(openssl rand -hex 32)
```

### 6. Миграции

```bash
sudo -u tagcloud bash -lc 'set -a; . /etc/tagcloud/tagcloud.env; set +a; cd /opt/tagcloud && npm run db:migrate'
```

### 7. systemd-сервис

`deploy/server.js` — кастомный entry поверх `build/index.js`: он навешивает
обработчик HTTP-`upgrade`, без которого WebSocket в проде не работает
(`adapter-node` сам это не делает). `ExecStart` в unit уже указывает на него.

```bash
cp deploy/tagcloud.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now tagcloud
# проверка:
curl -fsS http://127.0.0.1:3000/healthz && echo
curl -fsS http://127.0.0.1:3000/readyz  && echo
journalctl -u tagcloud -n 50 --no-pager
```

### 8. Caddy (reverse-proxy + TLS)

```bash
cp deploy/Caddyfile.example /etc/caddy/Caddyfile
#   при необходимости поменяйте e-mail для ACME (admin@2090.fun)
systemctl reload caddy
```

Caddy сам выпустит сертификаты при первом обращении к доменам. Лендинг
раздаётся из `/opt/tagcloud/landing`, приложение — на `cloud.2090.fun`.

Проверка снаружи:

```bash
curl -fsS -I https://cloud.2090.fun/healthz | head -n 3
```

### 9. Бэкапы (опционально, но рекомендуется)

```bash
install -m 600 -o tagcloud -g tagcloud deploy/backup.env.example /etc/tagcloud/backup.env
$EDITOR /etc/tagcloud/backup.env          # restic-репозиторий + пароль шифрования
cp deploy/tagcloud-backup.service deploy/tagcloud-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now tagcloud-backup.timer
# первый прогон вручную:
sudo -u tagcloud bash -c 'set -a; . /etc/tagcloud/backup.env; set +a; /opt/tagcloud/scripts/ops/backup.sh'
```

---

## Эксплуатация

**Обновление:**

```bash
cd /opt/tagcloud
sudo -u tagcloud git pull --ff-only
sudo -u tagcloud npm ci
sudo -u tagcloud npm run build
sudo -u tagcloud bash -lc 'set -a; . /etc/tagcloud/tagcloud.env; set +a; npm run db:migrate'
systemctl restart tagcloud
```

`hooks.server.ts` обрабатывает SIGTERM: дренирует in-memory очередь голосов и
закрывает пулы (Postgres, Redis, worker-потоки). systemd ждёт до 30с.

**Логи и статус:** `journalctl -u tagcloud -f`, `systemctl status tagcloud caddy`.

**Метрики:** `/metrics` (Prometheus) закрыт `METRICS_TOKEN` и дополнительно
отдаёт 403 на уровне Caddy. Запрос: `curl -H "Authorization: Bearer $TOKEN" https://cloud.2090.fun/metrics`.

**Smoke-test WebSocket после деплоя:** открыть `https://cloud.2090.fun/my`
залогиненным — в DevTools → Network → WS должен быть коннект `wss://…/ws/u`
со статусом `101 Switching Protocols`. Для активного опроса — `wss://…/ws/<code>`.
Если в логах `tagcloud` есть `__tagcloudWsUpgrade не зарегистрирован` —
`ExecStart` указывает не на `deploy/server.js`.

---

## Почта (SMTP)

Письма (подтверждение email, итоги опросов) уходят через внешний SMTP —
например **SendPulse**. Своего почтового сервера поднимать не нужно.

1. Зарегистрироваться на провайдере и включить SMTP, верифицировать домен
   отправителя (SPF/DKIM).
2. Взять SMTP-логин и пароль.
3. В `/etc/tagcloud/tagcloud.env`:

   ```
   SMTP_HOST=smtp-pulse.com
   SMTP_PORT=587            # 2525 если 587 закрыт; 465 + SMTP_SECURE=true для implicit TLS
   SMTP_SECURE=false
   SMTP_USER=<логин>
   SMTP_PASSWORD=<пароль>
   SMTP_FROM="Tagcloud <noreply@2090.fun>"
   ```

4. `systemctl restart tagcloud`.

Если SMTP временно недоступен — есть аварийный флаг
`AUTH_DISABLE_EMAIL_VERIFICATION=true` (регистрация без письма). Снимать сразу
после восстановления почты — см. предупреждение в `deploy/tagcloud.env.example`.

---

## Качество и тесты

```bash
npm run check    # svelte-check (типы)
npm run lint     # eslint + prettier --check
npm run test     # vitest
npm run build    # прод-сборка SvelteKit
```

CI (`.github/workflows/ci.yml`) гоняет всё это на каждый PR. Перед коммитом
форматирование можно поправить через `npm run format`.

---

## Структура репозитория

```
src/
  hooks.server.ts            # request-pipeline, clientIp, security-заголовки, graceful shutdown
  lib/server/
    auth/                    # сессии, пароли, верификация, инвайты, передача админки
    voting/                  # валидация, дедуп, rate-limit, буфер голосов
    realtime/                # WebSocket-сервер и broadcast
    cloud/                   # агрегация и рендер PNG (piscina-воркеры)
    expiry/                  # cron истечения опросов + рассылка итогов
    email/, export/, net/    # письма, CSV, разбор X-Forwarded-For
    schema.ts                # Drizzle-схема (источник истины)
  routes/                    # страницы и API (+server.ts)
workers/render-worker.mjs    # worker для d3-cloud + canvas
drizzle/                     # SQL-миграции (применяются scripts/migrate.ts)
deploy/                      # Caddyfile, systemd-юниты, server.js, env-шаблоны, бэкап
landing/                     # статический лендинг 2090.fun
scripts/                     # create-admin, migrate, seed, ops/backup.sh
```
