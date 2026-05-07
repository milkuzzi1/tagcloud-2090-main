# Свой mail-сервер (Postfix + OpenDKIM) на одной машине с приложением

Всё крутится на одной VPS — фронт, API и почта. App ходит к Postfix через
`127.0.0.1:25` без авторизации (Postfix доверяет loopback через
`mynetworks=127.0.0.0/8`). Postfix подписывает исходящее DKIM-ом и
релеит наружу напрямую через 25-й порт получателя.

> Домен в примерах — `2090.fun`. Замените на свой, если другой.

## TL;DR — автоматическая установка

```bash
sudo bash deploy/setup-mailserver.sh 2090.fun
```

Скрипт идемпотентный:

1. ставит `postfix`, `opendkim`, `opendkim-tools`, `mailutils`;
2. конфигурирует Postfix как send-only (loopback inet_interfaces, `mynetworks=127.0.0.0/8 [::1]/128`);
3. генерирует RSA-2048 DKIM-ключ для селектора `mail` в
   `/etc/opendkim/keys/<domain>/mail.private`;
4. подключает OpenDKIM к Postfix через milter на `127.0.0.1:8891`;
5. печатает блок DNS-записей, которые нужно добавить у регистратора.

Дальше — добавляете DNS-записи и проверяете доставку (см. ниже).

## Предусловия

- VPS с публичным статическим IP, на который провайдер не блокирует
  исходящий 25/tcp (DigitalOcean / Linode / Hetzner — обычно нужно
  отдельно открыть тикет на снятие лимита). Если 25/tcp закрыт —
  используйте relay через smarthost (см. раздел в конце).
- Управление DNS для `2090.fun` (можно добавлять A / MX / TXT записи).
- A-запись `mail.2090.fun → IP сервера` уже создана.
- PTR-запись (rDNS) для IP должна указывать на `mail.2090.fun`.
  Настраивается у хостинг-провайдера в панели управления VPS.
  Без корректного PTR письма будут уходить в спам / отбиваться.

## Ручная установка (если нужно понять, что делает скрипт)

### 1. Hostname и FQDN

```bash
hostnamectl set-hostname mail.2090.fun
echo "127.0.1.1 mail.2090.fun mail" >> /etc/hosts
```

### 2. Postfix — send-only

```bash
DEBIAN_FRONTEND=noninteractive apt-get install -y postfix mailutils
```

При установке выберите "Internet Site" и system mail name `2090.fun`.

`/etc/postfix/main.cf` (только нужные строки, остальное — дефолты Debian/Ubuntu):

```
myhostname = mail.2090.fun
mydomain = 2090.fun
myorigin = $mydomain
inet_interfaces = loopback-only
inet_protocols = all
mydestination = $myhostname, localhost.$mydomain, localhost
mynetworks = 127.0.0.0/8 [::1]/128
relayhost =

# Обязательно для современных получателей: строгая TLS наружу.
smtp_tls_security_level = may
smtp_tls_loglevel = 1
smtp_tls_session_cache_database = btree:${data_directory}/smtp_scache

# DKIM через OpenDKIM milter:
milter_default_action = accept
milter_protocol = 6
smtpd_milters = inet:127.0.0.1:8891
non_smtpd_milters = inet:127.0.0.1:8891

# Размер письма — у нас вложениями PNG/CSV, поднимем до 25 MB.
message_size_limit = 26214400
```

```bash
systemctl restart postfix
```

### 3. OpenDKIM

```bash
apt-get install -y opendkim opendkim-tools
adduser postfix opendkim
mkdir -p /etc/opendkim/keys/2090.fun
cd /etc/opendkim/keys/2090.fun
opendkim-genkey -b 2048 -d 2090.fun -s mail
chown -R opendkim:opendkim /etc/opendkim
chmod 600 /etc/opendkim/keys/2090.fun/mail.private
```

`/etc/opendkim.conf` (минимум):

```
Syslog                  yes
UMask                   002
Mode                    sv
Canonicalization        relaxed/simple
SubDomains              no
AutoRestart             yes
AutoRestartRate         10/1M
Background              yes
DNSTimeout              5
SignatureAlgorithm      rsa-sha256

KeyTable                /etc/opendkim/key.table
SigningTable            refile:/etc/opendkim/signing.table
ExternalIgnoreList      refile:/etc/opendkim/trusted.hosts
InternalHosts           refile:/etc/opendkim/trusted.hosts

Socket                  inet:8891@127.0.0.1
PidFile                 /run/opendkim/opendkim.pid
UserID                  opendkim
```

`/etc/opendkim/key.table`:

```
mail._domainkey.2090.fun 2090.fun:mail:/etc/opendkim/keys/2090.fun/mail.private
```

`/etc/opendkim/signing.table`:

```
*@2090.fun mail._domainkey.2090.fun
```

`/etc/opendkim/trusted.hosts`:

```
127.0.0.1
::1
localhost
*.2090.fun
2090.fun
```

```bash
systemctl restart opendkim postfix
systemctl enable opendkim postfix
```

### 4. DNS-записи у регистратора `2090.fun`

| Тип    | Имя                       | Значение |
|--------|---------------------------|----------|
| A      | `mail`                    | `<IP сервера>` |
| MX     | `@`                       | `10 mail.2090.fun.` |
| TXT    | `@` (SPF)                 | `v=spf1 mx -all` |
| TXT    | `_dmarc`                  | `v=DMARC1; p=quarantine; rua=mailto:postmaster@2090.fun; adkim=s; aspf=s` |
| TXT    | `mail._domainkey`         | содержимое `/etc/opendkim/keys/2090.fun/mail.txt` (в кавычках, всё что между `( … )`) |

Для DKIM удобно скопировать готовое значение:

```bash
sudo awk '/v=DKIM1/ {gsub(/[" ]/, "", $0); inside=1} inside {printf "%s", $0} /\)/ {exit}' \
  /etc/opendkim/keys/2090.fun/mail.txt
echo
```

PTR-запись `<IP> → mail.2090.fun` настраивается в панели хостинга.

## Проверки

### 1. Postfix принимает письма от app

```bash
echo "ping" | mail -s "smtp test from app" you@example.com
mailq                           # очередь должна быть пустой
journalctl -u postfix -n 50     # ищем `status=sent`
```

### 2. DKIM-подпись валидна

Отправьте письмо на `check-auth@verifier.port25.com` или `mail-tester.com`
— получите подробный отчёт по SPF / DKIM / DMARC. Цель — 10/10.

```bash
echo "test" | mail -s "auth check" check-auth@verifier.port25.com
```

В логе:

```bash
journalctl -u opendkim -n 50 | grep DKIM-Signature
```

### 3. DNS

```bash
dig +short MX 2090.fun
dig +short TXT 2090.fun                       # SPF
dig +short TXT _dmarc.2090.fun                # DMARC
dig +short TXT mail._domainkey.2090.fun       # DKIM
dig +short -x <IP сервера>                    # PTR
```

## Подключение из приложения

После установки Postfix `/etc/tagcloud/tagcloud.env`:

```bash
SMTP_HOST=127.0.0.1
SMTP_PORT=25
SMTP_SECURE=false
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM="Tagcloud <noreply@2090.fun>"
```

Перезапуск:

```bash
systemctl restart tagcloud
```

App при отправке (verification, итоги опросов) пойдёт через
`127.0.0.1:25` без auth — Postfix примет, DKIM-подпишет и отправит наружу.

## Что делать, если хостер блокирует исходящий 25/tcp

Многие облачные провайдеры (DigitalOcean, AWS, GCP) по умолчанию
блокируют 25/tcp out для борьбы со спамом. Варианты:

1. **Запросить снятие лимита** — у Hetzner / Linode / OVH / Selectel
   обычно открывается тикетом за 1–24 часа.
2. **Релей через smarthost** — оставить локальный Postfix, но настроить
   его релеить наружу через сторонний submission (Mailgun, SES, Postmark
   и т.д.) на 587 с авторизацией. Тогда DKIM подписывает локальный
   OpenDKIM, а доставка — через коммерческого провайдера (он не сломает
   подпись). В `main.cf`:

   ```
   relayhost = [smtp.mailgun.org]:587
   smtp_sasl_auth_enable = yes
   smtp_sasl_password_maps = hash:/etc/postfix/sasl_passwd
   smtp_sasl_security_options = noanonymous
   smtp_tls_security_level = encrypt
   smtp_tls_wrappermode = no
   ```

   `/etc/postfix/sasl_passwd` (chmod 600):
   ```
   [smtp.mailgun.org]:587 postmaster@2090.fun:CHANGE_ME
   ```

   ```bash
   postmap /etc/postfix/sasl_passwd
   systemctl restart postfix
   ```

App-конфиг при этом не меняется — `SMTP_HOST=127.0.0.1` по-прежнему
работает.

## Безопасность

- `inet_interfaces = loopback-only` — Postfix не светится наружу,
  принимает только от приложения с той же машины.
- `mynetworks = 127.0.0.0/8 [::1]/128` — релеить через нас может только
  loopback. Никакого open relay.
- DKIM-приватный ключ в `/etc/opendkim/keys/2090.fun/mail.private`
  принадлежит `opendkim:opendkim` с правами `600`. Бэкапим вместе с
  остальными секретами `/etc/tagcloud`.
- DMARC начинаем с `p=quarantine` (мягкий режим), через 1–2 недели
  при стабильно зелёных отчётах ужесточаем до `p=reject`.
