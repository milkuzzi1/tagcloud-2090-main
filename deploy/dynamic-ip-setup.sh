#!/usr/bin/env bash
# Интерактивная установка tagcloud на сервер с динамическим IP.
#
# Скрипт-обёртка вокруг deploy/dynamic-ip.md: проводит по шагам гайда,
# показывает каждую команду до выполнения и спрашивает подтверждение
# (выполнить / пропустить / своя команда / выйти / назад / показать всё).
#
# Запуск:
#   bash deploy/dynamic-ip-setup.sh
#
# Полезные переменные окружения:
#   DRY_RUN=1     — только показывать команды, ничего не выполнять.
#   NO_COLOR=1    — отключить ANSI-цвета.
#   ASSUME_YES=1  — отвечать «да» на все шаги (для неинтерактивных прогонов).
#                   Несовместимо с пунктами, которые требуют ручного ввода
#                   (например, «cloudflared tunnel login» откроет браузер).
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
# Регистрируем шаги массивами параллельных индексов. Каждый шаг —
# принадлежит фазе (common/A/B/post), имеет короткое название и
# тело команды (может быть многострочным, содержать heredoc, sudo,
# подстановку переменных).

STEP_PHASES=()
STEP_TITLES=()
STEP_CMDS=()

add_step() {
    STEP_PHASES+=("$1")
    STEP_TITLES+=("$2")
    STEP_CMDS+=("$3")
}

# ---------- ввод параметров ----------

ask_default() {
    # ask_default <prompt> <default>  — UI на stderr, значение на stdout.
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
    # ask_secret <prompt>  — читает без эха.
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

choose_variant() {
    # UI всегда на stderr — stdout содержит только итоговый выбор (A или B).
    printf '\n' >&2
    printf '%sКакой вариант разворачиваем?%s\n' "$C_BOLD" "$C_RESET" >&2
    printf '  %sA%s) DDNS на Cloudflare + проброс 80/443 на роутере (нужен «честный» IP).\n' "$C_GREEN" "$C_RESET" >&2
    printf '  %sB%s) Cloudflare Tunnel (работает за CGNAT, порты пробрасывать не надо).\n' "$C_GREEN" "$C_RESET" >&2
    printf '  %sНе уверены? Сравните  curl -s https://api.ipify.org  с WAN-IP роутера.%s\n' "$C_DIM" "$C_RESET" >&2
    local choice
    while :; do
        choice=$(ask_default "Вариант (A/B)" "B")
        case "${choice^^}" in
            A) printf 'A'; return ;;
            B) printf 'B'; return ;;
            *) warn "Введите A или B." ;;
        esac
    done
}

# ---------- описание шагов гайда ----------

define_steps() {
    # define_steps <variant> <domain> <records> <cf_token> <tunnel> <www_domain>
    local variant=$1 domain=$2 records=$3 cf_token=$4 tunnel=$5 www="$6"

    # ---- общие шаги (Cloudflare API token + /etc/tagcloud) ----

    add_step common \
        "Создать каталог /etc/tagcloud для конфигов и токена" \
        'sudo install -d -m 750 -o root -g root /etc/tagcloud'

    # Намеренно <<'EOF' (квотированный heredoc): внешний "..." уже подставил
    # ${domain} и ${cf_token} как литералы. Без кавычек bash -c "$cmd" на
    # сервере раскроет их второй раз — токен с $/`/\ поломается.
    add_step common \
        "Положить Cloudflare API token в /etc/tagcloud/cloudflare.env (chmod 600)" \
        "sudo install -m 600 -o root -g root /dev/stdin /etc/tagcloud/cloudflare.env <<'EOF'
# Cloudflare API token (Edit zone DNS на ${domain})
CF_API_TOKEN=${cf_token}
# Дублируем под именем для caddy-dns/cloudflare:
CLOUDFLARE_API_TOKEN=${cf_token}
EOF"

    # ---- Вариант A ----

    add_step A \
        "Установить curl + jq (нужны DDNS-скрипту)" \
        'sudo apt-get update && sudo apt-get install -y curl jq'

    add_step A \
        "Установить /usr/local/bin/cf-ddns.sh (DDNS-обновлятор)" \
        "sudo install -m 750 -o root -g root /dev/stdin /usr/local/bin/cf-ddns.sh <<'EOF'
#!/usr/bin/env bash
# Обновляет A-запись в Cloudflare на текущий публичный IP. Идемпотентно.
set -euo pipefail

# shellcheck disable=SC1091
. /etc/tagcloud/cloudflare.env

: \"\${CF_API_TOKEN:?CF_API_TOKEN not set}\"
: \"\${CF_ZONE:?CF_ZONE not set (например, 2090.fun)}\"
: \"\${CF_RECORDS:?CF_RECORDS not set (через пробел: 2090.fun www.2090.fun)}\"

CURRENT_IP=\"\$(curl -fsS --max-time 10 https://api.ipify.org \\
  || curl -fsS --max-time 10 https://ifconfig.co)\"
[[ -n \"\$CURRENT_IP\" ]] || { echo \"no public IP detected\" >&2; exit 1; }

api() { curl -fsS -H \"Authorization: Bearer \${CF_API_TOKEN}\" \\
              -H \"Content-Type: application/json\" \"\$@\"; }

ZONE_ID=\"\$(api \"https://api.cloudflare.com/client/v4/zones?name=\${CF_ZONE}\" \\
  | jq -r '.result[0].id')\"
[[ -n \"\$ZONE_ID\" && \"\$ZONE_ID\" != \"null\" ]] || { echo \"zone \${CF_ZONE} not found\" >&2; exit 1; }

for NAME in \$CF_RECORDS; do
  REC_JSON=\"\$(api \"https://api.cloudflare.com/client/v4/zones/\${ZONE_ID}/dns_records?type=A&name=\${NAME}\")\"
  REC_ID=\"\$(echo \"\$REC_JSON\" | jq -r '.result[0].id // empty')\"
  REC_IP=\"\$(echo  \"\$REC_JSON\" | jq -r '.result[0].content // empty')\"

  PAYLOAD=\"\$(jq -n --arg n \"\$NAME\" --arg ip \"\$CURRENT_IP\" \\
    '{type:\"A\", name:\$n, content:\$ip, ttl:120, proxied:false}')\"

  if [[ -z \"\$REC_ID\" ]]; then
    echo \"[ddns] create \${NAME} → \${CURRENT_IP}\"
    api -X POST \"https://api.cloudflare.com/client/v4/zones/\${ZONE_ID}/dns_records\" \\
      --data \"\$PAYLOAD\" >/dev/null
  elif [[ \"\$REC_IP\" != \"\$CURRENT_IP\" ]]; then
    echo \"[ddns] update \${NAME}: \${REC_IP} → \${CURRENT_IP}\"
    api -X PUT \"https://api.cloudflare.com/client/v4/zones/\${ZONE_ID}/dns_records/\${REC_ID}\" \\
      --data \"\$PAYLOAD\" >/dev/null
  else
    echo \"[ddns] \${NAME} up-to-date (\${CURRENT_IP})\"
  fi
done
EOF"

    # Квотированный heredoc: domain/records уже подставлены внешним "...".
    add_step A \
        "Дописать зону и список записей в /etc/tagcloud/cloudflare.env" \
        "sudo tee -a /etc/tagcloud/cloudflare.env >/dev/null <<'EOF'
CF_ZONE=${domain}
# Записи, которые обновляем при смене IP. Через пробел.
CF_RECORDS=\"${records}\"
EOF"

    # Квотированный heredoc: domain уже подставлен внешним "...".
    add_step A \
        "Создать systemd-юнит cf-ddns.service" \
        "sudo tee /etc/systemd/system/cf-ddns.service >/dev/null <<'EOF'
[Unit]
Description=Cloudflare DDNS update for ${domain}
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
EnvironmentFile=/etc/tagcloud/cloudflare.env
ExecStart=/usr/local/bin/cf-ddns.sh
EOF"

    add_step A \
        "Создать systemd-таймер cf-ddns.timer (раз в 5 минут)" \
        "sudo tee /etc/systemd/system/cf-ddns.timer >/dev/null <<'EOF'
[Unit]
Description=Run Cloudflare DDNS update every 5 minutes

[Timer]
OnBootSec=30s
OnUnitActiveSec=5min
Unit=cf-ddns.service
Persistent=true

[Install]
WantedBy=timers.target
EOF"

    add_step A \
        "Перечитать systemd + включить таймер + первый прогон" \
        'sudo systemctl daemon-reload
sudo systemctl enable --now cf-ddns.timer
sudo systemctl start cf-ddns.service
journalctl -u cf-ddns.service -n 20 --no-pager'

    add_step A \
        "Проверить, что DNS теперь указывает на текущий IP" \
        "dig +short ${domain}
curl -s https://api.ipify.org && echo"

    add_step A \
        "Установить Go и xcaddy (нужны, чтобы собрать Caddy с DNS-плагином)" \
        'sudo apt-get install -y golang-go
sudo curl -fsSLo /usr/local/bin/xcaddy \
  https://github.com/caddyserver/xcaddy/releases/latest/download/xcaddy_linux_amd64
sudo chmod +x /usr/local/bin/xcaddy'

    add_step A \
        "Собрать caddy с github.com/caddy-dns/cloudflare и установить в /usr/local/bin/caddy" \
        'sudo xcaddy build --with github.com/caddy-dns/cloudflare \
  --output /usr/local/bin/caddy
sudo setcap cap_net_bind_service=+ep /usr/local/bin/caddy'

    add_step A \
        "Подменить ExecStart в caddy.service (откроет редактор)" \
        'sudo systemctl edit caddy
# В редакторе вставьте:
#   [Service]
#   ExecStart=
#   ExecStart=/usr/local/bin/caddy run --environ --config /etc/caddy/Caddyfile'

    add_step A \
        "Прокинуть Cloudflare token в caddy через EnvironmentFile (откроет редактор)" \
        'sudo systemctl edit caddy
# В редакторе вставьте:
#   [Service]
#   EnvironmentFile=/etc/tagcloud/cloudflare.env'

    add_step A \
        "Перезапустить caddy и убедиться, что сертификат выписался" \
        "sudo systemctl daemon-reload
sudo systemctl restart caddy
sleep 2
sudo journalctl -u caddy -n 50 --no-pager | grep -E 'obtain|certificate' || true
curl -sI https://${domain} | head -n 1"

    add_step A \
        "Настроить firewall (ufw): открыть только 22/80/443" \
        'sudo apt-get install -y ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow ssh
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
sudo ufw status verbose'

    # ---- Вариант B ----

    # shellcheck disable=SC2016 # $(...) должен раскрываться внутри bash -c на сервере, а не здесь.
    add_step B \
        "Подключить официальный apt-репозиторий Cloudflare" \
        'sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] \
https://pkg.cloudflare.com/cloudflared $(. /etc/os-release && echo "$VERSION_CODENAME") main" \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update
sudo apt-get install -y cloudflared'

    add_step B \
        "Залогиниться в Cloudflare (откроет браузер; выберите зону)" \
        "sudo cloudflared tunnel login"

    add_step B \
        "Создать тоннель «${tunnel}»" \
        "sudo cloudflared tunnel create ${tunnel}
# В выводе будет ID тоннеля и путь до credentials JSON
# (обычно /root/.cloudflared/<UUID>.json) — запомните его."

    add_step B \
        "Привязать DNS-имена ${domain} и ${www} к тоннелю" \
        "sudo cloudflared tunnel route dns ${tunnel} ${domain}
sudo cloudflared tunnel route dns ${tunnel} ${www}"

    add_step B \
        "Скопировать credentials JSON в /etc/cloudflared/${tunnel}.json (введите путь когда подскажу)" \
        "sudo install -d -m 700 /etc/cloudflared
read -rp 'Путь к credentials JSON, который вернул tunnel create: ' CREDS
sudo install -m 600 \"\$CREDS\" /etc/cloudflared/${tunnel}.json"

    # Квотированный heredoc: tunnel/domain/www уже подставлены внешним "...".
    add_step B \
        "Записать /etc/cloudflared/config.yml" \
        "sudo tee /etc/cloudflared/config.yml >/dev/null <<'EOF'
tunnel: ${tunnel}
credentials-file: /etc/cloudflared/${tunnel}.json

ingress:
  - hostname: ${domain}
    service: http://127.0.0.1:80
    originRequest:
      noTLSVerify: true
      connectTimeout: 30s
      tlsTimeout: 30s
      tcpKeepAlive: 30s
      keepAliveTimeout: 1h
      noHappyEyeballs: true
  - hostname: ${www}
    service: http://127.0.0.1:80
  - service: http_status:404
EOF"

    add_step B \
        "Установить systemd-юнит cloudflared и включить" \
        'sudo cloudflared --config /etc/cloudflared/config.yml service install
sudo systemctl enable --now cloudflared
sudo systemctl status cloudflared --no-pager | head -n 20'

    add_step B \
        "Проверить, что cloudflared поднял ≥2 коннекта к edge" \
        'sudo journalctl -u cloudflared -n 100 --no-pager | grep -iE "Registered tunnel connection|connector" | tail -n 10'

    add_step B \
        "Зажать firewall (ufw): SSH остаётся, 80/443 наружу не нужны" \
        'sudo apt-get install -y ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow ssh
sudo ufw deny 80/tcp
sudo ufw deny 443/tcp
sudo ufw --force enable
sudo ufw status verbose'

    # ---- финальные проверки (общие) ----

    add_step post \
        "DNS: dig +short ${domain}" \
        "dig +short ${domain}"

    add_step post \
        "Сертификат + статус-коды HTTPS" \
        "curl -sIL https://${domain} | head -n 5
echo | openssl s_client -connect ${domain}:443 -servername ${domain} 2>/dev/null \\
  | openssl x509 -noout -issuer -subject -dates"

    add_step post \
        "Приложение отвечает на /healthz и /readyz" \
        "curl -s https://${domain}/healthz; echo
curl -s https://${domain}/readyz | jq . || true"

    add_step post \
        "Статус всех ключевых сервисов" \
        'systemctl status tagcloud caddy cf-ddns.timer cloudflared 2>&1 \
  | grep -E "Active|●" || true'
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
    local idx=$1 total=$2 title=$3 phase=$4
    hr
    printf '%sШаг %d/%d%s  %s  %sфаза:%s %s\n' \
        "$C_BOLD" "$idx" "$total" "$C_RESET" \
        "$(progress_bar "$idx" "$total")" \
        "$C_DIM" "$C_RESET" "$phase"
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
        printf '  %s %s %2d. %s\n' "$arrow" "$marker" "$((i+1))" "${FILTERED_TITLES[i]}"
    done
    say ''
}

# ---------- main ----------

main() {
    say ''
    say "${C_BOLD}${C_MAGENTA}tagcloud · мастер развёртывания на сервере с динамическим IP${C_RESET}"
    say "${C_DIM}Источник: deploy/dynamic-ip.md. Гайд можно открыть в соседнем терминале.${C_RESET}"
    say ''

    local variant domain www records cf_token tunnel
    variant=$(choose_variant)
    domain=$(ask_default "Домен" "2090.fun")
    www="www.${domain}"
    records=$(ask_default "Cloudflare A-записи через пробел" "${domain} ${www}")
    tunnel=$(ask_default "Имя Cloudflare Tunnel" "tagcloud")
    cf_token=$(ask_secret "Cloudflare API token (Edit zone DNS, можно пустым — впишете позже)")

    [[ -z "$cf_token" ]] && cf_token="ВАШ_ТОКЕН"

    define_steps "$variant" "$domain" "$records" "$cf_token" "$tunnel" "$www"

    # Отфильтровать шаги по выбранному варианту: common + (A или B) + post.
    FILTERED_PHASES=()
    FILTERED_TITLES=()
    FILTERED_CMDS=()
    local total_all=${#STEP_PHASES[@]} i
    for (( i=0; i<total_all; i++ )); do
        local p=${STEP_PHASES[i]}
        if [[ "$p" == "common" || "$p" == "post" || "$p" == "$variant" ]]; then
            FILTERED_PHASES+=("$p")
            FILTERED_TITLES+=("${STEP_TITLES[i]}")
            FILTERED_CMDS+=("${STEP_CMDS[i]}")
        fi
    done

    local total=${#FILTERED_CMDS[@]}
    if (( total == 0 )); then
        err "Не нашёл ни одного шага. Возможно, баг в скрипте."
        exit 1
    fi

    declare -a STATUSES
    for (( i=0; i<total; i++ )); do STATUSES+=("pending"); done

    say ''
    info "Вариант: ${C_BOLD}${variant}${C_RESET}. Домен: ${C_BOLD}${domain}${C_RESET}. Всего шагов: ${C_BOLD}${total}${C_RESET}."
    [[ -n "${DRY_RUN:-}" ]] && warn "DRY_RUN=1 — команды показываются, но НЕ выполняются."
    print_help_block

    i=0
    while (( i < total )); do
        local cmd="${FILTERED_CMDS[i]}"
        local title="${FILTERED_TITLES[i]}"
        local phase="${FILTERED_PHASES[i]}"

        print_step_banner $((i+1)) "$total" "$title" "$phase"
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
                # остаёмся на этом же шаге, чтобы пользователь мог продолжить.
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
    say "${C_DIM}Не забудьте про шаги, которые описаны в deploy/dynamic-ip.md словами${C_RESET}"
    say "${C_DIM}(например, проброс портов на роутере или Cloudflare SSL=Full).${C_RESET}"
}

main "$@"
