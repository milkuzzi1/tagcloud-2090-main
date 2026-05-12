# Деплой tagcloud на сервер со статическим IP `193.233.246.98` (домен `2090.dedyn.io`)

Этот гайд — конкретизация `deploy/README.md` под единственную целевую
машину: VPS с **постоянным публичным IP `193.233.246.98`** и доменом
**`2090.dedyn.io`**, размещённым в бесплатной DNS-зоне
[deSEC](https://desec.io) (`dedyn.io`).

Поскольку IP статический, никакого DDNS/Cloudflare Tunnel не нужно —
Caddy выпускает TLS по обычному HTTP-01 challenge. От `deploy/README.md`
этот документ отличается только конкретными значениями и описанием
A/AAAA-записей в deSEC.

> Если в будущем IP станет динамическим, переключитесь на
> `deploy/dynamic-ip.md` — там расписаны DDNS на deSEC и DNS-01 challenge.

## Содержание

- [0. Предварительные требования](#0-предварительные-требования)
- [1. DNS в deSEC: A-запись `2090.dedyn.io → 193.233.246.98`](#1-dns-в-desec-a-запись-2090dedynio--19323324698)
- [2. Системные пакеты и пользователь](#2-системные-пакеты-и-пользователь)
- [3. Postgres и Redis](#3-postgres-и-redis)
- [4. Сборка приложения](#4-сборка-приложения)
- [5. Конфиги `/etc/tagcloud/*.env`](#5-конфиги-etctagcloudenv)
- [6. systemd: `tagcloud.service`](#6-systemd-tagcloudservice)
- [7. Caddy: reverse-proxy + TLS Let's Encrypt](#7-caddy-reverse-proxy--tls-lets-encrypt)
- [8. Firewall (ufw)](#8-firewall-ufw)
- [9. Почта (Sender.net SMTP)](#9-почта-sendernet-smtp)
- [10. Бэкапы](#10-бэкапы)
- [11. Финальные проверки](#11-финальные-проверки)
- [12. Обновление приложения](#12-обновление-приложения)
- [Траблшутинг](#траблшутинг)

## 0. Предварительные требования

- Ubuntu 22.04+ или Debian 12+ на сервере `193.233.246.98`.
- root (или `sudo`) доступ.
- Учётка в [desec.io](https://desec.io) с подтверждённой зоной
  `2090.dedyn.io` (она создаётся автоматически при регистрации
  поддомена в `dedyn.io`).
- Открытые наружу порты `80/tcp` и `443/tcp` (если перед сервером есть
  внешний firewall у хостера — разрешить, иначе HTTP-01 challenge не
  пройдёт и сертификат не выпустится).
- Желательно: PTR-запись на `193.233.246.98 → 2090.dedyn.io` через
  поддержку хостера (для лучшей доставляемости почты, не критично).

## 1. DNS в deSEC: A-запись `2090.dedyn.io → 193.233.246.98`

deSEC раздаёт зоны под `dedyn.io` бесплатно. Управление — через веб-UI
[desec.io/domains](https://desec.io/domains) или REST API.

### Через веб-UI

1. Войти в [desec.io](https://desec.io), открыть зону `2090.dedyn.io`.
2. Добавить запись:
   - **Type:** `A`
   - **Subname:** оставить пустым (apex)
   - **TTL:** `3600`
   - **Records:** `193.233.246.98`
3. Сохранить.

Если используете и IPv6 — добавьте `AAAA` с адресом IPv6 сервера.

### Через REST API (опционально, удобно при автоматизации)

```bash
# Токен берётся в desec.io → Token Management → Create new token.
DESEC_TOKEN='<ваш токен>'

curl -fsS -X POST \
  -H "Authorization: Token ${DESEC_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"subname":"","type":"A","ttl":3600,"records":["193.233.246.98"]}' \
  https://desec.io/api/v1/domains/2090.dedyn.io/rrsets/
```

### Проверка

```bash
dig +short A 2090.dedyn.io @ns1.desec.io
# Ожидаем: 193.233.246.98
dig +short A 2090.dedyn.io
# Через 1–5 минут публичные резолверы тоже отдают 193.233.246.98.
```

Пока `dig` не вернёт правильный IP, переходить к шагу 7 (Caddy + TLS)
смысла нет — Let's Encrypt не пройдёт HTTP-01 challenge.

## 2. Системные пакеты и пользователь

Все команды ниже — от root (или с `sudo`). Если вы залогинены не как
root — добавляйте `sudo` к каждой команде.

```bash
apt update
apt install -y postgresql redis-server caddy restic curl jq

# Node 22 через NodeSource (можно и nvm — на ваш вкус):
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# canvas@3 при первом npm ci пересобирает нативные модули, если prebuild
# не подойдёт. Чтобы fallback работал — поставим dev-пакеты cairo/pango.
apt install -y --no-install-recommends \
  libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev pkg-config

# Сервисный пользователь и каталоги.
useradd -r -s /usr/sbin/nologin tagcloud
mkdir -p /opt/tagcloud /etc/tagcloud /var/log/tagcloud
chown -R tagcloud:tagcloud /opt/tagcloud /var/log/tagcloud
chmod 750 /etc/tagcloud
```

## 3. Postgres и Redis

```bash
# Postgres: создать роль и БД.
sudo -u postgres psql <<SQL
CREATE USER tagcloud WITH PASSWORD 'CHANGE_ME_DB_PASSWORD';
CREATE DATABASE tagcloud OWNER tagcloud;
SQL

# Постгрес слушает loopback по умолчанию — наружу не выставлять.
systemctl enable --now postgresql

# Redis тоже на loopback. Дефолтный конфиг подходит, проверим:
ss -tlnp | grep -E ':5432|:6379'
# Должно быть LISTEN на 127.0.0.1:5432 и 127.0.0.1:6379, без 0.0.0.0.

systemctl enable --now redis-server
```

> Если Postgres/Redis у вас на отдельной машине внутри частной сети —
> заменяйте `localhost` в `DATABASE_URL`/`REDIS_URL` на её IP, но
> наружу `5432/6379` всё равно не открывайте.

## 4. Сборка приложения

```bash
cd /opt/tagcloud
sudo -u tagcloud git clone https://github.com/milkuzzi/tagcloud-2090-main .
sudo -u tagcloud npm ci
sudo -u tagcloud npm run build

# Применение миграций. DATABASE_URL подставьте свой (с паролем из шага 3).
sudo -u tagcloud DATABASE_URL='postgres://tagcloud:CHANGE_ME_DB_PASSWORD@localhost:5432/tagcloud' \
  npm run db:migrate
```

После сборки в `/opt/tagcloud/build/` появится скомпилированный SvelteKit-
бандл (`adapter-node`), его и запускает systemd на следующем шаге.

## 5. Конфиги `/etc/tagcloud/*.env`

```bash
cp /opt/tagcloud/deploy/tagcloud.env.example /etc/tagcloud/tagcloud.env
cp /opt/tagcloud/deploy/backup.env.example   /etc/tagcloud/backup.env
chmod 600 /etc/tagcloud/*.env
chown tagcloud:tagcloud /etc/tagcloud/*.env
```

Откройте `/etc/tagcloud/tagcloud.env` и подставьте значения под этот
сервер. Минимум, что должно отличаться от шаблона:

```ini
DATABASE_URL=postgres://tagcloud:CHANGE_ME_DB_PASSWORD@localhost:5432/tagcloud
REDIS_URL=redis://localhost:6379/0

# Публичный URL. Caddy на шаге 7 завершает TLS, поэтому схема https://.
ORIGIN=https://2090.dedyn.io

# Caddy слушает 80/443 наружу и проксирует на этот HOST:PORT.
HOST=127.0.0.1
PORT=3000

# X-Forwarded-* приходят от Caddy на loopback — один хоп.
ADDRESS_HEADER=X-Forwarded-For
PROTOCOL_HEADER=X-Forwarded-Proto
XFF_DEPTH=1

# SMTP — см. шаг 9. До настройки писем можно оставить заглушку,
# приложение поднимется, но регистрации/итоги опросов будут падать.
SMTP_HOST=smtp.sender.net
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=CHANGE_ME_SMTP_USER
SMTP_PASSWORD=CHANGE_ME_SMTP_PASSWORD
SMTP_FROM="Tagcloud <noreply@yourdomain.tld>"

# Опционально: токен на /metrics. Сгенерировать `openssl rand -hex 32`.
METRICS_TOKEN=
```

Остальные параметры (`PG_POOL_MAX`, `UV_THREADPOOL_SIZE`, `LOG_LEVEL`)
по умолчанию подходят для одиночного инстанса; правьте только если
профилирование показало, что они узкое место.

## 6. systemd: `tagcloud.service`

```bash
cp /opt/tagcloud/deploy/tagcloud.service /etc/systemd/system/tagcloud.service
systemctl daemon-reload
systemctl enable --now tagcloud
```

Проверка:

```bash
systemctl status tagcloud
journalctl -u tagcloud -n 50 --no-pager
curl -fsS http://127.0.0.1:3000/healthz   # ожидаем "ok"
curl -fsS http://127.0.0.1:3000/readyz    # ожидаем {"ok":true,...}
```

Если `/readyz` возвращает не-OK — смотрите `journalctl -u tagcloud -f`,
скорее всего нет коннекта к Postgres/Redis (см. шаг 3).

## 7. Caddy: reverse-proxy + TLS Let's Encrypt

Положите Caddyfile, заменив `yourdomain.tld` на `2090.dedyn.io`:

```bash
cp /opt/tagcloud/deploy/Caddyfile.example /etc/caddy/Caddyfile
sed -i 's/yourdomain.tld/2090.dedyn.io/g' /etc/caddy/Caddyfile
```

В блоке `email admin@2090.dedyn.io` подставьте реальный почтовый адрес
администратора (Let's Encrypt шлёт сюда уведомления об истекающих
сертификатах). Можно оставить `admin@2090.dedyn.io`, если такой ящик
существует, иначе — любой другой ваш реальный адрес.

Перезагрузите Caddy:

```bash
systemctl enable --now caddy
systemctl reload caddy
journalctl -u caddy -n 100 -f
```

В логе ищем строки `obtain certificate` и `certificate obtained
successfully` — Caddy подтянул A-запись `2090.dedyn.io → 193.233.246.98`,
прошёл HTTP-01 challenge на `:80` и получил сертификат от Let's Encrypt.

Внешняя проверка:

```bash
curl -I https://2090.dedyn.io
# HTTP/2 200, заголовки от Node-приложения; в TLS-цепочке Let's Encrypt.

curl -I http://2090.dedyn.io
# HTTP/2 308 (Caddy редиректит http → https).
```

## 8. Firewall (ufw)

```bash
apt-get install -y ufw
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh           # 22/tcp — иначе можно потерять доступ
ufw allow 80/tcp        # http → https redirect
ufw allow 443/tcp       # основной трафик
# Postgres/Redis — только loopback, наружу не открываем!
# SMTP не открываем — приложение само ходит исходящим к smtp.sender.net:587.
ufw enable
ufw status verbose
```

## 9. Почта (Sender.net SMTP)

Все письма (verification, итоги опросов) уходят через `smtp.sender.net:587`
по SMTP-credentials. Никаких локальных Postfix/OpenDKIM поднимать не нужно.

Краткий путь:

1. Зарегистрироваться на https://www.sender.net и активировать
   Transactional emails.
2. Добавить и верифицировать домен отправителя.
3. Создать SMTP-пользователя: Transactional emails → Setup instructions
   → SMTP → Add SMTP user.
4. В `/etc/tagcloud/tagcloud.env` заменить значения `SMTP_USER`,
   `SMTP_PASSWORD`, `SMTP_FROM` на реальные.
5. `systemctl restart tagcloud`.

Подробности (SPF/DKIM/DMARC, лимиты) — `deploy/mail-server.md`.

Проверка, что письма реально уходят:

```bash
nc -vz smtp.sender.net 587
# Connection ... succeeded! — порт открыт у хостера.

# Триггерим письмо: регистрация нового пользователя через UI на
# https://2090.dedyn.io. Дальше смотрим лог:
journalctl -u tagcloud -n 100 | grep -iE 'smtp|mail|verification'
# Не должно быть EAUTH/535 — это значит SMTP-credentials неверные.
```

## 10. Бэкапы

```bash
cp /opt/tagcloud/deploy/tagcloud-backup.service /etc/systemd/system/
cp /opt/tagcloud/deploy/tagcloud-backup.timer   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now tagcloud-backup.timer
```

В `/etc/tagcloud/backup.env` подставьте реальные значения
`RESTIC_REPOSITORY`/`RESTIC_PASSWORD` (Backblaze B2 или Cloudflare R2 —
оба дают 10 GB free, см. комментарии в файле).

Первый прогон вручную, чтобы убедиться, что репозиторий доступен:

```bash
sudo -u tagcloud bash -c 'set -a; source /etc/tagcloud/backup.env; set +a; \
  /opt/tagcloud/scripts/ops/backup.sh'
restic -r "$RESTIC_REPOSITORY" snapshots
# Должна появиться первая запись.
```

Таймер запускает бэкап каждые сутки в 03:30 UTC.

## 11. Финальные проверки

```bash
# 1. DNS указывает на правильный IP
dig +short A 2090.dedyn.io
# 193.233.246.98

# 2. TLS-сертификат валиден и от Let's Encrypt
echo | openssl s_client -servername 2090.dedyn.io -connect 2090.dedyn.io:443 2>/dev/null \
  | openssl x509 -noout -issuer -subject -dates

# 3. Приложение отвечает по HTTPS
curl -sI https://2090.dedyn.io | head -1                # HTTP/2 200
curl -sf https://2090.dedyn.io/healthz                  # ok
curl -sf https://2090.dedyn.io/readyz | jq .            # {"ok":true,...}

# 4. Сервисы стоят на ногах
systemctl is-active tagcloud caddy postgresql redis-server
# active active active active

# 5. Бэкап-таймер активен
systemctl list-timers --all | grep tagcloud-backup
```

Всё зелёное — деплой готов.

## 12. Обновление приложения

```bash
cd /opt/tagcloud
sudo -u tagcloud git pull
sudo -u tagcloud npm ci
sudo -u tagcloud npm run build
sudo -u tagcloud DATABASE_URL='postgres://tagcloud:...@localhost:5432/tagcloud' \
  npm run db:migrate
systemctl restart tagcloud
```

`hooks.server.ts` ловит SIGTERM, флашит in-memory очередь голосов и
закрывает WS-комнаты. systemd ждёт до 30 секунд (`TimeoutStopSec=30`),
после чего шлёт SIGKILL — времени более чем достаточно.

## Траблшутинг

| Симптом | Что проверить |
|---|---|
| `curl https://2090.dedyn.io` → `Could not resolve host` | DNS ещё не обновился. `dig +short A 2090.dedyn.io @ns1.desec.io` должен вернуть `193.233.246.98`; публичные резолверы догоняют за 1–5 мин. |
| Caddy: `obtain certificate failed: HTTP-01 challenge failed` | Снаружи закрыт `80/tcp` (firewall у хостера, ufw на сервере, либо A-запись ещё не в DNS). Проверить `nc -vz 193.233.246.98 80` с другой машины. |
| `curl http://127.0.0.1:3000/readyz` → `{"ok":false,...}` | Нет коннекта к Postgres или Redis. Сверить `DATABASE_URL`/`REDIS_URL` в `/etc/tagcloud/tagcloud.env`, проверить `pg_isready -h 127.0.0.1` и `redis-cli ping`. |
| `journalctl -u tagcloud` пишет `EAUTH` / `535` | Неверные SMTP-credentials. См. `deploy/mail-server.md`. |
| После `git pull` приложение не стартует | Скорее всего не применили миграцию. `npm run db:migrate` и `systemctl restart tagcloud`. |
| Хочется завести `www.2090.dedyn.io` | Добавить ещё одну A-запись в deSEC и в Caddyfile прописать `2090.dedyn.io, www.2090.dedyn.io { … }`. Caddy выпустит общий сертификат на оба имени. |
| Нужен IPv6 | В deSEC завести `AAAA`-запись с IPv6-адресом сервера, в `ufw allow 80,443/tcp` ничего менять не нужно (правила одинаковы для обоих стеков). |

Если проблема не закрывается — соберите логи в одну папку и приложите к
ишью:

```bash
journalctl -u tagcloud  -n 500 --no-pager > /tmp/tagcloud.log
journalctl -u caddy     -n 500 --no-pager > /tmp/caddy.log
journalctl -u postgresql -n 200 --no-pager > /tmp/postgres.log
```
