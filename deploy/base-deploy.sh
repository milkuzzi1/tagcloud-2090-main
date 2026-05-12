#!/usr/bin/env bash
# Интерактивный мастер базового деплоя tagcloud.
#
# Что делает: ставит Node 22, postgres, redis, restic, git, системные либы
# для canvas, сервисного пользователя `tagcloud`, БД, клонирует репо в
# /opt/tagcloud, ставит зависимости (npm ci), собирает (npm run build),
# пишет /etc/tagcloud/tagcloud.env с реальными секретами, накатывает
# миграции, кладёт Caddyfile под выбранный сценарий dynamic-ip (A или B),
# ставит systemd-юнит, включает tagcloud и в конце дёргает /healthz.
#
# Предполагает, что `deploy/dynamic-ip-setup.sh` уже отработал:
#   - /etc/tagcloud/cloudflare.env существует и содержит CF_API_TOKEN
#     (+ CLOUDFLARE_API_TOKEN, CF_ZONE, CF_RECORDS для варианта A);
#   - caddy установлен (вариант A: с плагином caddy-dns/cloudflare)
#     ИЛИ cloudflared установлен и активен (вариант B);
#   - DNS-записи в Cloudflare уже указывают на сервер/тоннель.
#
# Скрипт показывает каждую команду перед выполнением и спрашивает:
# выполнить / пропустить / своя команда / назад / список / справка / выйти.
#
# Запуск:
#   bash deploy/base-deploy.sh
#
# Полезные переменные окружения:
#   DRY_RUN=1     — только показывать команды, ничего не выполнять.
#   NO_COLOR=1    — отключить ANSI-цвета.
#   ASSUME_YES=1  — отвечать «да» на все шаги (для CI / неинтерактивных
#                   прогонов; интерактивный ввод секретов пропускается,
#                   и в env-файл попадают плейсхолдеры — потом руками).
#
# Скрипт сам по себе не запускает sudo до тех пор, пока пользователь не
# подтвердит конкретный шаг.

set -uo pipefail

# ---------- цвета / форматирование ----------

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
    C_RESET=$'\033[0m'
    C_BOLD=$'\033[1m'
    C_DIM=$'\033[2m'
    C_RED=$'\033[31m'
    C_GREEN=$'\033[32m'
    C_YELLOW=$'\033[33m'
    C_BLUE=$'\033[34m'
    C_MAGENTA=$'\033[35m'
    C_CYAN=$'\033[36m'
else
    C_RESET=''
    C_BOLD=''
    C_DIM=''
    C_RED=''
    C_GREEN=''
    C_YELLOW=''
    C_BLUE=''
    C_MAGENTA=''
    C_CYAN=''
fi

say()   { printf '%s\n' "$*"; }
info()  { printf '%s[i]%s %s\n' "$C_CYAN"   "$C_RESET" "$*"; }
ok()    { printf '%s[ok]%s %s\n' "$C_GREEN"  "$C_RESET" "$*"; }
warn()  { printf '%s[!]%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
err()   { printf '%s[x]%s %s\n' "$C_RED"    "$C_RESET" "$*" >&2; }
hr()    { printf '%s%s%s\n' "$C_DIM" "────────────────────────────────────────────────────────────────────────" "$C_RESET"; }

# ---------- прогресс-бар ----------

progress_bar() {
    # progress_bar <done> <total>  →  "[██████░░░░░░░░░░░░░░] 30%"
    local done=$1 total=$2 width=20
    (( total > 0 )) || { printf '[%*s] --%%' "$width" ''; return; }
    local filled=$(( done * width / total ))
    (( filled > width )) && filled=$width
    local empty=$(( width - filled ))
    local pct=$(( done * 100 / total ))
    local bar=''
    local k
    for (( k=0; k<filled; k++ )); do bar+='█'; done
    for (( k=0; k<empty;  k++ )); do bar+='░'; done
    printf '[%s] %3d%%' "$bar" "$pct"
}

# ---------- шаги ----------

STEP_TITLES=()
STEP_CMDS=()

add_step() {
    STEP_TITLES+=("$1")
    STEP_CMDS+=("$2")
}

# ---------- ввод параметров ----------

ask_default() {
    local prompt=$1 default=$2 answer
    if [[ -n "${ASSUME_YES:-}" ]]; then
        printf '%s [%s]: %s (autoyes)\n' "$prompt" "$default" "$default" >&2
        printf '%s' "$default"
        return
    fi
    printf '%s%s%s [%s%s%s]: ' "$C_BOLD" "$prompt" "$C_RESET" "$C_DIM" "$default" "$C_RESET" >&2
    IFS= read -r answer </dev/tty || answer=''
    printf '%s' "${answer:-$default}"
}

ask_secret() {
    local prompt=$1 answer
    if [[ -n "${ASSUME_YES:-}" ]]; then
        printf '%s\n' "$prompt: (пропущено в ASSUME_YES)" >&2
        printf ''
        return
    fi
    printf '%s%s%s: ' "$C_BOLD" "$prompt" "$C_RESET" >&2
    IFS= read -rs answer </dev/tty || answer=''
    printf '\n' >&2
    printf '%s' "$answer"
}

# ---------- preflight ----------

CFENV=/etc/tagcloud/cloudflare.env

detect_variant() {
    # A — есть caddy и нет активного cloudflared;
    # B — есть активный cloudflared.
    # Если оба или ни одного — спрашиваем у пользователя.
    local has_caddy=0 has_cloudflared_active=0
    command -v caddy >/dev/null 2>&1 && has_caddy=1
    if systemctl is-active --quiet cloudflared 2>/dev/null; then
        has_cloudflared_active=1
    fi
    if (( has_cloudflared_active == 1 )); then
        printf 'B'
        return
    fi
    if (( has_caddy == 1 )); then
        printf 'A'
        return
    fi
    # Не определилось — пусть скажет руками.
    local choice
    printf '\n' >&2
    printf '%sНе нашёл следов dynamic-ip-setup.sh (нет caddy, нет cloudflared).%s\n' "$C_YELLOW" "$C_RESET" >&2
    printf 'Какой сценарий dynamic-ip предполагаем настроить?\n' >&2
    printf '  %sA%s) Caddy с DNS-01 (Cloudflare API).\n' "$C_GREEN" "$C_RESET" >&2
    printf '  %sB%s) Cloudflare Tunnel (cloudflared → :80 → tagcloud).\n' "$C_GREEN" "$C_RESET" >&2
    while :; do
        choice=$(ask_default "Вариант (A/B)" "B")
        case "${choice^^}" in
            A) printf 'A'; return ;;
            B) printf 'B'; return ;;
            *) warn "Введите A или B." ;;
        esac
    done
}

read_cf_zone() {
    # Достаём CF_ZONE из cloudflare.env, чтобы предложить домен по умолчанию.
    if [[ -r "$CFENV" ]]; then
        # shellcheck disable=SC1090
        (set -a; . "$CFENV" >/dev/null 2>&1; printf '%s' "${CF_ZONE:-}")
    fi
}

# ---------- описание шагов ----------

define_steps() {
    # define_steps <variant> <domain> <db_pass> <repo_url> <smtp_user>
    #              <smtp_pass> <smtp_from> <metrics_token>
    local variant=$1 domain=$2 db_pass=$3 repo_url=$4
    local smtp_user=$5 smtp_pass=$6 smtp_from=$7 metrics_token=$8

    # ---- системные пакеты ----

    add_step \
        "Обновить apt-индекс" \
        'sudo apt-get update'

    add_step \
        "Установить базовые пакеты (postgres, redis, restic, git, build-essential)" \
        'sudo apt-get install -y postgresql redis-server restic git build-essential ca-certificates curl gnupg'

    add_step \
        "Подключить NodeSource 22.x и поставить Node 22" \
        'curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs'

    add_step \
        "Системные либы для canvas (cairo/pango/jpeg/gif/rsvg/pkg-config)" \
        'sudo apt-get install -y --no-install-recommends \
  libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev pkg-config'

    add_step \
        "Запустить и включить postgres + redis" \
        'sudo systemctl enable --now postgresql redis-server'

    # ---- сервисный пользователь и каталоги ----

    add_step \
        "Создать сервисного пользователя tagcloud (если ещё нет)" \
        'id tagcloud >/dev/null 2>&1 || sudo useradd -r -s /usr/sbin/nologin tagcloud'

    add_step \
        "Создать /opt/tagcloud, /var/log/tagcloud, /etc/tagcloud (если нет) и выставить права" \
        'sudo install -d -m 755 -o tagcloud -g tagcloud /opt/tagcloud
sudo install -d -m 755 -o tagcloud -g tagcloud /var/log/tagcloud
sudo install -d -m 750 -o root     -g root     /etc/tagcloud'

    # ---- postgres: пользователь + БД ----
    # Идемпотентно: используем DO-блок с EXCEPTION, чтобы не падать на
    # повторном запуске. db_pass подставляется внешней "..." как литерал.
    # Внутренний heredoc квотирован, чтобы локальные ${...} в SQL не
    # схлопнулись повторно при bash -c "$cmd".

    add_step \
        "Создать роль и БД tagcloud в postgres" \
        "sudo -u postgres psql -v ON_ERROR_STOP=1 <<'SQL'
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tagcloud') THEN
    CREATE ROLE tagcloud LOGIN PASSWORD '${db_pass}';
  ELSE
    ALTER ROLE tagcloud WITH LOGIN PASSWORD '${db_pass}';
  END IF;
END
\$\$;
SELECT 'CREATE DATABASE tagcloud OWNER tagcloud'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='tagcloud')\\gexec
SQL"

    # ---- код, зависимости, сборка ----

    add_step \
        "Склонировать репозиторий в /opt/tagcloud (если ещё нет)" \
        "if [[ ! -d /opt/tagcloud/.git ]]; then
  sudo -u tagcloud git clone '${repo_url}' /opt/tagcloud
else
  echo '/opt/tagcloud/.git уже существует — git pull.'
  sudo -u tagcloud git -C /opt/tagcloud pull --ff-only
fi"

    add_step \
        "npm ci (зависимости, ~5 минут на свежем сервере)" \
        'sudo -u tagcloud bash -lc "cd /opt/tagcloud && npm ci"'

    add_step \
        "npm run build (SvelteKit → /opt/tagcloud/build)" \
        'sudo -u tagcloud bash -lc "cd /opt/tagcloud && npm run build"'

    # ---- /etc/tagcloud/tagcloud.env ----
    # Внешний "..." подставит domain/db_pass/smtp_*/metrics_token как
    # литералы. Внутренний heredoc — <<'TGENV', чтобы значения не
    # раскрывались повторно (см. PR #15).

    add_step \
        "Положить /etc/tagcloud/tagcloud.env (chmod 600, owner tagcloud)" \
        "sudo install -m 600 -o tagcloud -g tagcloud /dev/stdin /etc/tagcloud/tagcloud.env <<'TGENV'
# Сгенерировано base-deploy.sh. Полный список переменных и пояснения —
# deploy/tagcloud.env.example.

DATABASE_URL=postgres://tagcloud:${db_pass}@127.0.0.1:5432/tagcloud
PG_POOL_MAX=20
PG_IDLE_TIMEOUT_SEC=20
PG_CONNECT_TIMEOUT_SEC=5

REDIS_URL=redis://127.0.0.1:6379/0

SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=${smtp_user}
SMTP_PASSWORD=\"${smtp_pass}\"
SMTP_FROM=\"${smtp_from}\"

NODE_ENV=production
PORT=3000
HOST=127.0.0.1
ORIGIN=https://${domain}

UV_THREADPOOL_SIZE=16

ADDRESS_HEADER=X-Forwarded-For
PROTOCOL_HEADER=X-Forwarded-Proto
XFF_DEPTH=1

LOG_LEVEL=info

METRICS_TOKEN=${metrics_token}
TGENV"

    # ---- миграции ----
    # Запускаем под tagcloud, с DATABASE_URL из /etc/tagcloud/tagcloud.env.

    add_step \
        "Накатить миграции (drizzle, через npm run db:migrate)" \
        'sudo -u tagcloud bash -lc "set -a; . /etc/tagcloud/tagcloud.env; set +a; cd /opt/tagcloud && npm run db:migrate"'

    # ---- Caddyfile под выбранный вариант ----
    # Внешний "..." подставит domain. Внутренний heredoc — <<'CADDYFILE'.

    if [[ "$variant" == "A" ]]; then
        add_step \
            "Записать /etc/caddy/Caddyfile (вариант A: TLS через DNS-01)" \
            "sudo install -m 644 -o root -g root /dev/stdin /etc/caddy/Caddyfile <<'CADDYFILE'
{
    email admin@${domain}
}

${domain}, www.${domain} {
    tls {
        # DNS-01 challenge через Cloudflare API. Токен Caddy читает из
        # переменной среды CLOUDFLARE_API_TOKEN (см. systemctl edit caddy →
        # EnvironmentFile=/etc/tagcloud/cloudflare.env).
        dns cloudflare {env.CLOUDFLARE_API_TOKEN}
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

    header {
        Strict-Transport-Security \"max-age=31536000; includeSubDomains\"
        X-Content-Type-Options \"nosniff\"
        X-Frame-Options \"DENY\"
        Referrer-Policy \"strict-origin-when-cross-origin\"
        Permissions-Policy \"camera=(), microphone=(), geolocation=(), payment=()\"
        -Server
    }

    @healthz path /healthz /readyz
    log_skip @healthz

    @hidden path /.env /.git/*
    respond @hidden 404
}
CADDYFILE"
    else
        # Вариант B: TLS терминируется на Cloudflare, локальный Caddy
        # отдаёт plain HTTP по :80, к которому стучится cloudflared.
        add_step \
            "Установить caddy (если ещё не стоит) — нужен под cloudflared" \
            'command -v caddy >/dev/null 2>&1 \
  || (sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https \
      && curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
      && curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null \
      && sudo apt-get update && sudo apt-get install -y caddy)'

        add_step \
            "Записать /etc/caddy/Caddyfile (вариант B: plain :80 за cloudflared)" \
            "sudo install -m 644 -o root -g root /dev/stdin /etc/caddy/Caddyfile <<'CADDYFILE'
:80 {
    @hosts host ${domain} www.${domain}
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
            Strict-Transport-Security \"max-age=31536000; includeSubDomains\"
            X-Content-Type-Options \"nosniff\"
            X-Frame-Options \"DENY\"
            Referrer-Policy \"strict-origin-when-cross-origin\"
            Permissions-Policy \"camera=(), microphone=(), geolocation=(), payment=()\"
            -Server
        }

        @healthz path /healthz /readyz
        log_skip @healthz

        @hidden path /.env /.git/*
        respond @hidden 404
    }
}
CADDYFILE"
    fi

    add_step \
        "Перезагрузить Caddy с новым Caddyfile" \
        'sudo systemctl reload caddy || sudo systemctl restart caddy'

    # ---- systemd ----

    add_step \
        "Положить unit-файл tagcloud.service в /etc/systemd/system/" \
        'sudo install -m 644 -o root -g root /opt/tagcloud/deploy/tagcloud.service /etc/systemd/system/tagcloud.service
sudo systemctl daemon-reload'

    add_step \
        "Включить и запустить tagcloud" \
        'sudo systemctl enable --now tagcloud'

    # ---- проверки ----

    add_step \
        "Проверить, что tagcloud отвечает локально" \
        'sleep 2
curl -fsS http://127.0.0.1:3000/healthz && echo
curl -fsS http://127.0.0.1:3000/readyz  && echo
systemctl --no-pager --lines=5 status tagcloud'

    add_step \
        "Проверить, что домен отвечает снаружи" \
        "curl -fsS -I https://${domain}/healthz | head -n 5"
}

# ---------- интерактивное выполнение ----------

print_help_block() {
    cat <<EOF

${C_BOLD}Доступные действия на каждом шаге:${C_RESET}
  ${C_GREEN}y${C_RESET}  — выполнить команду
  ${C_YELLOW}s${C_RESET}  — пропустить (перейти к следующему шагу)
  ${C_MAGENTA}c${C_RESET}  — ввести свою команду (после выполнения вернёмся к этому же шагу)
  ${C_BLUE}b${C_RESET}  — назад, повторить предыдущий шаг
  ${C_DIM}l${C_RESET}  — показать список ВСЕХ шагов и их статус
  ${C_RED}q${C_RESET}  — выйти из мастера
  h  — показать эту справку

Подсказки:
  DRY_RUN=1 запустит мастер в режиме «только показать команды».
  ASSUME_YES=1 — отвечать «y» автоматически (для CI / неинтерактивных запусков).

EOF
}

print_step_banner() {
    local idx=$1 total=$2 title=$3
    hr
    printf '%sШаг %d/%d%s  %s\n' \
        "$C_BOLD" "$idx" "$total" "$C_RESET" \
        "$(progress_bar "$idx" "$total")"
    printf '%s%s%s\n' "$C_BOLD" "$title" "$C_RESET"
    hr
}

print_command_block() {
    local cmd=$1
    say "${C_DIM}# Команда:${C_RESET}"
    printf '%s' "$cmd" | sed -e "s/^/  ${C_CYAN}\$${C_RESET} /"
    say ''
}

run_command() {
    local cmd=$1
    if [[ -n "${DRY_RUN:-}" ]]; then
        warn "DRY_RUN: команда не выполнена."
        return 0
    fi
    bash -c "$cmd"
}

list_steps_status() {
    local total=$1 done_idx=$2
    local -n statuses=$3
    say ''
    say "${C_BOLD}Все шаги:${C_RESET}"
    local i
    for (( i=0; i<total; i++ )); do
        local marker
        case "${statuses[i]:-pending}" in
            done) marker="${C_GREEN}[done]${C_RESET}";;
            skip) marker="${C_YELLOW}[skip]${C_RESET}";;
            fail) marker="${C_RED}[fail]${C_RESET}";;
            *)    marker="${C_DIM}[    ]${C_RESET}";;
        esac
        local arrow=' '
        (( i == done_idx )) && arrow='>'
        printf '  %s %s %2d. %s\n' "$arrow" "$marker" "$((i+1))" "${STEP_TITLES[i]}"
    done
    say ''
}

# ---------- main ----------

main() {
    say ''
    say "${C_BOLD}${C_MAGENTA}tagcloud · мастер базового деплоя${C_RESET}"
    say "${C_DIM}Источник: deploy/README.md §1–8. Предполагает, что dynamic-ip-setup.sh уже отработал.${C_RESET}"
    say ''

    # ---- preflight ----
    if [[ ! -r "$CFENV" ]]; then
        warn "Не нашёл ${CFENV} — обычно это значит, что dynamic-ip-setup.sh ещё не прогоняли."
        warn "Если deploy не зависит от dynamic-ip, можно пропустить, но Caddy в варианте A потом не подхватит CLOUDFLARE_API_TOKEN."
    fi

    local variant default_domain domain db_pass repo_url
    local smtp_user smtp_pass smtp_from metrics_token

    variant=$(detect_variant)
    info "Сценарий dynamic-ip: ${C_BOLD}${variant}${C_RESET}"

    default_domain=$(read_cf_zone)
    [[ -z "$default_domain" ]] && default_domain="2090.fun"

    domain=$(ask_default "Домен" "$default_domain")
    repo_url=$(ask_default "URL репозитория (git clone)" "https://github.com/milkuzzi/tagcloud-2090-main")

    # Без URL-encoding: db_pass попадёт в postgres://tagcloud:${db_pass}@... и в SQL
    # CREATE ROLE ... PASSWORD '...'. Символы @ : / # ? ' сломают оба,
    # так что в prompt'е сразу же говорим об этом.
    db_pass=$(ask_secret "Пароль для роли postgres tagcloud (только A-Z a-z 0-9 . _ -)")
    [[ -z "$db_pass" ]] && db_pass="CHANGE_ME_DB_PASS"
    if [[ -n "$db_pass" && "$db_pass" =~ [^A-Za-z0-9._-] ]]; then
        warn "В пароле есть спецсимволы — они сломают DATABASE_URL или SQL CREATE ROLE."
        warn "Подберите URL-safe (без @ : / # ? ´ и пробелов) или потом отредактируйте вручную."
    fi

    smtp_user=$(ask_default "SMTP_USER (Gmail App Password owner)" "your-account@gmail.com")
    smtp_pass=$(ask_secret "SMTP_PASSWORD (App Password из https://myaccount.google.com/apppasswords)")
    [[ -z "$smtp_pass" ]] && smtp_pass="CHANGE_ME_SMTP_APP_PASSWORD"
    smtp_from=$(ask_default "SMTP_FROM" "Tagcloud <${smtp_user}>")

    # Сгенерируем METRICS_TOKEN автоматически, если есть openssl.
    if command -v openssl >/dev/null 2>&1; then
        metrics_token=$(openssl rand -hex 32 2>/dev/null || echo '')
    else
        metrics_token=''
    fi

    define_steps "$variant" "$domain" "$db_pass" "$repo_url" \
        "$smtp_user" "$smtp_pass" "$smtp_from" "$metrics_token"

    local total=${#STEP_CMDS[@]}
    if (( total == 0 )); then
        err "Не нашёл ни одного шага. Возможно, баг в скрипте."
        exit 1
    fi

    declare -a STATUSES
    local i
    for (( i=0; i<total; i++ )); do STATUSES+=("pending"); done

    say ''
    info "Сценарий: ${C_BOLD}${variant}${C_RESET}. Домен: ${C_BOLD}${domain}${C_RESET}. Всего шагов: ${C_BOLD}${total}${C_RESET}."
    [[ -n "${DRY_RUN:-}" ]] && warn "DRY_RUN=1 — команды показываются, но НЕ выполняются."
    print_help_block

    i=0
    while (( i < total )); do
        local cmd="${STEP_CMDS[i]}"
        local title="${STEP_TITLES[i]}"

        print_step_banner $((i+1)) "$total" "$title"
        print_command_block "$cmd"

        local choice
        if [[ -n "${ASSUME_YES:-}" ]]; then
            choice=y
            printf '> [autoyes] y\n'
        else
            printf '%s>%s выполнить [%sy%s] / пропустить [%ss%s] / своя команда [%sc%s] / назад [%sb%s] / список [%sl%s] / справка [%sh%s] / выйти [%sq%s]: ' \
                "$C_BOLD" "$C_RESET" \
                "$C_GREEN" "$C_RESET" \
                "$C_YELLOW" "$C_RESET" \
                "$C_MAGENTA" "$C_RESET" \
                "$C_BLUE" "$C_RESET" \
                "$C_DIM" "$C_RESET" \
                "$C_DIM" "$C_RESET" \
                "$C_RED" "$C_RESET"
            IFS= read -r choice </dev/tty || choice=q
            choice=${choice,,}
            [[ -z "$choice" ]] && choice=y
        fi

        case "$choice" in
            y|yes|да|д)
                if run_command "$cmd"; then
                    ok "Шаг $((i+1)) выполнен."
                    STATUSES[i]="done"
                else
                    err "Шаг $((i+1)) завершился с ошибкой (exit $?). Можно повторить (c — своя команда / b — назад) или пропустить."
                    STATUSES[i]="fail"
                    continue
                fi
                (( i++ ))
                ;;
            s|skip|n|no|нет|н)
                warn "Шаг $((i+1)) пропущен."
                STATUSES[i]="skip"
                (( i++ ))
                ;;
            c|custom|команда|к)
                printf '%sСвоя команда%s (несколько строк — закончите пустой строкой):\n' "$C_BOLD" "$C_RESET"
                local custom='' line
                while IFS= read -r line </dev/tty; do
                    [[ -z "$line" ]] && break
                    custom+="$line"$'\n'
                done
                if [[ -z "$custom" ]]; then
                    warn "Пустой ввод, остаёмся на шаге $((i+1))."
                    continue
                fi
                if [[ -n "${DRY_RUN:-}" ]]; then
                    warn "DRY_RUN: своя команда показана, но не выполнена."
                else
                    bash -c "$custom" || warn "Своя команда вернула не 0 (exit $?)."
                fi
                continue
                ;;
            b|back|назад|н2)
                if (( i == 0 )); then
                    warn "Это первый шаг, идти назад некуда."
                else
                    (( i-- ))
                    STATUSES[i]="pending"
                fi
                ;;
            l|list|список)
                list_steps_status "$total" "$i" STATUSES
                ;;
            h|help|справка|\?)
                print_help_block
                ;;
            q|quit|exit|выйти|в)
                warn "Выход по запросу пользователя на шаге $((i+1))/$total."
                break
                ;;
            *)
                warn "Не понял ответ «$choice». Введите h для справки."
                ;;
        esac
    done

    say ''
    hr
    say "${C_BOLD}Итог${C_RESET}"
    local done_n=0 skip_n=0 fail_n=0 pend_n=0
    for s in "${STATUSES[@]}"; do
        case "$s" in
            done) ((done_n++)) ;;
            skip) ((skip_n++)) ;;
            fail) ((fail_n++)) ;;
            *)    ((pend_n++)) ;;
        esac
    done
    printf '  выполнено: %s%d%s, пропущено: %s%d%s, с ошибкой: %s%d%s, не дошли: %s%d%s\n' \
        "$C_GREEN" "$done_n" "$C_RESET" \
        "$C_YELLOW" "$skip_n" "$C_RESET" \
        "$C_RED" "$fail_n" "$C_RESET" \
        "$C_DIM" "$pend_n" "$C_RESET"
    list_steps_status "$total" -1 STATUSES
    say ''
    say "${C_DIM}После успешного завершения:${C_RESET}"
    say "  - sudo systemctl status tagcloud caddy --no-pager"
    say "  - sudo journalctl -u tagcloud -f"
    say "  - curl -I https://${domain:-yourdomain.tld}/healthz"
    say ''
    say "${C_DIM}Если /healthz даёт 502 — проверьте journalctl -u tagcloud, скорее всего env-файл${C_RESET}"
    say "${C_DIM}не прошёл (DATABASE_URL, SMTP_*) или порт 3000 ещё не открылся.${C_RESET}"
}

main "$@"
