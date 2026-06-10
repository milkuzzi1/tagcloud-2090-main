#!/usr/bin/env bash
# Бэкап Postgres → restic-репозиторий (любой backend: B2, R2, S3, локальный).
#
# Зависимости: postgresql-client (pg_dump), restic.
# Конфиг — переменными окружения, см. deploy/backup.env.example.
#
# Запуск (вручную / из cron / systemd-timer):
#   /opt/tagcloud/scripts/ops/backup.sh
#
# Поведение:
#   1. pg_dump --format=custom (компактный + параллельный restore).
#   2. Поток пишется в restic backup --stdin --stdin-filename=postgres-$(ts).dump.
#   3. После успеха — restic forget с политикой хранения и prune.
#   4. Любая ошибка → exit 1, чтобы systemd-timer / cron засчитал FAIL.

set -euo pipefail

# --- обязательные env ---
: "${DATABASE_URL:?DATABASE_URL not set}"
: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY not set (e.g. b2:my-bucket:/tagcloud)}"
: "${RESTIC_PASSWORD:?RESTIC_PASSWORD not set}"

# --- опциональные env ---
RETAIN_DAILY="${RETAIN_DAILY:-7}"
RETAIN_WEEKLY="${RETAIN_WEEKLY:-4}"
RETAIN_MONTHLY="${RETAIN_MONTHLY:-6}"

ts="$(date -u +%Y%m%dT%H%M%SZ)"
filename="postgres-${ts}.dump"

echo "[backup] starting at ${ts}"

# Инициализируем репозиторий только если его реально нет. Раньше было
# `restic snapshots || restic init` — но `snapshots` падает и при битом/
# недоступном репозитории (неверный пароль, повреждение), и тогда `init`
# поверх существующего репо тоже завершится ошибкой, маскируя истинную
# причину. Отличаем «репо отсутствует» от «репо есть, но недоступно».
if ! restic snapshots >/dev/null 2>&1; then
    if restic cat config >/dev/null 2>&1; then
        echo "[backup] ERROR: репозиторий существует, но недоступен (пароль/повреждение)" >&2
        exit 1
    fi
    restic init
fi

# pg_dump → restic, без промежуточного файла на диске.
pg_dump --format=custom --compress=6 --no-owner --no-privileges "${DATABASE_URL}" \
    | restic backup --stdin --stdin-filename "${filename}" --tag "postgres" --tag "tagcloud"

echo "[backup] applying retention: ${RETAIN_DAILY}d / ${RETAIN_WEEKLY}w / ${RETAIN_MONTHLY}m"
restic forget --tag "postgres" \
    --keep-daily "${RETAIN_DAILY}" \
    --keep-weekly "${RETAIN_WEEKLY}" \
    --keep-monthly "${RETAIN_MONTHLY}" \
    --prune

echo "[backup] done"
