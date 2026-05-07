# Деплой tagcloud на сервер с динамическим IP (домен `2090.fun`)

Этот гайд — расширение `deploy/README.md` для случая, когда у машины
**нет постоянного публичного IP** (домашний сервер, residential-провайдер,
4G-модем, VPS с регулярно меняющимся IP). Все остальные шаги — установка
пакетов, systemd, Postgres, бэкапы — берутся из `deploy/README.md` без
изменений.

> Везде в примерах домен — `2090.fun`. Замените на свой, если другой.

## Содержание

- [Какой вариант выбрать](#какой-вариант-выбрать)
- [Подготовка домена `2090.fun` в Cloudflare](#подготовка-домена-2090fun-в-cloudflare)
- [Вариант A. DDNS + проброс портов на роутере](#вариант-a-ddns--проброс-портов-на-роутере)
  - [A.1. Настройка DDNS-клиента (Cloudflare API)](#a1-настройка-ddns-клиента-cloudflare-api)
  - [A.2. Проброс портов на роутере](#a2-проброс-портов-на-роутере)
  - [A.3. Caddy с DNS-01 challenge](#a3-caddy-с-dns-01-challenge)
  - [A.4. Firewall на сервере (ufw)](#a4-firewall-на-сервере-ufw)
- [Вариант B. Cloudflare Tunnel (без проброса портов)](#вариант-b-cloudflare-tunnel-без-проброса-портов)
  - [B.1. Установка cloudflared](#b1-установка-cloudflared)
  - [B.2. Создание тоннеля и DNS-записей](#b2-создание-тоннеля-и-dns-записей)
  - [B.3. Config-файл и systemd-юнит](#b3-config-файл-и-systemd-юнит)
  - [B.4. Caddy без публичного TLS](#b4-caddy-без-публичного-tls)
- [Почта при динамическом IP](#почта-при-динамическом-ip)
- [Проверки после деплоя](#проверки-после-деплоя)
- [Траблшутинг](#траблшутинг)

## Какой вариант выбрать

| Условие | Рекомендация |
|---|---|
| Есть доступ к роутеру и можно пробросить 80/443. ISP даёт «честный» IP (не CGNAT). | **Вариант A**: DDNS + проброс портов. |
| CGNAT (один публичный IP на много абонентов), нет доступа к роутеру, мобильный интернет, или нужно скрыть IP. | **Вариант B**: Cloudflare Tunnel — внешний IP вообще не нужен. |
| Не уверены — проверьте: `curl -s https://api.ipify.org` и сравните с IP в админке роутера (WAN). Если они различаются — почти наверняка CGNAT, выбирайте B. |

В обоих вариантах DNS-зону держим в Cloudflare (бесплатно) — он же
выпускает DNS-01 сертификаты и/или раздаёт тоннель.

## Подготовка домена `2090.fun` в Cloudflare

1. В админке регистратора домена смените NS-серверы на cloudflare-овские
   (Cloudflare выдаст пару `xxx.ns.cloudflare.com`). Распространение —
   до 24 часов; обычно несколько минут.
2. В Cloudflare создаётся пустая зона `2090.fun`. Дальше DNS-записи
   добавляем оттуда (или через API из DDNS-клиента).
3. Создайте API-токен Cloudflare с минимальными правами (понадобится
   и для DDNS, и для DNS-01):
   - https://dash.cloudflare.com/profile/api-tokens → Create Token
   - Use template **Edit zone DNS**
   - Zone Resources: **Include → Specific zone → 2090.fun**
   - Сохраните токен в менеджер паролей. На сервере положим в
     `/etc/tagcloud/cloudflare.env` (chmod 600).

```bash
sudo install -m 600 -o root -g root /dev/stdin /etc/tagcloud/cloudflare.env <<'EOF'
# Cloudflare API token (Edit zone DNS на 2090.fun)
CF_API_TOKEN=ВАШ_ТОКЕН
# Удобно сразу прокинуть и для DNS-01 challenge'а Caddy:
CLOUDFLARE_API_TOKEN=ВАШ_ТОКЕН
EOF
```

## Вариант A. DDNS + проброс портов на роутере

### A.1. Настройка DDNS-клиента (Cloudflare API)

Используем простой systemd-таймер, который раз в 5 минут обновляет
A-запись `2090.fun` (и `*.2090.fun`) на текущий публичный IP сервера.
Ставить отдельный демон не нужно — хватает скрипта на bash.

Положите скрипт:

```bash
sudo install -m 750 -o root -g root /dev/stdin /usr/local/bin/cf-ddns.sh <<'EOF'
#!/usr/bin/env bash
# Обновляет A-запись в Cloudflare на текущий публичный IP. Идемпотентно.
# Конфиг в /etc/tagcloud/cloudflare.env (CF_API_TOKEN, CF_ZONE, CF_RECORDS).
set -euo pipefail

# shellcheck disable=SC1091
. /etc/tagcloud/cloudflare.env

: "${CF_API_TOKEN:?CF_API_TOKEN not set}"
: "${CF_ZONE:?CF_ZONE not set (например, 2090.fun)}"
: "${CF_RECORDS:?CF_RECORDS not set (через пробел: 2090.fun www.2090.fun)}"

CURRENT_IP="$(curl -fsS --max-time 10 https://api.ipify.org \
  || curl -fsS --max-time 10 https://ifconfig.co)"
[[ -n "$CURRENT_IP" ]] || { echo "no public IP detected" >&2; exit 1; }

api() { curl -fsS -H "Authorization: Bearer ${CF_API_TOKEN}" \
              -H "Content-Type: application/json" "$@"; }

ZONE_ID="$(api "https://api.cloudflare.com/client/v4/zones?name=${CF_ZONE}" \
  | jq -r '.result[0].id')"
[[ -n "$ZONE_ID" && "$ZONE_ID" != "null" ]] || { echo "zone ${CF_ZONE} not found" >&2; exit 1; }

for NAME in $CF_RECORDS; do
  REC_JSON="$(api "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records?type=A&name=${NAME}")"
  REC_ID="$(echo "$REC_JSON" | jq -r '.result[0].id // empty')"
  REC_IP="$(echo  "$REC_JSON" | jq -r '.result[0].content // empty')"

  PAYLOAD="$(jq -n --arg n "$NAME" --arg ip "$CURRENT_IP" \
    '{type:"A", name:$n, content:$ip, ttl:120, proxied:false}')"

  if [[ -z "$REC_ID" ]]; then
    echo "[ddns] create ${NAME} → ${CURRENT_IP}"
    api -X POST "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records" \
      --data "$PAYLOAD" >/dev/null
  elif [[ "$REC_IP" != "$CURRENT_IP" ]]; then
    echo "[ddns] update ${NAME}: ${REC_IP} → ${CURRENT_IP}"
    api -X PUT "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records/${REC_ID}" \
      --data "$PAYLOAD" >/dev/null
  else
    echo "[ddns] ${NAME} up-to-date (${CURRENT_IP})"
  fi
done
EOF

sudo apt-get install -y curl jq

sudo tee -a /etc/tagcloud/cloudflare.env >/dev/null <<'EOF'
CF_ZONE=2090.fun
# Записи, которые обновляем при смене IP. Через пробел.
CF_RECORDS="2090.fun www.2090.fun"
EOF
```

systemd-юниты:

```bash
sudo tee /etc/systemd/system/cf-ddns.service >/dev/null <<'EOF'
[Unit]
Description=Cloudflare DDNS update for 2090.fun
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
EnvironmentFile=/etc/tagcloud/cloudflare.env
ExecStart=/usr/local/bin/cf-ddns.sh
EOF

sudo tee /etc/systemd/system/cf-ddns.timer >/dev/null <<'EOF'
[Unit]
Description=Run Cloudflare DDNS update every 5 minutes

[Timer]
OnBootSec=30s
OnUnitActiveSec=5min
Unit=cf-ddns.service
Persistent=true

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now cf-ddns.timer
sudo systemctl start cf-ddns.service        # форсим первый прогон
journalctl -u cf-ddns.service -n 20 --no-pager
```

После первого запуска `dig +short 2090.fun` должен вернуть текущий
публичный IP сервера. TTL = 120 секунд — после смены IP новые запросы
доходят максимум через 2 минуты.

### A.2. Проброс портов на роутере

В админке роутера (Keenetic, MikroTik, OpenWRT и т.д.) пробросьте на
LAN-IP сервера:

| Внешний порт | Внутренний порт | Протокол | Зачем |
|---|---|---|---|
| 80 | 80 | TCP | редирект `http → https` (Caddy) |
| 443 | 443 | TCP | основной HTTPS-трафик |

> Порт 25 (SMTP) для исходящей почты на residential-провайдере **почти
> наверняка заблокирован** и проброс его не открывает (это блок «out»).
> Раздел [Почта при динамическом IP](#почта-при-динамическом-ip)
> описывает, как это обходить.

Если IP за CGNAT (см. начало гайда) — проброс работать не будет.
Используйте Вариант B.

### A.3. Caddy с DNS-01 challenge

Стандартный `Caddyfile.example` использует HTTP-01 challenge: Let's
Encrypt стучится на 80/443 публичного IP. На динамическом IP это
работает, но если 80/443 хоть на минуту недоступны (роутер
перезагружается, провайдер моргнул, IP только что сменился и DNS
не успел догнать) — обновление сертификата падает. Надёжнее DNS-01
через Cloudflare API: вообще не зависит от доступности 80-го порта
снаружи.

Caddy для DNS-01 нужно собрать с плагином `caddy-dns/cloudflare`
(пакет `caddy` из Debian/Ubuntu идёт без него). Самый простой путь —
через `xcaddy`:

```bash
# 1. Поставить Go и xcaddy:
sudo apt-get install -y golang-go
sudo curl -fsSLo /usr/local/bin/xcaddy \
  https://github.com/caddyserver/xcaddy/releases/latest/download/xcaddy_linux_amd64
sudo chmod +x /usr/local/bin/xcaddy

# 2. Собрать caddy с DNS-провайдером Cloudflare:
sudo xcaddy build --with github.com/caddy-dns/cloudflare \
  --output /usr/local/bin/caddy
sudo setcap cap_net_bind_service=+ep /usr/local/bin/caddy

# 3. Подменить бинарь, который запускает systemd-юнит caddy:
sudo systemctl edit caddy
# В редакторе добавить:
#   [Service]
#   ExecStart=
#   ExecStart=/usr/local/bin/caddy run --environ --config /etc/caddy/Caddyfile
```

Caddyfile (на основе `deploy/Caddyfile.example`, диффы — ниже):

```caddy
{
    email admin@2090.fun
}

2090.fun, www.2090.fun {
    tls {
        # DNS-01 challenge через Cloudflare API.
        # Токен берётся из переменной среды CLOUDFLARE_API_TOKEN.
        dns cloudflare {env.CLOUDFLARE_API_TOKEN}
        # На случай гонки propagation: подождём, пока запись появится
        # на двух авторитативных серверах, прежде чем дёрнуть ACME.
        propagation_timeout 5m
        resolvers 1.1.1.1 1.0.0.1
    }

    reverse_proxy 127.0.0.1:3000 {
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
        transport http {
            read_timeout 1h
            write_timeout 1h
        }
    }

    # Остальной контент (security-заголовки, /metrics ACL, hidden paths)
    # копируем 1-в-1 из deploy/Caddyfile.example.
}
```

Чтобы Caddy подхватил `CLOUDFLARE_API_TOKEN`:

```bash
sudo systemctl edit caddy
# В редакторе:
#   [Service]
#   EnvironmentFile=/etc/tagcloud/cloudflare.env
sudo systemctl reload caddy   # или restart, если меняли ExecStart выше
```

Проверка:

```bash
sudo journalctl -u caddy -f
# Ищем строки "obtain certificate" и "certificate obtained successfully"
curl -I https://2090.fun
# HTTP/2 200, валидный сертификат от Let's Encrypt.
```

### A.4. Firewall на сервере (ufw)

```bash
sudo apt-get install -y ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow ssh                 # 22/tcp
sudo ufw allow 80/tcp              # http → https redirect
sudo ufw allow 443/tcp             # https
# Postgres/Redis/Postfix:25 - только loopback, наружу не открываем!
sudo ufw enable
sudo ufw status verbose
```

## Вариант B. Cloudflare Tunnel (без проброса портов)

Этот путь решает все проблемы динамического IP сразу:

- никакие порты на роутере пробрасывать не нужно;
- работает за CGNAT, NAT, корпоративным firewall;
- TLS-сертификаты выдаёт Cloudflare на edge, локальный Caddy может
  отдавать plain HTTP по loopback;
- IP сервера наружу не светится.

### B.1. Установка cloudflared

```bash
# Debian/Ubuntu — официальный репозиторий Cloudflare:
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] \
https://pkg.cloudflare.com/cloudflared $(. /etc/os-release && echo "$VERSION_CODENAME") main" \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update
sudo apt-get install -y cloudflared
```

### B.2. Создание тоннеля и DNS-записей

```bash
# Логин — откроет браузер; выберите зону 2090.fun.
sudo cloudflared tunnel login

# Создать тоннель.
sudo cloudflared tunnel create tagcloud
# В выводе: "Created tunnel tagcloud with id <UUID>"
# и путь до credentials JSON, например /root/.cloudflared/<UUID>.json.

# Привязать DNS-имена к тоннелю (CNAME → <UUID>.cfargotunnel.com).
sudo cloudflared tunnel route dns tagcloud 2090.fun
sudo cloudflared tunnel route dns tagcloud www.2090.fun
```

### B.3. Config-файл и systemd-юнит

```bash
sudo install -d -m 700 /etc/cloudflared
sudo install -m 600 /root/.cloudflared/<UUID>.json /etc/cloudflared/tagcloud.json

sudo tee /etc/cloudflared/config.yml >/dev/null <<'EOF'
tunnel: tagcloud
credentials-file: /etc/cloudflared/tagcloud.json

ingress:
  - hostname: 2090.fun
    service: http://127.0.0.1:80
    originRequest:
      # Долгоживущие WS — увеличиваем idle.
      noTLSVerify: true
      connectTimeout: 30s
      tlsTimeout: 30s
      tcpKeepAlive: 30s
      keepAliveTimeout: 1h
      noHappyEyeballs: true
  - hostname: www.2090.fun
    service: http://127.0.0.1:80
  # Catch-all: всё остальное — 404.
  - service: http_status:404
EOF
```

systemd-юнит cloudflared умеет ставить сам:

```bash
sudo cloudflared --config /etc/cloudflared/config.yml service install
sudo systemctl enable --now cloudflared
sudo systemctl status cloudflared
journalctl -u cloudflared -f
# Ищем строки "Registered tunnel connection" — должно быть ≥2 коннекта
# к разным дата-центрам Cloudflare.
```

### B.4. Caddy без публичного TLS

В этом варианте Cloudflare отдаёт TLS клиенту, а до Caddy идёт plain HTTP
по loopback (внутри тоннеля он зашифрован cloudflared'ом). В Caddyfile —
блок без TLS:

```caddy
{
    auto_https off
}

:80 {
    @hosts host 2090.fun www.2090.fun
    handle @hosts {
        reverse_proxy 127.0.0.1:3000 {
            header_up X-Real-IP {http.request.header.cf-connecting-ip}
            header_up X-Forwarded-For {http.request.header.cf-connecting-ip}
            header_up X-Forwarded-Proto https
            transport http {
                read_timeout 1h
                write_timeout 1h
            }
        }

        header {
            Strict-Transport-Security "max-age=31536000; includeSubDomains"
            X-Content-Type-Options "nosniff"
            X-Frame-Options "DENY"
            Referrer-Policy "strict-origin-when-cross-origin"
            Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=()"
            -Server
        }

        @healthz path /healthz /readyz
        log_skip @healthz

        @hidden path /.env /.git/*
        respond @hidden 404
    }
}
```

Cloudflare пишет реальный IP клиента в заголовок `Cf-Connecting-Ip` —
именно его пробрасываем как `X-Forwarded-For` в SvelteKit. В
`/etc/tagcloud/tagcloud.env` оставляем:

```
ADDRESS_HEADER=X-Forwarded-For
PROTOCOL_HEADER=X-Forwarded-Proto
XFF_DEPTH=1
ORIGIN=https://2090.fun
```

> ВАЖНО: на dashboard Cloudflare для зоны `2090.fun` поставьте режим
> **Full (strict)** или **Full** в SSL/TLS → Overview, иначе клиенты
> поймают `522`/`525`. Для тоннеля cloudflared это не критично (между
> Cloudflare и сервером trust по сертификату Cloudflare), но при первой
> же ошибке стоит проверить.

Firewall в этом варианте можно ужесточить: 80 и 443 наружу **не нужны**
вовсе — весь трафик ходит исходящим к Cloudflare.

```bash
sudo ufw allow ssh
sudo ufw deny  80/tcp
sudo ufw deny  443/tcp
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw enable
```

## Почта при динамическом IP

Дефолтная схема из `deploy/mail-server.md` (локальный Postfix → 25/tcp →
получатель) на динамическом IP **почти не работает**:

- Большинство residential-сетей либо в SBL/PBL Spamhaus, либо хостер
  блокирует исходящий 25/tcp.
- PTR-запись на динамический IP вы не сможете прописать.
- Даже если письма уйдут — Gmail/Mail.ru будут резать как spam.

Решение — оставляем локальный Postfix как принимающий gateway для
приложения (app по-прежнему ходит на `127.0.0.1:25`), но релеим
исходящие через сторонний submission-сервис. Подойдёт любой:

| Провайдер | Free/Trial | Хост | Порт | Auth |
|---|---|---|---|---|
| [Resend](https://resend.com) | 3 000 писем/мес | `smtp.resend.com` | 465 (SSL) | API-key как пароль |
| [Brevo](https://www.brevo.com) (ex Sendinblue) | 300/день | `smtp-relay.brevo.com` | 587 | login/key |
| [Mailgun](https://mailgun.com) | 5 000/мес 3 мес | `smtp.mailgun.org` | 587 | postmaster |
| [SES](https://aws.amazon.com/ses/) | 200/день из EC2 | `email-smtp.<region>.amazonaws.com` | 587 | SMTP-credentials |
| Yandex 360 / Google Workspace | платно, но «бизнесовые» лимиты | по доке провайдера | 465 | login/app-password |

Дальше алгоритм одинаковый — настраиваем relayhost у локального
Postfix.

```bash
sudo bash deploy/setup-mailserver.sh 2090.fun
# Скрипт ставит postfix + opendkim. DKIM-ключ нам всё равно нужен:
# смартхост подпись не уберёт, и доставка пройдёт лучше.

sudo postconf -e "relayhost = [smtp.resend.com]:465"
sudo postconf -e "smtp_sasl_auth_enable = yes"
sudo postconf -e "smtp_sasl_password_maps = hash:/etc/postfix/sasl_passwd"
sudo postconf -e "smtp_sasl_security_options = noanonymous"
sudo postconf -e "smtp_tls_wrappermode = yes"           # 465 = implicit TLS
sudo postconf -e "smtp_tls_security_level = encrypt"
sudo postconf -e "smtp_sasl_mechanism_filter = plain, login"

# Логин/пароль для смартхоста — chmod 600!
sudo install -m 600 -o root -g root /dev/stdin /etc/postfix/sasl_passwd <<'EOF'
[smtp.resend.com]:465 resend:re_СЕКРЕТНЫЙ_API_KEY
EOF

sudo postmap /etc/postfix/sasl_passwd
sudo systemctl restart postfix
```

DNS-записи `2090.fun` (минимально для прохождения SPF/DKIM/DMARC при
релее через Resend; для других провайдеров — посмотрите их доки):

| Тип | Имя | Значение | Зачем |
|---|---|---|---|
| TXT | `@` | `v=spf1 include:_spf.resend.com -all` | Авторизуем Resend как отправителя. |
| TXT | `mail._domainkey` | содержимое `/etc/opendkim/keys/2090.fun/mail.txt` | DKIM локального OpenDKIM (smarthost подпись не ломает). |
| TXT | `_dmarc` | `v=DMARC1; p=quarantine; rua=mailto:postmaster@2090.fun; adkim=s; aspf=s` | Политика DMARC. |
| TXT/CNAME | по доке Resend (`resend._domainkey`, `resend2._domainkey`) | значения из их dashboard | DKIM их собственной ESP-подписи. |

Конфиг приложения **не меняется** — оно по-прежнему ходит на
`127.0.0.1:25` без auth, локальный Postfix принимает, OpenDKIM
подписывает и Postfix релеит к Resend.

```bash
# /etc/tagcloud/tagcloud.env
SMTP_HOST=127.0.0.1
SMTP_PORT=25
SMTP_SECURE=false
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM="Tagcloud <noreply@2090.fun>"
```

Проверка:

```bash
echo "ping" | mail -s "tagcloud test from dynamic-ip host" you@example.com
journalctl -u postfix -n 50 | grep -E "status=sent|status=bounced"
# В логе должно быть status=sent через relay=smtp.resend.com[…]:465
```

Альтернатива — **полностью убрать Postfix** и слать прямо из
приложения на смартхост:

```ini
SMTP_HOST=smtp.resend.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=resend
SMTP_PASSWORD=re_СЕКРЕТНЫЙ_API_KEY
SMTP_FROM="Tagcloud <noreply@2090.fun>"
```

Это проще (один компонент меньше), но теряете единый локальный лог
исходящего и DKIM-подпись от собственного домена. На небольших
объёмах оба варианта равнозначны — выбирайте по вкусу.

## Проверки после деплоя

Независимо от варианта (A или B):

```bash
# 1. DNS указывает на текущий IP / на тоннель
dig +short 2090.fun
# Вариант A: должен вернуть актуальный публичный IP сервера.
# Вариант B: <UUID>.cfargotunnel.com (если nslookup идёт в обход CF) или
#            набор anycast IP Cloudflare.

# 2. Сертификат валидный
curl -sIL https://2090.fun | head -n 5
echo | openssl s_client -connect 2090.fun:443 -servername 2090.fun 2>/dev/null \
  | openssl x509 -noout -issuer -subject -dates

# 3. Приложение отвечает
curl -s https://2090.fun/healthz       # ok
curl -s https://2090.fun/readyz | jq   # {"ok":true,...}

# 4. WebSocket поднимается
# (откройте сайт в браузере, в DevTools → Network → WS должна быть запись
#  со статусом 101 Switching Protocols)

# 5. Сервисы крутятся
systemctl status tagcloud caddy postfix opendkim cf-ddns.timer cloudflared 2>&1 | grep -E "Active|●"
```

## Траблшутинг

**`dig 2090.fun` возвращает старый IP**

- TTL у нас 120с, плюс кеши резолверов. Подождите 5 минут.
- `journalctl -u cf-ddns.service -n 20` — смотрим, что DDNS-скрипт
  отрабатывает без ошибок и что новый IP действительно записался.
- В Cloudflare admin → DNS убедитесь, что A-запись `proxied=false`
  (серое облачко). Если облачко оранжевое и вы НЕ используете
  Cloudflare Tunnel — выключите proxy: оно ломает WS / увеличивает
  latency.

**Caddy не выпускает сертификат, в логе `tls obtain failed`**

- В варианте A проверьте, что `CLOUDFLARE_API_TOKEN` доступен процессу
  Caddy: `sudo systemctl show caddy -p Environment` должен показать
  токен (или пустую строку — тогда `EnvironmentFile=` не подцепился).
- Удалите кеш ACME и попробуйте ещё раз:
  ```bash
  sudo systemctl stop caddy
  sudo rm -rf /var/lib/caddy/.local/share/caddy/acme
  sudo systemctl start caddy
  ```
- Проверьте rate-limit Let's Encrypt — `5 certs/week per registered
  domain`. На отладке используйте staging:
  ```caddy
  acme_ca https://acme-staging-v02.api.letsencrypt.org/directory
  ```

**Cloudflare Tunnel не поднимается / `Unauthorized: Failed to get tunnel`**

- Проверьте `credentials-file` в `/etc/cloudflared/config.yml` — путь
  должен указывать на JSON, который вернул `cloudflared tunnel create`.
- `sudo cloudflared tunnel info tagcloud` — должен показать ID и
  статус коннектов.
- Если меняли account/zone в CF — перелогиньтесь:
  ```bash
  sudo rm /root/.cloudflared/cert.pem
  sudo cloudflared tunnel login
  ```

**Письма уходят, но падают в спам Gmail**

- На gmail.com → у любого письма «Show original» проверьте
  Authentication-Results: должны быть `spf=pass dkim=pass dmarc=pass`.
- Если SPF/DMARC fail — проверьте, что значение TXT-записи в
  Cloudflare admin совпадает с тем, что показывает
  `dig +short TXT 2090.fun`.
- `mail-tester.com`: отправьте письмо на адрес, который он
  выдаёт, — получите подробный отчёт 0–10. Цель ≥ 8.

**WebSocket рвётся каждые ~60 секунд (вариант B)**

- В `originRequest` ingress-config'а cloudflared проверьте
  `keepAliveTimeout: 1h`. Дефолт — 90 секунд.
- В Cloudflare admin → Network включите **WebSockets: On** (по дефолту
  обычно уже включено).
