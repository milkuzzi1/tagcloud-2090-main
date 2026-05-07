# Деплой tagcloud на Windows 10 (домен `2090.fun`, динамический IP)

Этот гайд — Windows-эквивалент `deploy/dynamic-ip.md`. Делаем то же самое
(domain + dynamic-IP self-host), но на Windows 10 (или 11 — все команды
совместимы).

> Везде в примерах домен — `2090.fun`. Замените на свой, если другой.

## TL;DR — какой путь выбрать

Production-стек tagcloud (Postgres + Redis + Node + Postfix + systemd) —
Linux-нативный. На Windows есть два рабочих пути:

| Путь | Когда выбирать |
|---|---|
| **Вариант 1.** WSL2 + Ubuntu внутри Windows. | Рекомендуется в 90% случаев. Минимальные отличия от Linux-гайда, тот же `deploy/dynamic-ip.md` работает почти как есть. |
| **Вариант 2.** Чистый Windows: Node, Postgres, Caddy, cloudflared — нативно как Windows-сервисы. | Когда WSL запретил админ / антивирус / корпоративная политика; или нужно интегрироваться с Windows-AD. Дороже по поддержке. |

Ниже — оба варианта, по порядку.

## Содержание

- [Подготовка домена `2090.fun` в Cloudflare](#подготовка-домена-2090fun-в-cloudflare)
- [Вариант 1. WSL2 + Ubuntu (рекомендуется)](#вариант-1-wsl2--ubuntu-рекомендуется)
  - [1.1. Установка WSL2 и Ubuntu 22.04](#11-установка-wsl2-и-ubuntu-2204)
  - [1.2. Включение systemd в WSL](#12-включение-systemd-в-wsl)
  - [1.3. Установка стека внутри WSL](#13-установка-стека-внутри-wsl)
  - [1.4. Проброс портов Windows → WSL](#14-проброс-портов-windows--wsl)
  - [1.5. Windows Firewall](#15-windows-firewall)
  - [1.6. Автозапуск WSL и сервисов при загрузке Windows](#16-автозапуск-wsl-и-сервисов-при-загрузке-windows)
- [Вариант 2. Чистый Windows](#вариант-2-чистый-windows)
  - [2.1. Установка зависимостей](#21-установка-зависимостей)
  - [2.2. Сборка приложения](#22-сборка-приложения)
  - [2.3. Postgres для Windows](#23-postgres-для-windows)
  - [2.4. Redis для Windows (Memurai)](#24-redis-для-windows-memurai)
  - [2.5. Регистрация Node как Windows-службы (NSSM)](#25-регистрация-node-как-windows-службы-nssm)
  - [2.6. Caddy с DNS-01 challenge как Windows-служба](#26-caddy-с-dns-01-challenge-как-windows-служба)
  - [2.7. DDNS на PowerShell + Task Scheduler](#27-ddns-на-powershell--task-scheduler)
  - [2.8. Cloudflare Tunnel как Windows-служба](#28-cloudflare-tunnel-как-windows-служба)
  - [2.9. Почта через smarthost напрямую из приложения](#29-почта-через-smarthost-напрямую-из-приложения)
  - [2.10. Бэкап Postgres → restic + Task Scheduler](#210-бэкап-postgres--restic--task-scheduler)
  - [2.11. Windows Defender Firewall](#211-windows-defender-firewall)
- [Проверки после деплоя](#проверки-после-деплоя)
- [Траблшутинг](#траблшутинг)

## Подготовка домена `2090.fun` в Cloudflare

Шаги совпадают с `deploy/dynamic-ip.md`:

1. В админке регистратора домена смените NS-серверы на cloudflare-овские.
2. В Cloudflare создаётся пустая зона `2090.fun`.
3. Создайте API-токен Cloudflare с правами **Edit zone DNS** только для
   зоны `2090.fun`: https://dash.cloudflare.com/profile/api-tokens
4. Сохраните токен — он понадобится и для DDNS, и для Caddy DNS-01, и
   (опционально) для cloudflared.

Дальнейшие шаги зависят от выбранного варианта.

## Вариант 1. WSL2 + Ubuntu (рекомендуется)

### 1.1. Установка WSL2 и Ubuntu 22.04

Откройте PowerShell **как Администратор**:

```powershell
# Включить компоненты WSL и Virtual Machine Platform + поставить Ubuntu 22.04.
wsl --install -d Ubuntu-22.04
# Перезагрузка обязательна после первого запуска (Windows предложит).
```

После перезагрузки откроется окно Ubuntu — задайте имя пользователя и
пароль (например, `tagcloud` / любой). Это будет sudo-юзер внутри WSL.

Проверка:

```powershell
wsl --list --verbose
# Имя           Состояние    Версия
# Ubuntu-22.04  Running      2
wsl -d Ubuntu-22.04 -- bash -c 'cat /etc/os-release | head -2'
```

### 1.2. Включение systemd в WSL

WSL2 поддерживает systemd с Windows 11 22H2 / Windows 10 21H2+. Без
него `tagcloud.service`, `cf-ddns.timer`, `caddy` не запустятся как
службы.

В Ubuntu (`wsl -d Ubuntu-22.04`):

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true

[network]
generateHosts=true
generateResolvConf=true
EOF
```

Перезагрузите WSL из PowerShell:

```powershell
wsl --shutdown
wsl -d Ubuntu-22.04 -- bash -c 'systemctl is-system-running --wait || true'
# Должно вернуть "running" или "degraded" (degraded ок — отдельные юниты не критичны).
```

### 1.3. Установка стека внутри WSL

Дальше работаем в Ubuntu (`wsl -d Ubuntu-22.04`) и применяем
`deploy/README.md` + `deploy/dynamic-ip.md` **без изменений**:

```bash
# Системные пакеты, Postgres, Redis, Caddy, Node 22, Postfix, OpenDKIM:
sudo apt update
sudo apt install -y postgresql redis-server caddy restic \
  postfix opendkim opendkim-tools mailutils curl jq
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt install -y nodejs

# Сервисный пользователь, каталоги, клон репозитория, npm ci, build:
sudo useradd -r -s /usr/sbin/nologin tagcloud
sudo mkdir -p /opt/tagcloud /etc/tagcloud /var/log/tagcloud
sudo chown -R tagcloud:tagcloud /opt/tagcloud /var/log/tagcloud
sudo -u tagcloud git clone https://github.com/milkuzzi/tagcloud-2090-main /opt/tagcloud
cd /opt/tagcloud
sudo -u tagcloud npm ci
sudo -u tagcloud npm run build

# DDNS, Caddy DNS-01, smarthost-почта — всё по deploy/dynamic-ip.md.
```

В `tagcloud.env` задайте `HOST=0.0.0.0` (а не `127.0.0.1`), чтобы Node
слушал на всех интерфейсах внутри WSL — `netsh portproxy` с Windows
будет ходить на IP WSL, а не на её loopback.

```ini
HOST=0.0.0.0
PORT=3000
```

Аналогично, в `Caddyfile` (если используется) лучше слушать на
`:443` без явного bind на loopback.

### 1.4. Проброс портов Windows → WSL

WSL2 — это виртуалка с собственной NAT-сетью. Чтобы запросы из интернета
дошли до Caddy/Node внутри WSL, нужен `netsh portproxy` на Windows-хосте.

Откройте PowerShell **как Администратор**:

```powershell
# Получаем актуальный IP WSL (он меняется при каждом старте).
$wslIp = (wsl -d Ubuntu-22.04 -- hostname -I).Trim().Split()[0]
Write-Host "WSL IP: $wslIp"

# Проброс 80 и 443 на Caddy внутри WSL.
netsh interface portproxy reset
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=80  connectaddress=$wslIp connectport=80
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=443 connectaddress=$wslIp connectport=443

# (опционально) посмотреть текущие правила:
netsh interface portproxy show all
```

> IP WSL меняется при каждом `wsl --shutdown` / перезагрузке Windows.
> Чтобы автоматизировать переподключение — см. секцию 1.6 ниже,
> в Task Scheduler-задачу добавлен скрипт обновления portproxy.

### 1.5. Windows Firewall

```powershell
# Разрешаем 80 и 443 с любого источника на ВСЕХ профилях (Public/Private/Domain).
New-NetFirewallRule -DisplayName "tagcloud http"  -Direction Inbound -Protocol TCP -LocalPort 80  -Action Allow -Profile Any
New-NetFirewallRule -DisplayName "tagcloud https" -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow -Profile Any
```

> SSH/RDP в правила не трогаем — они либо уже открыты, либо вы решаете
> отдельно.

### 1.6. Автозапуск WSL и сервисов при загрузке Windows

WSL не запускается автоматически при логине — нужен Task Scheduler.
Скрипт ниже стартует Ubuntu, ждёт пока systemd поднимет сервисы внутри,
и обновляет `netsh portproxy` под текущий IP WSL.

Сохраните как `C:\tagcloud\start-wsl.ps1` (создайте папку):

```powershell
# Запускает WSL Ubuntu, ждёт systemd, перенастраивает portproxy.
$ErrorActionPreference = 'Stop'

# Подождём, пока сеть Windows будет готова.
Start-Sleep -Seconds 10

# Прогрев WSL (запустит дистрибутив в фоне).
wsl -d Ubuntu-22.04 -- bash -c 'systemctl is-system-running --wait || true' | Out-Null

# Получаем актуальный IP WSL и обновляем portproxy.
$wslIp = (wsl -d Ubuntu-22.04 -- hostname -I).Trim().Split()[0]
"$(Get-Date -Format o) WSL IP: $wslIp" | Out-File C:\tagcloud\start-wsl.log -Append

netsh interface portproxy reset
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=80  connectaddress=$wslIp connectport=80
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=443 connectaddress=$wslIp connectport=443
```

Создайте задачу в Task Scheduler:

```powershell
$action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument '-NoProfile -ExecutionPolicy Bypass -File C:\tagcloud\start-wsl.ps1'
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName 'tagcloud-start-wsl' `
    -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
    -Description 'Start WSL Ubuntu + refresh portproxy for tagcloud at boot'
```

Проверка после reboot:

```powershell
Get-ScheduledTask -TaskName 'tagcloud-start-wsl' | Get-ScheduledTaskInfo
netsh interface portproxy show all
Test-NetConnection -ComputerName localhost -Port 443
```

Дальше — заходим в WSL и применяем **`deploy/dynamic-ip.md` целиком**:
DDNS, Caddy с DNS-01, smarthost-почта (`Resend`/`Brevo`/`Mailgun`/`SES`).
Никаких отличий от обычного Linux-деплоя.

## Вариант 2. Чистый Windows

Когда WSL запрещён или не подходит — всё ставим как нативные Windows-приложения.
В этом варианте Postfix/OpenDKIM **не ставится** (нет нормальной Windows-сборки),
поэтому почта идёт напрямую через smarthost из приложения (`SMTP_HOST=smtp.resend.com`
вместо `127.0.0.1`).

### 2.1. Установка зависимостей

Удобнее всего — через [Chocolatey](https://chocolatey.org/install) или
[Scoop](https://scoop.sh/), но можно и вручную с сайтов вендоров.

PowerShell как Администратор:

```powershell
# Chocolatey (установка): https://chocolatey.org/install
Set-ExecutionPolicy Bypass -Scope Process -Force
[System.Net.ServicePointManager]::SecurityProtocol =
    [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))

# Стек:
choco install -y nodejs-lts git postgresql16 caddy nssm restic jq
# Redis для Windows: используем Memurai (drop-in replacement, под Windows
# Server / Windows 10 Pro). Для Home Edition — поднимайте Redis в WSL.
choco install -y memurai-developer
```

Версии:

```powershell
node --version          # v22.x
git --version
caddy version
psql --version
nssm version
```

### 2.2. Сборка приложения

```powershell
# Папка для приложения.
New-Item -ItemType Directory -Force -Path C:\tagcloud
cd C:\tagcloud

# Клон + сборка.
git clone https://github.com/milkuzzi/tagcloud-2090-main app
cd app
npm ci
npm run build
# adapter-node положит сборку в ./build, точка входа — build\index.js.
```

Создайте `C:\tagcloud\tagcloud.env` (UTF-8 без BOM):

```ini
DATABASE_URL=postgres://tagcloud:CHANGE_ME@127.0.0.1:5432/tagcloud
PG_POOL_MAX=20
PG_IDLE_TIMEOUT_SEC=20
PG_CONNECT_TIMEOUT_SEC=5

REDIS_URL=redis://127.0.0.1:6379/0

# Почта через smarthost — без локального Postfix.
SMTP_HOST=smtp.resend.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=resend
SMTP_PASSWORD=re_СЕКРЕТНЫЙ_API_KEY
SMTP_FROM="Tagcloud <noreply@2090.fun>"

NODE_ENV=production
PORT=3000
HOST=127.0.0.1
ORIGIN=https://2090.fun

UV_THREADPOOL_SIZE=16
ADDRESS_HEADER=X-Forwarded-For
PROTOCOL_HEADER=X-Forwarded-Proto
XFF_DEPTH=1

LOG_LEVEL=info
METRICS_TOKEN=
```

> Файл содержит пароль БД и API-ключ smarthost. Уберите наследование
> прав у `Users`/`Authenticated Users`, оставьте только Администраторов
> и сервис-аккаунт, под которым крутится Node.

### 2.3. Postgres для Windows

После `choco install postgresql16` мастер пропишет суперпользователя
`postgres` (пароль попросит на установке). Создайте БД и роль:

```powershell
# Подключаемся под postgres (попросит пароль из инсталлятора).
& "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -h localhost
```

В `psql`:

```sql
CREATE USER tagcloud WITH PASSWORD 'CHANGE_ME';
CREATE DATABASE tagcloud OWNER tagcloud;
\q
```

Применяем миграции:

```powershell
cd C:\tagcloud\app
$env:DATABASE_URL = 'postgres://tagcloud:CHANGE_ME@127.0.0.1:5432/tagcloud'
npm run db:migrate
```

### 2.4. Redis для Windows (Memurai)

Memurai — коммерческий Redis-совместимый сервер от компании Janea
(developer-edition бесплатна для не-production до Windows 10 Pro).
После `choco install memurai-developer` служба `Memurai` уже запущена и
слушает `127.0.0.1:6379`.

```powershell
Get-Service Memurai
"PING" | & "C:\Program Files\Memurai\memurai-cli.exe"
# +PONG
```

Для Windows Home — поставьте Redis внутри WSL (`sudo apt install
redis-server`) и выставьте в `tagcloud.env` `REDIS_URL=redis://<WSL_IP>:6379/0`.

### 2.5. Регистрация Node как Windows-службы (NSSM)

NSSM (Non-Sucking Service Manager) превращает любую программу в
Windows-службу с auto-restart, лог-файлами и graceful shutdown.

```powershell
# Создаём службу.
nssm install tagcloud "C:\Program Files\nodejs\node.exe" "C:\tagcloud\app\build\index.js"

# Рабочий каталог.
nssm set tagcloud AppDirectory C:\tagcloud\app

# Загружаем переменные окружения из tagcloud.env.
# NSSM умеет читать только key=value по строкам, без комментариев — поэтому
# даём ему «очищенный» вариант (без пустых строк и без `#`-комментариев).
$envPlain = Get-Content C:\tagcloud\tagcloud.env |
    Where-Object { $_ -and -not $_.StartsWith('#') } |
    ForEach-Object { $_ -replace '^\s*export\s+', '' }
nssm set tagcloud AppEnvironmentExtra ($envPlain -join "`r`n")

# Логи stdout/stderr.
New-Item -ItemType Directory -Force -Path C:\tagcloud\logs | Out-Null
nssm set tagcloud AppStdout C:\tagcloud\logs\tagcloud.out.log
nssm set tagcloud AppStderr C:\tagcloud\logs\tagcloud.err.log
nssm set tagcloud AppRotateFiles 1
nssm set tagcloud AppRotateBytes 10485760    # 10 MB

# Auto-restart при падении.
nssm set tagcloud AppExit Default Restart
nssm set tagcloud AppRestartDelay 5000

# Graceful shutdown: Node-процесс ловит CTRL+BREAK как SIGTERM-эквивалент,
# дальше hooks.server.ts флашит in-memory очередь голосов.
nssm set tagcloud AppStopMethodConsole 30000
nssm set tagcloud AppKillProcessTree 1

# Зависимости — Postgres и Memurai.
nssm set tagcloud DependOnService postgresql-x64-16 Memurai

# Запуск.
nssm start tagcloud
nssm status tagcloud
# SERVICE_RUNNING

# Проверка endpoint'ов.
Invoke-WebRequest -Uri http://127.0.0.1:3000/healthz -UseBasicParsing
Invoke-WebRequest -Uri http://127.0.0.1:3000/readyz  -UseBasicParsing | Select-Object -Expand Content
```

### 2.6. Caddy с DNS-01 challenge как Windows-служба

`choco install caddy` ставит «голый» Caddy без DNS-провайдеров. Для
DNS-01 через Cloudflare нужна сборка с плагином `caddy-dns/cloudflare`:

1. Зайдите на https://caddyserver.com/download
2. Выберите «Windows · amd64» и в **Add packages** — `github.com/caddy-dns/cloudflare`
3. Скачайте бинарь, положите в `C:\tagcloud\caddy\caddy.exe`
4. Удалите хочоковский `caddy.exe` из PATH (или просто используйте свой путь).

```powershell
# Создаём C:\tagcloud\caddy\Caddyfile.
@'
{
    email admin@2090.fun
}

2090.fun, www.2090.fun {
    tls {
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
'@ | Set-Content -Encoding UTF8 C:\tagcloud\caddy\Caddyfile
```

Регистрируем Caddy как службу через NSSM:

```powershell
nssm install caddy C:\tagcloud\caddy\caddy.exe `
    "run --config C:\tagcloud\caddy\Caddyfile --adapter caddyfile"
nssm set caddy AppDirectory C:\tagcloud\caddy
nssm set caddy AppEnvironmentExtra "CLOUDFLARE_API_TOKEN=ВАШ_ТОКЕН"
nssm set caddy AppStdout C:\tagcloud\logs\caddy.out.log
nssm set caddy AppStderr C:\tagcloud\logs\caddy.err.log
nssm set caddy AppRotateFiles 1
nssm set caddy AppRotateBytes 10485760
nssm set caddy AppStopMethodConsole 30000
nssm set caddy DependOnService tagcloud

nssm start caddy
nssm status caddy
```

> На Windows Caddy сам не имеет права слушать 80/443 от обычного юзера —
> NSSM по умолчанию запускает службу под `LocalSystem`, у него права есть.

Проверка:

```powershell
Invoke-WebRequest -Uri https://2090.fun -UseBasicParsing | Select-Object -Expand StatusCode
# 200
Get-Content C:\tagcloud\logs\caddy.out.log -Tail 30
# Ищем "certificate obtained successfully".
```

### 2.7. DDNS на PowerShell + Task Scheduler

Скрипт `C:\tagcloud\cf-ddns.ps1` (UTF-8 без BOM):

```powershell
# Обновляет A-записи в Cloudflare на текущий публичный IP. Идемпотентно.
$ErrorActionPreference = 'Stop'

$cfToken  = $env:CF_API_TOKEN
$cfZone   = $env:CF_ZONE        # например, '2090.fun'
$records  = $env:CF_RECORDS -split '\s+'  # '2090.fun www.2090.fun'

if (-not $cfToken)  { throw 'CF_API_TOKEN not set' }
if (-not $cfZone)   { throw 'CF_ZONE not set' }
if (-not $records)  { throw 'CF_RECORDS not set' }

$headers = @{
    'Authorization' = "Bearer $cfToken"
    'Content-Type'  = 'application/json'
}

$currentIp = (Invoke-RestMethod -Uri 'https://api.ipify.org?format=json' -TimeoutSec 10).ip
if (-not $currentIp) { throw 'no public IP detected' }

$zoneId = (Invoke-RestMethod -Headers $headers `
    -Uri "https://api.cloudflare.com/client/v4/zones?name=$cfZone").result[0].id
if (-not $zoneId) { throw "zone $cfZone not found" }

foreach ($name in $records) {
    $rec = (Invoke-RestMethod -Headers $headers `
        -Uri "https://api.cloudflare.com/client/v4/zones/$zoneId/dns_records?type=A&name=$name").result[0]

    $payload = @{ type='A'; name=$name; content=$currentIp; ttl=120; proxied=$false } |
        ConvertTo-Json

    if (-not $rec) {
        Write-Host "[ddns] create $name → $currentIp"
        Invoke-RestMethod -Method POST -Headers $headers -Body $payload `
            -Uri "https://api.cloudflare.com/client/v4/zones/$zoneId/dns_records" | Out-Null
    } elseif ($rec.content -ne $currentIp) {
        Write-Host "[ddns] update $name : $($rec.content) → $currentIp"
        Invoke-RestMethod -Method PUT -Headers $headers -Body $payload `
            -Uri "https://api.cloudflare.com/client/v4/zones/$zoneId/dns_records/$($rec.id)" | Out-Null
    } else {
        Write-Host "[ddns] $name up-to-date ($currentIp)"
    }
}
```

Конфиг с токеном — отдельный файл, права только Администраторам.
Создаём `C:\tagcloud\cf-ddns.env.ps1` (PowerShell-скрипт, который
устанавливает переменные среды):

```powershell
$env:CF_API_TOKEN = 'ВАШ_ТОКЕН_ОТ_CLOUDFLARE'
$env:CF_ZONE      = '2090.fun'
$env:CF_RECORDS   = '2090.fun www.2090.fun'
```

```powershell
# Уберите наследование, оставьте только Администраторов:
icacls C:\tagcloud\cf-ddns.env.ps1 /inheritance:r /grant:r "Administrators:F"
```

Wrapper-скрипт `C:\tagcloud\cf-ddns-run.ps1`:

```powershell
. C:\tagcloud\cf-ddns.env.ps1
& C:\tagcloud\cf-ddns.ps1 *>&1 | Out-File C:\tagcloud\logs\cf-ddns.log -Append
```

Регистрируем в Task Scheduler — раз в 5 минут, под `SYSTEM`:

```powershell
$action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument '-NoProfile -ExecutionPolicy Bypass -File C:\tagcloud\cf-ddns-run.ps1'
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 5)
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName 'tagcloud-cf-ddns' `
    -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
    -Description 'Cloudflare DDNS update for 2090.fun'

# Прогон вручную:
Start-ScheduledTask -TaskName 'tagcloud-cf-ddns'
Get-Content C:\tagcloud\logs\cf-ddns.log -Tail 10
```

Проверка через 5 минут:

```powershell
nslookup 2090.fun 1.1.1.1
# Должен вернуть текущий публичный IP машины (тот же, что Invoke-RestMethod api.ipify.org).
```

### 2.8. Cloudflare Tunnel как Windows-служба

Альтернатива проброса портов — Cloudflare Tunnel. На Windows
устанавливается через MSI-инсталлятор или `winget`.

```powershell
winget install --id Cloudflare.cloudflared
# Или: https://github.com/cloudflare/cloudflared/releases — `cloudflared-windows-amd64.msi`.

cloudflared --version
```

```powershell
# Логин — откроет браузер.
cloudflared tunnel login

# Создаём тоннель.
cloudflared tunnel create tagcloud
# В выводе путь к credentials: C:\Users\<user>\.cloudflared\<UUID>.json

# DNS-маршруты.
cloudflared tunnel route dns tagcloud 2090.fun
cloudflared tunnel route dns tagcloud www.2090.fun
```

Конфиг — `C:\Users\<user>\.cloudflared\config.yml` (или
`C:\ProgramData\Cloudflare\cloudflared\config.yml` под службу):

```yaml
tunnel: tagcloud
credentials-file: C:\ProgramData\Cloudflare\cloudflared\tagcloud.json

ingress:
  - hostname: 2090.fun
    service: http://127.0.0.1:80
    originRequest:
      connectTimeout: 30s
      tlsTimeout: 30s
      tcpKeepAlive: 30s
      keepAliveTimeout: 1h
      noHappyEyeballs: true
  - hostname: www.2090.fun
    service: http://127.0.0.1:80
  - service: http_status:404
```

Установка как Windows-служба:

```powershell
# Перенесём credentials под ProgramData (службе будет проще достать).
New-Item -ItemType Directory -Force -Path C:\ProgramData\Cloudflare\cloudflared
Copy-Item "$env:USERPROFILE\.cloudflared\*.json" C:\ProgramData\Cloudflare\cloudflared\
Copy-Item "$env:USERPROFILE\.cloudflared\config.yml" C:\ProgramData\Cloudflare\cloudflared\

cloudflared --config C:\ProgramData\Cloudflare\cloudflared\config.yml service install
Start-Service cloudflared

Get-Service cloudflared
Get-EventLog -LogName Application -Source cloudflared -Newest 10
```

При использовании Tunnel Caddy на 80/443 не нужен — cloudflared сам
ходит на `http://127.0.0.1:80` (или сразу на `:3000`, если убрать
Caddy). Можно вообще обойтись без Caddy:

```yaml
ingress:
  - hostname: 2090.fun
    service: http://127.0.0.1:3000
  - hostname: www.2090.fun
    service: http://127.0.0.1:3000
  - service: http_status:404
```

Но тогда X-Forwarded-* заголовки нужно прокидывать настройками
cloudflared (`headers` в `originRequest`) или принимать
`Cf-Connecting-Ip` напрямую в SvelteKit (`ADDRESS_HEADER=Cf-Connecting-Ip`).

### 2.9. Почта через smarthost напрямую из приложения

На Windows ставить локальный Postfix с Cygwin-сборками — можно, но
непрактично. Проще убрать Postfix из схемы и слать прямо из Node к
smarthost-провайдеру с TLS+auth.

В `C:\tagcloud\tagcloud.env` (см. секцию 2.2) — пример для Resend:

```ini
SMTP_HOST=smtp.resend.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=resend
SMTP_PASSWORD=re_СЕКРЕТНЫЙ_API_KEY
SMTP_FROM="Tagcloud <noreply@2090.fun>"
```

Аналогично для других провайдеров:

| Провайдер | SMTP_HOST | SMTP_PORT | SMTP_SECURE | SMTP_USER | SMTP_PASSWORD |
|---|---|---|---|---|---|
| Resend | `smtp.resend.com` | 465 | `true` | `resend` | API-key |
| Brevo | `smtp-relay.brevo.com` | 587 | `false` | account login | SMTP key |
| Mailgun | `smtp.mailgun.org` | 587 | `false` | `postmaster@2090.fun` | пароль из dashboard |
| AWS SES | `email-smtp.<region>.amazonaws.com` | 587 | `false` | SMTP-username | SMTP-password |
| Yandex 360 | `smtp.yandex.ru` | 465 | `true` | `noreply@2090.fun` | app-password |

DNS-записи `2090.fun` для прохождения SPF/DKIM/DMARC (минимум для
Resend; для других провайдеров — по их docs):

| Тип | Имя | Значение |
|---|---|---|
| TXT | `@` | `v=spf1 include:_spf.resend.com -all` |
| CNAME / TXT | по доке Resend (`resend._domainkey`, `resend2._domainkey`) | значения из их dashboard |
| TXT | `_dmarc` | `v=DMARC1; p=quarantine; rua=mailto:postmaster@2090.fun; adkim=r; aspf=r` |

Перезапуск Node-службы после изменений в env:

```powershell
nssm restart tagcloud
```

### 2.10. Бэкап Postgres → restic + Task Scheduler

`pg_dump.exe` идёт в составе Postgres-installer (`C:\Program Files\PostgreSQL\16\bin`).
`restic.exe` — поставился через `choco install restic`.

`C:\tagcloud\backup.env.ps1` (env, права только Администраторам):

```powershell
$env:DATABASE_URL      = 'postgres://tagcloud:CHANGE_ME@127.0.0.1:5432/tagcloud'
$env:RESTIC_REPOSITORY = 'b2:tagcloud-backups:/postgres'
$env:B2_ACCOUNT_ID     = 'CHANGE_ME'
$env:B2_ACCOUNT_KEY    = 'CHANGE_ME'
$env:RESTIC_PASSWORD   = 'CHANGE_ME'
$env:RETAIN_DAILY      = '7'
$env:RETAIN_WEEKLY     = '4'
$env:RETAIN_MONTHLY    = '6'
```

```powershell
icacls C:\tagcloud\backup.env.ps1 /inheritance:r /grant:r "Administrators:F"
```

Скрипт `C:\tagcloud\backup.ps1` (повторяет `scripts/ops/backup.sh`,
но через PowerShell и pipe в restic):

```powershell
$ErrorActionPreference = 'Stop'

. C:\tagcloud\backup.env.ps1

$ts       = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$filename = "postgres-$ts.dump"

# Init repo идемпотентно.
& restic snapshots *> $null
if ($LASTEXITCODE -ne 0) { & restic init }

# Pipe pg_dump → restic backup --stdin (без промежуточного файла).
$pgDump = "C:\Program Files\PostgreSQL\16\bin\pg_dump.exe"
& $pgDump --format=custom --compress=6 --no-owner --no-privileges $env:DATABASE_URL `
    | & restic backup --stdin --stdin-filename $filename --tag postgres --tag tagcloud

if ($LASTEXITCODE -ne 0) { throw "backup failed (exit $LASTEXITCODE)" }

& restic forget --tag postgres `
    --keep-daily   $env:RETAIN_DAILY `
    --keep-weekly  $env:RETAIN_WEEKLY `
    --keep-monthly $env:RETAIN_MONTHLY `
    --prune

Write-Host "[backup] done $ts"
```

Регистрируем в Task Scheduler — каждый день 03:30 локального времени:

```powershell
$action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument '-NoProfile -ExecutionPolicy Bypass -File C:\tagcloud\backup.ps1'
$trigger = New-ScheduledTaskTrigger -Daily -At 3:30am
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName 'tagcloud-backup' `
    -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
    -Description 'Daily Postgres backup → restic'

# Тестовый прогон вручную:
Start-ScheduledTask -TaskName 'tagcloud-backup'
& restic snapshots
# Должен показать первый snapshot с тегами postgres,tagcloud.
```

### 2.11. Windows Defender Firewall

Если используете проброс портов (без Cloudflare Tunnel):

```powershell
New-NetFirewallRule -DisplayName "tagcloud http"  -Direction Inbound -Protocol TCP -LocalPort 80  -Action Allow -Profile Any
New-NetFirewallRule -DisplayName "tagcloud https" -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow -Profile Any

# Postgres/Memurai/Node — только loopback, наружу не пускаем.
New-NetFirewallRule -DisplayName "block postgres external" -Direction Inbound -Protocol TCP -LocalPort 5432 -RemoteAddress Any -Action Block
New-NetFirewallRule -DisplayName "block redis external"    -Direction Inbound -Protocol TCP -LocalPort 6379 -RemoteAddress Any -Action Block
```

Если используете Cloudflare Tunnel — 80/443 наружу не нужны вообще:

```powershell
Get-NetFirewallRule -DisplayName "tagcloud http","tagcloud https" |
    Set-NetFirewallRule -Action Block
```

## Проверки после деплоя

```powershell
# 1. DNS указывает на текущий IP / на тоннель.
nslookup 2090.fun 1.1.1.1
# Без тоннеля — публичный IP машины. С тоннелем — anycast IP Cloudflare.

# 2. Сертификат валидный.
$resp = Invoke-WebRequest -Uri https://2090.fun -UseBasicParsing
$resp.StatusCode      # 200
$resp.Headers.'Strict-Transport-Security'

# 3. Приложение отвечает.
(Invoke-RestMethod https://2090.fun/healthz)
(Invoke-RestMethod https://2090.fun/readyz)

# 4. Службы крутятся.
Get-Service tagcloud, caddy, cloudflared, Memurai, postgresql-x64-16 -ErrorAction SilentlyContinue
Get-ScheduledTask | Where-Object { $_.TaskName -like 'tagcloud-*' } |
    Select TaskName, State, LastRunTime, LastTaskResult

# 5. Логи.
Get-Content C:\tagcloud\logs\tagcloud.out.log -Tail 20
Get-Content C:\tagcloud\logs\caddy.out.log    -Tail 20
Get-Content C:\tagcloud\logs\cf-ddns.log      -Tail 5
```

## Траблшутинг

**WSL: `systemctl is-system-running` возвращает `offline`**

- Проверьте `/etc/wsl.conf` — секция `[boot] systemd=true` должна быть.
- `wsl --shutdown` из PowerShell, потом снова `wsl -d Ubuntu-22.04`.
- Версия Windows: `winver` → должно быть Windows 10 21H2+ или Windows 11.
  Старее — обновите ОС, на 20H2 systemd в WSL не заведётся.

**Запросы извне приходят на Windows, но не доходят до WSL**

- `netsh interface portproxy show all` — есть ли активные правила?
- `wsl -d Ubuntu-22.04 -- ss -tlnp | grep -E ':80|:443'` — Caddy внутри
  WSL действительно слушает?
- WSL IP мог поменяться после `wsl --shutdown`. Перезапустите задачу
  `tagcloud-start-wsl` или вручную:
  ```powershell
  $wslIp = (wsl -d Ubuntu-22.04 -- hostname -I).Trim().Split()[0]
  netsh interface portproxy reset
  netsh interface portproxy add v4tov4 listenport=80  connectaddress=$wslIp connectport=80
  netsh interface portproxy add v4tov4 listenport=443 connectaddress=$wslIp connectport=443
  ```

**NSSM-служба `tagcloud` крашит сразу после старта**

- Логи в `C:\tagcloud\logs\tagcloud.err.log`. Чаще всего — неправильный
  путь к node.exe или к build/index.js, либо переменные окружения не
  подцепились.
- Проверка вручную: запустите ровно ту команду, что NSSM пишет в
  «AppPath/AppParameters», под пользователем службы.
- Если служба запускается от не-Administrator аккаунта, дайте ему права
  чтения на `C:\tagcloud\` и запись в `C:\tagcloud\logs\`.

**Caddy: `tls obtain failed`**

- Лог в `C:\tagcloud\logs\caddy.err.log`. Чаще всего — `CLOUDFLARE_API_TOKEN`
  не передался: `nssm get caddy AppEnvironmentExtra` должен показать токен.
- Проверьте, что в Cloudflare у токена есть scope **Edit zone DNS** на
  `2090.fun`.
- Сбросить ACME-кеш и попробовать ещё раз:
  ```powershell
  nssm stop caddy
  Remove-Item -Recurse -Force "$env:ProgramData\Caddy\Local\Acme"
  nssm start caddy
  ```

**Cloudflare Tunnel: `Unauthorized` при старте**

- `Get-Content $env:ProgramData\Cloudflare\cloudflared\config.yml` — путь
  к credentials JSON правильный?
- Если меняли account/zone в Cloudflare — перелогиньтесь:
  `cloudflared tunnel login` и заново скопируйте `cert.pem`.

**Письма уходят, но падают в спам**

- Проверьте Authentication-Results в любом полученном письме (Gmail —
  «Show original»): должно быть `spf=pass dkim=pass dmarc=pass`.
- На mail-tester.com отправьте письмо, выданное им — получите 0–10. Цель ≥ 8.
- Чаще всего проблема — забыли добавить CNAME-записи DKIM, которые
  smarthost (Resend / Brevo / Mailgun) показывает в своём dashboard.

**Memurai-developer уходит в expired (бесплатная лицензия)**

- Developer-edition требует продления каждые 30 дней. Альтернативы:
  Redis в WSL (`sudo apt install redis-server` + проброс через
  `netsh portproxy` в обратную сторону), или контейнер Redis в
  Docker Desktop.
