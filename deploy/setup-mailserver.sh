#!/usr/bin/env bash
# Идемпотентный установщик локального Postfix + OpenDKIM.
#
# Сценарий: всё на одной VPS — фронт, API и почта. App ходит к Postfix
# через 127.0.0.1:25 без авторизации (Postfix доверяет loopback через
# mynetworks=127.0.0.0/8). Postfix подписывает исходящее DKIM-ом и
# релеит наружу.
#
# Использование:
#   sudo bash deploy/setup-mailserver.sh 2090.fun
#
# Требования:
#   - Debian 12+ / Ubuntu 22.04+ под root.
#   - A-запись mail.<DOMAIN> → IP машины уже создана.
#   - Хостер не блокирует исходящий 25/tcp (если блокирует — см.
#     deploy/mail-server.md, секцию про smarthost).
#
# После выполнения скрипт распечатывает блок DNS-записей (MX/SPF/DMARC/DKIM),
# которые нужно добавить у регистратора домена.

set -euo pipefail

DOMAIN="${1:-}"
SELECTOR="${2:-mail}"

if [[ -z "$DOMAIN" ]]; then
  echo "usage: $0 <domain> [dkim-selector]" >&2
  echo "example: $0 2090.fun" >&2
  exit 2
fi

if [[ "$EUID" -ne 0 ]]; then
  echo "must run as root (sudo)" >&2
  exit 2
fi

MAIL_FQDN="mail.${DOMAIN}"
KEYDIR="/etc/opendkim/keys/${DOMAIN}"

log() { printf '\033[1;34m[setup-mailserver]\033[0m %s\n' "$*"; }

# --- 1. Hostname / FQDN -----------------------------------------------------
log "hostname → ${MAIL_FQDN}"
hostnamectl set-hostname "$MAIL_FQDN"
if ! grep -qE "^[0-9.]+\s+${MAIL_FQDN}\b" /etc/hosts; then
  echo "127.0.1.1 ${MAIL_FQDN} mail" >> /etc/hosts
fi

# --- 2. Пакеты --------------------------------------------------------------
log "apt-get install postfix opendkim opendkim-tools mailutils"
export DEBIAN_FRONTEND=noninteractive
debconf-set-selections <<EOF
postfix postfix/mailname string ${DOMAIN}
postfix postfix/main_mailer_type select Internet Site
EOF
apt-get update -y >/dev/null
apt-get install -y postfix opendkim opendkim-tools mailutils >/dev/null

# --- 3. Postfix main.cf -----------------------------------------------------
log "configure postfix (loopback-only, milter → opendkim)"
postconf -e "myhostname = ${MAIL_FQDN}"
postconf -e "mydomain = ${DOMAIN}"
postconf -e "myorigin = \$mydomain"
postconf -e "inet_interfaces = loopback-only"
postconf -e "inet_protocols = all"
postconf -e "mydestination = \$myhostname, localhost.\$mydomain, localhost"
postconf -e "mynetworks = 127.0.0.0/8 [::1]/128"
postconf -e "relayhost ="
postconf -e "smtp_tls_security_level = may"
postconf -e "smtp_tls_loglevel = 1"
postconf -e "smtp_tls_session_cache_database = btree:\${data_directory}/smtp_scache"
postconf -e "milter_default_action = accept"
postconf -e "milter_protocol = 6"
postconf -e "smtpd_milters = inet:127.0.0.1:8891"
postconf -e "non_smtpd_milters = inet:127.0.0.1:8891"
postconf -e "message_size_limit = 26214400"

# --- 4. OpenDKIM -----------------------------------------------------------
log "configure opendkim (selector=${SELECTOR}, domain=${DOMAIN})"
adduser postfix opendkim >/dev/null 2>&1 || true
mkdir -p "$KEYDIR"

if [[ ! -f "${KEYDIR}/${SELECTOR}.private" ]]; then
  log "generating DKIM RSA-2048 key"
  (cd "$KEYDIR" && opendkim-genkey -b 2048 -d "$DOMAIN" -s "$SELECTOR")
fi
chown -R opendkim:opendkim /etc/opendkim
chmod 700 "$KEYDIR"
chmod 600 "${KEYDIR}/${SELECTOR}.private"

cat > /etc/opendkim.conf <<EOF
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
EOF

cat > /etc/opendkim/key.table <<EOF
${SELECTOR}._domainkey.${DOMAIN} ${DOMAIN}:${SELECTOR}:${KEYDIR}/${SELECTOR}.private
EOF

cat > /etc/opendkim/signing.table <<EOF
*@${DOMAIN} ${SELECTOR}._domainkey.${DOMAIN}
EOF

cat > /etc/opendkim/trusted.hosts <<EOF
127.0.0.1
::1
localhost
*.${DOMAIN}
${DOMAIN}
EOF

mkdir -p /run/opendkim
chown opendkim:opendkim /run/opendkim

# --- 5. Запуск -------------------------------------------------------------
log "restart opendkim + postfix"
systemctl enable --now opendkim
systemctl restart opendkim
systemctl enable --now postfix
systemctl restart postfix

# --- 6. Печать DNS-записей --------------------------------------------------
DKIM_TXT="$(awk '/v=DKIM1/ {found=1} found {gsub(/^.*\(/, ""); gsub(/[" \t)]/, ""); printf "%s", $0} /\)/ {exit}' "${KEYDIR}/${SELECTOR}.txt")"

cat <<EOF

================================================================================
Установка завершена. Добавьте у регистратора домена ${DOMAIN} следующие записи:
================================================================================

  Тип     Имя                              Значение
  -----   ------------------------------   ----------------------------------
  A       mail                             <публичный IP этого сервера>
  MX      @                                10 mail.${DOMAIN}.
  TXT     @  (SPF)                         "v=spf1 mx -all"
  TXT     _dmarc                           "v=DMARC1; p=quarantine; rua=mailto:postmaster@${DOMAIN}; adkim=s; aspf=s"
  TXT     ${SELECTOR}._domainkey           "${DKIM_TXT}"

И настройте у хостинг-провайдера обратную DNS-запись (PTR):
  <публичный IP> → ${MAIL_FQDN}

После того как DNS прописан и истёк TTL — проверьте:
  dig +short MX ${DOMAIN}
  dig +short TXT ${DOMAIN}
  dig +short TXT _dmarc.${DOMAIN}
  dig +short TXT ${SELECTOR}._domainkey.${DOMAIN}

И отправьте тестовое письмо:
  echo "ping" | mail -s "tagcloud smtp test" you@example.com

В заголовках Authentication-Results получателя должно быть:
  spf=pass dkim=pass dmarc=pass
================================================================================
EOF
