# Деплой tagcloud

Все файлы в этой папке — **шаблоны**. Перед использованием замените
`yourdomain.tld`, `CHANGE_ME` и пути на реальные.

## Состав

| Файл | Назначение |
|---|---|
| `Caddyfile.example` | Reverse-proxy + автоматический TLS Let's Encrypt + security-заголовки. |
| `tagcloud.service` | systemd unit для Node-процесса с graceful shutdown и hardening. |
| `tagcloud.env.example` | Все переменные окружения рантайма (DATABASE_URL, REDIS_URL, SMTP, ORIGIN). |
| `tagcloud-backup.service` | systemd unit для бэкап-задачи (вызывает `scripts/ops/backup.sh`). |
| `tagcloud-backup.timer` | systemd timer — ежедневно в 03:30 UTC. |
| `backup.env.example` | Конфиг бэкапа (DATABASE_URL + restic-репозиторий + пароль). |
| `tagcloud@.service` | Шаблон systemd для multi-instance (горизонтальное масштабирование под 1000+ concurrent). |
| `mail-server.md` | Гайд по настройке Sender.net SMTP (SMTP-credentials + DNS). |
| `static-ip.md` | Пошаговая инструкция под конкретный self-host: статический IP `193.233.246.98` + домен `2090.dedyn.io` (deSEC). |
| `dynamic-ip.md` | Гайд по деплою на сервер с динамическим IP (DDNS / Cloudflare Tunnel / TLS DNS-01). |
| `dynamic-ip-setup.sh` | Интерактивный мастер по `dynamic-ip.md`: показывает каждую команду перед выполнением, спрашивает подтверждение (выполнить / пропустить / своя команда / выйти), ведёт прогресс. |
| `base-deploy.sh` | Интерактивный мастер по разделу «Первый деплой» этого README (Node 22 + postgres + redis + сборка + tagcloud.env + миграции + systemd + Caddyfile под выбранный сценарий dynamic-ip). Запускать после `dynamic-ip-setup.sh`. |

## Первый деплой (типовой self-host)

Предполагаем сервер с Ubuntu 22.04+ или Debian 12+, root-доступ, public IP,
DNS A-запись `yourdomain.tld → IP` уже создана.

### 1. Системные пакеты

```bash
apt update
apt install -y postgresql redis-server caddy restic
# Node 22 через NodeSource (или nvm — на ваш вкус):
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
```

### 2. Сервисный пользователь и каталоги

```bash
useradd -r -s /usr/sbin/nologin tagcloud
mkdir -p /opt/tagcloud /etc/tagcloud /var/log/tagcloud
chown -R tagcloud:tagcloud /opt/tagcloud /var/log/tagcloud
chmod 750 /etc/tagcloud
```

### 3. Postgres

```bash
sudo -u postgres psql <<SQL
CREATE USER tagcloud WITH PASSWORD 'CHANGE_ME';
CREATE DATABASE tagcloud OWNER tagcloud;
SQL
```

### 4. Сборка

```bash
cd /opt/tagcloud
sudo -u tagcloud git clone https://github.com/milkuzza/tagcloud-2090-main .
sudo -u tagcloud npm ci
sudo -u tagcloud npm run build
sudo -u tagcloud DATABASE_URL=... npm run db:migrate
```

### 5. Конфиги

```bash
cp deploy/tagcloud.env.example /etc/tagcloud/tagcloud.env
cp deploy/backup.env.example /etc/tagcloud/backup.env
chmod 600 /etc/tagcloud/*.env
chown tagcloud:tagcloud /etc/tagcloud/*.env
# Отредактировать оба файла, заполнить реальные секреты:
$EDITOR /etc/tagcloud/tagcloud.env /etc/tagcloud/backup.env
```

### 6. Systemd

```bash
cp deploy/tagcloud.service /etc/systemd/system/
cp deploy/tagcloud-backup.service /etc/systemd/system/
cp deploy/tagcloud-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now tagcloud
systemctl enable --now tagcloud-backup.timer
```

Проверка:

```bash
systemctl status tagcloud
journalctl -u tagcloud -f
curl http://127.0.0.1:3000/healthz   # должно вернуть "ok"
curl http://127.0.0.1:3000/readyz    # должно вернуть {"ok":true,...}
```

### 7. Mail (Sender.net SMTP)

Все письма (verification, итоги опросов) уходят через Sender.net SMTP.
Никаких локальных Postfix/OpenDKIM не требуется — приложение
авторизуется в Sender.net по SMTP-credentials и отправляет напрямую.

Краткий путь:

1. Зарегистрироваться на https://www.sender.net и активировать
   Transactional emails.
2. Добавить и верифицировать домен отправителя.
3. Создать SMTP-пользователя: Transactional emails → Setup instructions
   → SMTP → Add SMTP user.
4. В `/etc/tagcloud/tagcloud.env` подставить:

   ```
   SMTP_HOST=smtp.sender.net
   SMTP_PORT=587
   SMTP_SECURE=false
   SMTP_USER=<SMTP-логин из Sender.net>
   SMTP_PASSWORD=<SMTP-пароль из Sender.net>
   SMTP_FROM="Tagcloud <noreply@yourdomain.tld>"
   ```

5. `systemctl restart tagcloud`.

Подробности (SPF/DKIM/DMARC, лимиты) — `deploy/mail-server.md`.

Проверка:

```bash
journalctl -u tagcloud -n 100 | grep -iE "smtp|mail"
# Триггерим письмо (например, регистрация нового пользователя через UI)
# и смотрим, что в логе нет ошибок отправки.
```

### 8. Caddy

```bash
cp deploy/Caddyfile.example /etc/caddy/Caddyfile
sed -i 's/yourdomain.tld/имя-вашего-домена/g' /etc/caddy/Caddyfile
systemctl reload caddy
```

Caddy автоматически выпустит TLS-сертификат при первом обращении к домену.

### 9. Первый бэкап вручную

```bash
sudo -u tagcloud bash -c 'set -a; source /etc/tagcloud/backup.env; set +a; /opt/tagcloud/scripts/ops/backup.sh'
restic -r "$RESTIC_REPOSITORY" snapshots   # должен показать первую запись
```

## Обновление

```bash
cd /opt/tagcloud
sudo -u tagcloud git pull
sudo -u tagcloud npm ci
sudo -u tagcloud npm run build
sudo -u tagcloud DATABASE_URL=... npm run db:migrate
systemctl restart tagcloud
```

`hooks.server.ts` корректно обрабатывает SIGTERM (флашит in-memory очередь
голосов и закрывает WS-комнаты). systemd ждёт до 30с (`TimeoutStopSec=30`).

## Отсутствие домена

Можно временно деплоить по IP без TLS — раскомментируйте блок `:80` в
`Caddyfile.example` и удалите блок `yourdomain.tld {…}`. После регистрации
домена верните как было и перезагрузите Caddy.

## Готовый сценарий: `2090.dedyn.io` на статическом IP

Для конкретной целевой машины — VPS со статическим IP
`193.233.246.98` и доменом `2090.dedyn.io` (deSEC) — собран отдельный
гайд `deploy/static-ip.md` с уже подставленными значениями: A-запись
в deSEC, sed-замена `yourdomain.tld → 2090.dedyn.io` в `Caddyfile.example`,
ufw-правила, проверки DNS/TLS. Для new-deploy на этот сервер удобнее
идти по нему, не правя шаблоны вручную.

## Динамический IP

Если у сервера нет постоянного публичного IP (домашний сервер, residential-
провайдер, CGNAT), используйте отдельный гайд: `deploy/dynamic-ip.md`. Он
покрывает:

- DDNS на Cloudflare API (systemd-таймер обновляет A-запись каждые 5 минут);
- проброс портов 80/443 на роутере;
- Caddy с DNS-01 challenge (сертификат не зависит от доступности 80-го порта);
- альтернативу через **Cloudflare Tunnel** — без проброса портов вообще,
  работает за CGNAT;
- релей почты через smarthost (Resend / Brevo / Mailgun / SES), потому что
  на динамическом IP свой 25-й порт обычно зарезан и сразу попадает в SBL.

## Масштабирование под 1000+ concurrent

Архитектура изначально готова к multi-instance: Postgres `FOR UPDATE SKIP
LOCKED` в cron и Redis-агрегаты за пределами процесса исключают конфликты
при параллельном запуске нескольких Node-процессов на одной машине.

### Профиль одиночного инстанса (рекомендуется до 500 concurrent)

`tagcloud.service` запускает один процесс на порту 3000. Тяжёлый рендер
PNG (`d3-cloud + canvas`) уже вынесен в worker_threads-пул через
[piscina][piscina] (см. `src/lib/server/cloud/render-png.ts`), так что
event loop не блокируется. На 4-vCPU домашнем сервере одного процесса
обычно хватает.

[piscina]: https://github.com/piscinajs/piscina

### Профиль multi-instance (для 1000+ concurrent или multi-CPU)

Запустите N процессов на разных портах через template-unit
`tagcloud@.service` и распределите трафик через Caddy `lb_policy`:

```bash
cp deploy/tagcloud@.service /etc/systemd/system/
systemctl daemon-reload
# Например, 4 инстанса на портах 3001–3004:
systemctl enable --now tagcloud@3001 tagcloud@3002 tagcloud@3003 tagcloud@3004
systemctl disable --now tagcloud   # отключить single-instance
```

В `Caddyfile.example` есть закомментированный блок load_balancing —
раскомментируйте и подставьте список портов. Балансировщик отправит
запрос на свободный upstream (least_conn). WS-сессия закрепится за
выбранным upstream'ом (sticky через cookie или `client_ip_hash`), что
важно для in-process realtime broadcast.

**Расчёт ёмкости:**
- 1 vCPU + 512MB на инстанс минимум.
- worker_threads пул сам себя ограничивает (`min(cpus-1, 4)` на
  процесс) — при 4 инстансах × 3 worker'а это до 12 параллельных PNG-рендеров.
- Postgres connection limit: `postgres-js` по умолчанию держит 10
  коннекций на инстанс — на 4 инстанса нужно `max_connections >= 50`
  (стандартный 100 у postgres хватит с запасом).

### Метрики и нагрузочное тестирование

`/metrics` экспортирует Prometheus-формат: HTTP latency histogram,
voting throughput, WS-коннекты, render-time. Ограничьте доступ через
ACL Caddy (см. `Caddyfile.example`) или установите `METRICS_TOKEN` в
`tagcloud.env`. Для нагрузочного теста удобен `oha`:

```bash
oha -c 200 -n 50000 'https://yourdomain.tld/api/surveys/CODE/answer'
```

Следить за SLO в Grafana или просто `curl /metrics | grep
http_request_duration`. Если p95 поднимается выше 500мс — увеличить
число инстансов.
