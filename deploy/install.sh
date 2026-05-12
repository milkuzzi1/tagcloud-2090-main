#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Полностью автоматический деплой 2090.fun + cloud.2090.fun (Cloudflare Tunnel)
# с чистого Ubuntu 22.04/24.04 LTS до стадии «эксплуатация».
#
# Что разворачивается:
#   * Сервис tagcloud (SvelteKit/Node) на 127.0.0.1:3000
#   * PostgreSQL 16 + Redis локально (миграции применяются автоматически)
#   * Caddy как reverse-proxy: HTTPS терминирует Cloudflare на edge,
#     Caddy слушает по HTTP и проксирует на Node / отдаёт landing.
#   * cloudflared: туннель Cloudflare → Caddy (динамический IP, port-forward
#     не нужен; см. deploy/dynamic-ip.md, variant B).
#   * Landing-сайт 2090.fun (статика из /opt/tagcloud/landing).
#   * Облако тегов на cloud.2090.fun (SvelteKit-app).
#
# Запуск:
#   sudo bash deploy/install.sh
#
# Управляющие переменные окружения (см. ниже):
#   APP_DOMAIN, CLOUD_DOMAIN, TUNNEL_NAME, CF_TUNNEL_TOKEN, REPO_URL,
#   REPO_BRANCH, ADMIN_EMAIL, POSTGRES_PASSWORD, SESSION_SECRET,
#   SMTP_USER, SMTP_PASSWORD, SMTP_FROM, SKIP_TUNNEL_SETUP.
#
# Логика идемпотентна: повторный запуск не ломает то, что уже стоит.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail
IFS=$'\n\t'

# ────────── параметры (с дефолтами) ──────────

APP_DOMAIN="${APP_DOMAIN:-2090.fun}"
CLOUD_DOMAIN="${CLOUD_DOMAIN:-cloud.2090.fun}"
TUNNEL_NAME="${TUNNEL_NAME:-tagcloud-2090}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@${APP_DOMAIN}}"

REPO_URL="${REPO_URL:-https://github.com/milkuzzi/tagcloud-2090-main.git}"
REPO_BRANCH="${REPO_BRANCH:-main}"

APP_DIR="${APP_DIR:-/opt/tagcloud}"
APP_USER="${APP_USER:-tagcloud}"
APP_GROUP="${APP_GROUP:-tagcloud}"
ENV_DIR="/etc/tagcloud"
ENV_FILE="${ENV_DIR}/tagcloud.env"
LANDING_DIR="${APP_DIR}/landing"

PG_USER="${PG_USER:-tagcloud}"
PG_DB="${PG_DB:-tagcloud}"
PG_PASSWORD="${POSTGRES_PASSWORD:-}"  # пусто => сгенерируем

# Cloudflare Tunnel: либо token (новый named tunnel from dashboard),
# либо SKIP_TUNNEL_SETUP=1 — если пользователь настроит сам.
CF_TUNNEL_TOKEN="${CF_TUNNEL_TOKEN:-}"
SKIP_TUNNEL_SETUP="${SKIP_TUNNEL_SETUP:-0}"

# SMTP (для итоговых писем). По умолчанию подставится placeholder —
# отправка писем будет молча падать до тех пор, пока эти переменные не
# заполнит администратор в /etc/tagcloud/tagcloud.env.
SMTP_HOST="${SMTP_HOST:-smtp.sender.net}"
SMTP_PORT="${SMTP_PORT:-587}"
SMTP_SECURE="${SMTP_SECURE:-false}"
SMTP_USER="${SMTP_USER:-}"
SMTP_PASSWORD="${SMTP_PASSWORD:-}"
SMTP_FROM="${SMTP_FROM:-}"

# Секрет cookie-сессии. Должен быть стабильным между рестартами, иначе
# все пользователи разлогинятся. Если не задан — сгенерируем при первом
# прогоне и сохраним в env-файле.
SESSION_SECRET="${SESSION_SECRET:-}"

# ────────── цвета ──────────

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'
  C_BLU=$'\033[34m'; C_CYAN=$'\033[36m'
else
  C_RESET=''; C_BOLD=''; C_DIM=''
  C_RED=''; C_GRN=''; C_YEL=''; C_BLU=''; C_CYAN=''
fi

info()  { printf '%s[i]%s %s\n' "$C_CYAN" "$C_RESET" "$*"; }
ok()    { printf '%s[ok]%s %s\n' "$C_GRN" "$C_RESET" "$*"; }
warn()  { printf '%s[!]%s %s\n' "$C_YEL" "$C_RESET" "$*" >&2; }
err()   { printf '%s[x]%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; }
hdr()   { printf '\n%s%s──── %s ────%s\n\n' "$C_BOLD" "$C_BLU" "$*" "$C_RESET"; }

# ────────── проверки окружения ──────────

if [[ $EUID -ne 0 ]]; then
  err "Запустите скрипт с правами root: sudo bash $0"
  exit 1
fi

if ! command -v lsb_release >/dev/null 2>&1; then
  apt-get update -y >/dev/null
  apt-get install -y lsb-release >/dev/null
fi

UBUNTU_CODENAME="$(lsb_release -sc 2>/dev/null || echo unknown)"
case "$UBUNTU_CODENAME" in
  jammy|noble) info "Ubuntu $UBUNTU_CODENAME — поддерживается" ;;
  *) warn "Ubuntu $UBUNTU_CODENAME не тестировался; продолжаем на свой риск" ;;
esac

# ────────── apt: базовые пакеты ──────────

hdr "Обновление apt и установка базовых пакетов"

export DEBIAN_FRONTEND=noninteractive

apt-get update -y
apt-get install -y \
  curl wget ca-certificates gnupg lsb-release \
  git build-essential \
  pkg-config python3 \
  postgresql postgresql-contrib \
  redis-server \
  ufw \
  jq openssl \
  libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev libpixman-1-dev

ok "Базовые пакеты установлены"

# ────────── Node.js 22 ──────────

hdr "Установка Node.js 22 (NodeSource)"

if ! node -v 2>/dev/null | grep -q '^v22\.'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v
npm -v
ok "Node.js установлен"

# ────────── Caddy ──────────

hdr "Установка Caddy (reverse-proxy)"

if ! command -v caddy >/dev/null 2>&1; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt" \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi
caddy version
ok "Caddy установлен"

# ────────── cloudflared (Cloudflare Tunnel) ──────────

hdr "Установка cloudflared"

if ! command -v cloudflared >/dev/null 2>&1; then
  mkdir -p --mode=0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
    | tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $UBUNTU_CODENAME main" \
    > /etc/apt/sources.list.d/cloudflared.list
  apt-get update -y
  apt-get install -y cloudflared
fi
cloudflared --version
ok "cloudflared установлен"

# ────────── пользователь приложения ──────────

hdr "Создание системного пользователя $APP_USER"

if ! id -u "$APP_USER" >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
fi
install -d -o "$APP_USER" -g "$APP_GROUP" -m 0755 "$APP_DIR"
install -d -o root -g root -m 0755 "$ENV_DIR"
ok "Пользователь и каталоги готовы"

# ────────── PostgreSQL: пользователь / БД ──────────

hdr "Настройка PostgreSQL"

systemctl enable --now postgresql

if [[ -z "$PG_PASSWORD" ]]; then
  PG_PASSWORD="$(openssl rand -hex 24)"
  info "POSTGRES_PASSWORD не задан — сгенерирован новый"
fi

sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$PG_USER';" \
  | grep -q 1 \
  || sudo -u postgres psql -c "CREATE ROLE $PG_USER LOGIN PASSWORD '$PG_PASSWORD';"

# Обновляем пароль, если он изменился (PG_PASSWORD приехал из env).
sudo -u postgres psql -c "ALTER ROLE $PG_USER WITH LOGIN PASSWORD '$PG_PASSWORD';" >/dev/null

sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$PG_DB';" \
  | grep -q 1 \
  || sudo -u postgres createdb -O "$PG_USER" "$PG_DB"

ok "PostgreSQL: роль $PG_USER, БД $PG_DB"

# ────────── Redis ──────────

hdr "Настройка Redis"

systemctl enable --now redis-server
ok "Redis запущен"

# ────────── клонирование / обновление репозитория ──────────

hdr "Клонирование/обновление репозитория"

if [[ ! -d "$APP_DIR/.git" ]]; then
  sudo -u "$APP_USER" git clone --branch "$REPO_BRANCH" "$REPO_URL" "$APP_DIR"
else
  info "Репозиторий уже клонирован — обновляем"
  sudo -u "$APP_USER" git -C "$APP_DIR" fetch origin "$REPO_BRANCH"
  sudo -u "$APP_USER" git -C "$APP_DIR" checkout "$REPO_BRANCH"
  sudo -u "$APP_USER" git -C "$APP_DIR" reset --hard "origin/$REPO_BRANCH"
fi
ok "Репозиторий готов в $APP_DIR"

# ────────── сборка приложения ──────────

hdr "Установка npm-зависимостей и сборка"

sudo -u "$APP_USER" bash -lc "cd '$APP_DIR' && npm ci --no-audit --no-fund"
sudo -u "$APP_USER" bash -lc "cd '$APP_DIR' && npm run build"
ok "Приложение собрано"

# ────────── env-файл ──────────

hdr "Запись /etc/tagcloud/tagcloud.env"

if [[ -z "$SESSION_SECRET" ]]; then
  # Если env-файл уже существует — переиспользуем секрет (чтобы юзеров
  # не выкинуло). Иначе генерируем новый.
  if [[ -f "$ENV_FILE" ]]; then
    SESSION_SECRET="$(grep -E '^SESSION_SECRET=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)"
  fi
  if [[ -z "$SESSION_SECRET" ]]; then
    SESSION_SECRET="$(openssl rand -hex 32)"
  fi
fi

DATABASE_URL="postgres://${PG_USER}:${PG_PASSWORD}@localhost:5432/${PG_DB}"

umask 0027
cat > "$ENV_FILE" <<EOF
# Сгенерировано deploy/install.sh — правьте вручную, перезапуск:
#   systemctl restart tagcloud

NODE_ENV=production
PUBLIC_BASE_URL=https://${CLOUD_DOMAIN}
PORT=3000
HOST=127.0.0.1

POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=${PG_USER}
POSTGRES_PASSWORD=${PG_PASSWORD}
POSTGRES_DB=${PG_DB}
DATABASE_URL=${DATABASE_URL}

REDIS_URL=redis://localhost:6379

SESSION_SECRET=${SESSION_SECRET}

SMTP_HOST=${SMTP_HOST}
SMTP_PORT=${SMTP_PORT}
SMTP_SECURE=${SMTP_SECURE}
SMTP_USER=${SMTP_USER:-your-smtp-user}
SMTP_PASSWORD=${SMTP_PASSWORD:-your-smtp-password}
SMTP_FROM=${SMTP_FROM:-Tagcloud <noreply@yourdomain.tld>}
EOF

chmod 0640 "$ENV_FILE"
chown root:"$APP_GROUP" "$ENV_FILE"
ok "Env-файл записан: $ENV_FILE"

if [[ -z "$SMTP_USER" || -z "$SMTP_PASSWORD" ]]; then
  warn "SMTP_USER/SMTP_PASSWORD не заданы — впишите вручную в $ENV_FILE"
fi

# ────────── миграции БД ──────────

hdr "Применение миграций (drizzle)"

sudo -u "$APP_USER" bash -lc "cd '$APP_DIR' && DATABASE_URL='${DATABASE_URL}' npm run db:push -- --force 2>/dev/null || DATABASE_URL='${DATABASE_URL}' npm run db:push"
ok "Миграции применены"

# ────────── landing на 2090.fun ──────────

hdr "Раскладка landing-сайта в $LANDING_DIR"

install -d -o "$APP_USER" -g "$APP_GROUP" -m 0755 "$LANDING_DIR"
if [[ -d "$APP_DIR/landing" ]]; then
  rsync -a --delete "$APP_DIR/landing/" "$LANDING_DIR/"
  chown -R "$APP_USER":"$APP_GROUP" "$LANDING_DIR"
  ok "Landing скопирован из $APP_DIR/landing"
else
  warn "В репозитории нет директории landing/ — пропускаем"
fi

# ────────── systemd: tagcloud ──────────

hdr "systemd: tagcloud.service"

cat > /etc/systemd/system/tagcloud.service <<EOF
[Unit]
Description=Tagcloud (SvelteKit, Node) — cloud.${APP_DOMAIN}
After=network-online.target postgresql.service redis-server.service
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_GROUP}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=/usr/bin/node ${APP_DIR}/build/index.js
Restart=on-failure
RestartSec=3
LimitNOFILE=65536

# Sandboxing.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
LockPersonality=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now tagcloud
ok "tagcloud.service запущен"

# ────────── Caddy ──────────

hdr "Конфигурация Caddy"

# Если есть Cloudflare Tunnel — TLS уже на edge, Caddy слушает только по HTTP.
# Иначе — обычная схема с автоматическими сертификатами Let's Encrypt
# (HTTP-01), для которой требуется публичный 80/443 порт.
if [[ -n "$CF_TUNNEL_TOKEN" || "$SKIP_TUNNEL_SETUP" == "1" ]]; then
  CADDY_MODE="tunnel"
else
  CADDY_MODE="public"
fi

if [[ "$CADDY_MODE" == "tunnel" ]]; then
  info "Caddy: HTTP-only режим (TLS терминирует Cloudflare на edge)"
  cat > /etc/caddy/Caddyfile <<EOF
{
  auto_https off
  email ${ADMIN_EMAIL}
  servers {
    trusted_proxies static private_ranges
  }
}

http://${APP_DOMAIN}:8080, http://www.${APP_DOMAIN}:8080 {
  root * ${LANDING_DIR}
  file_server
  encode zstd gzip
  header {
    X-Content-Type-Options "nosniff"
    X-Frame-Options "DENY"
    Referrer-Policy "strict-origin-when-cross-origin"
    -Server
  }
}

http://${CLOUD_DOMAIN}:8080 {
  reverse_proxy 127.0.0.1:3000 {
    header_up X-Real-IP {remote_host}
    header_up X-Forwarded-For {remote_host}
    header_up X-Forwarded-Proto https
    transport http {
      read_timeout 1h
      write_timeout 1h
    }
  }
  header {
    X-Content-Type-Options "nosniff"
    X-Frame-Options "DENY"
    Referrer-Policy "strict-origin-when-cross-origin"
    -Server
  }
  @healthz path /healthz /readyz
  log_skip @healthz
}
EOF
else
  info "Caddy: публичный HTTPS-режим (Let's Encrypt)"
  cat > /etc/caddy/Caddyfile <<EOF
{
  email ${ADMIN_EMAIL}
}

${APP_DOMAIN}, www.${APP_DOMAIN} {
  root * ${LANDING_DIR}
  file_server
  encode zstd gzip
  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    X-Content-Type-Options "nosniff"
    X-Frame-Options "DENY"
    Referrer-Policy "strict-origin-when-cross-origin"
    -Server
  }
}

${CLOUD_DOMAIN} {
  reverse_proxy 127.0.0.1:3000 {
    header_up X-Real-IP {remote_host}
    header_up X-Forwarded-For {remote_host}
    header_up X-Forwarded-Proto {scheme}
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
    -Server
  }
  @healthz path /healthz /readyz
  log_skip @healthz
}
EOF
fi

caddy validate --config /etc/caddy/Caddyfile
systemctl enable --now caddy
systemctl reload caddy
ok "Caddy запущен (режим: $CADDY_MODE)"

# ────────── cloudflared (Cloudflare Tunnel) ──────────

if [[ "$SKIP_TUNNEL_SETUP" == "1" ]]; then
  warn "SKIP_TUNNEL_SETUP=1 — пропускаю настройку cloudflared"
elif [[ -n "$CF_TUNNEL_TOKEN" ]]; then
  hdr "Установка cloudflared как сервиса (по token'у)"

  # `cloudflared service install <TOKEN>` ставит systemd-юнит cloudflared
  # и сохраняет креды в /etc/cloudflared/. Этот режим — для туннеля,
  # созданного в Cloudflare Zero Trust UI (Networks → Tunnels → Create).
  cloudflared service install "$CF_TUNNEL_TOKEN" || warn "cloudflared service install вернул ненулевой код — возможно, уже установлен"

  systemctl enable --now cloudflared
  systemctl restart cloudflared
  ok "cloudflared запущен"
  info "Маршрутизацию доменов на туннель настройте в Cloudflare Zero Trust UI:"
  info "  ${APP_DOMAIN}        → http://localhost:8080"
  info "  www.${APP_DOMAIN}    → http://localhost:8080"
  info "  ${CLOUD_DOMAIN}      → http://localhost:8080"
else
  hdr "Cloudflare Tunnel: ручная настройка"

  cat <<EOF
${C_YEL}CF_TUNNEL_TOKEN не задан — установка cloudflared отложена.${C_RESET}

Чтобы развернуть туннель:
  1. Cloudflare → Zero Trust → Networks → Tunnels → Create a tunnel.
  2. Выберите Cloudflared, дайте имя ($TUNNEL_NAME) и скопируйте Connector token.
  3. На сервере:
       sudo CF_TUNNEL_TOKEN=<token> bash $APP_DIR/deploy/install.sh
     (повторный прогон установит cloudflared, остальные шаги — идемпотентны).
  4. В Public hostnames туннеля добавьте маршруты:
       ${APP_DOMAIN}        → http://localhost:8080
       www.${APP_DOMAIN}    → http://localhost:8080
       ${CLOUD_DOMAIN}      → http://localhost:8080

См. подробности в deploy/dynamic-ip.md (variant B).
EOF
fi

# ────────── ufw ──────────

hdr "Firewall (ufw)"

if command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH || true
  # При Cloudflare Tunnel порт 80/443 наружу не открываем — туннель
  # инициирует исходящие соединения. Это и есть смысл сценария
  # «динамический IP без проброса портов».
  if [[ "$CADDY_MODE" == "public" ]]; then
    ufw allow 80/tcp  || true
    ufw allow 443/tcp || true
  fi
  yes | ufw enable >/dev/null 2>&1 || true
  ufw status
  ok "ufw настроен"
fi

# ────────── health-check ──────────

hdr "Health-check"

sleep 2
if curl -fsS --max-time 5 http://127.0.0.1:3000/healthz >/dev/null; then
  ok "tagcloud отвечает на /healthz"
else
  warn "Локально /healthz не отвечает — посмотрите journalctl -u tagcloud -n 200"
fi

if curl -fsS --max-time 5 http://127.0.0.1:8080/healthz >/dev/null \
   || curl -fsS --max-time 5 -H "Host: ${CLOUD_DOMAIN}" http://127.0.0.1:8080/healthz >/dev/null; then
  ok "Caddy проксирует на tagcloud"
else
  warn "Caddy не проксирует /healthz — посмотрите journalctl -u caddy"
fi

hdr "Готово"

cat <<EOF
${C_GRN}Установка завершена.${C_RESET}

Сервисы:
  systemctl status tagcloud
  systemctl status caddy
  systemctl status cloudflared        # если использовался Cloudflare Tunnel
  systemctl status postgresql redis-server

Логи:
  journalctl -u tagcloud -f
  journalctl -u caddy -f
  journalctl -u cloudflared -f

Дальнейшие шаги:
  * Cloudflare Zero Trust → Tunnels → ${TUNNEL_NAME} → Public hostnames:
      ${APP_DOMAIN}        → http://localhost:8080
      www.${APP_DOMAIN}    → http://localhost:8080
      ${CLOUD_DOMAIN}      → http://localhost:8080
  * Заполните SMTP_* в ${ENV_FILE} и перезапустите tagcloud.
  * Проверьте доступность https://${APP_DOMAIN} и https://${CLOUD_DOMAIN}.

Сайт landing:        https://${APP_DOMAIN}
Облако тегов:        https://${CLOUD_DOMAIN}
EOF
