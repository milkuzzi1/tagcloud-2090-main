# Почта через SendPulse SMTP

Все письма (verification и итоги опросов) уходят через SendPulse SMTP.
Приложение авторизуется в SendPulse по SMTP-credentials и шлёт напрямую — ни
Postfix, ни OpenDKIM поднимать не нужно.

> Домен в примерах — `2090.fun`. Замените на свой, если другой.

## TL;DR

1. Зарегистрируйтесь на https://sendpulse.com и включите SMTP в личном
   кабинете.
2. Добавьте и верифицируйте домен отправителя (DNS-записи SPF/DKIM —
   см. секцию DNS).
3. В **Settings → SMTP** возьмите логин (email от аккаунта) и SMTP-пароль.
4. Подставьте креденшалы в `/etc/tagcloud/tagcloud.env`:

   ```
   SMTP_HOST=smtp-pulse.com
   SMTP_PORT=587
   SMTP_SECURE=false
   SMTP_USER=<email-логин SendPulse>
   SMTP_PASSWORD=<SMTP-пароль SendPulse>
   SMTP_FROM="Tagcloud <noreply@2090.fun>"
   ```

5. `sudo systemctl restart tagcloud` — и письма пойдут.

## Подготовка аккаунта SendPulse

1. Зарегистрируйтесь на https://sendpulse.com.
2. В кабинете включите функцию SMTP (раздел **Settings → SMTP**).
3. Добавьте домен отправителя и пройдите верификацию (SendPulse
   выдаст набор DNS-записей).
4. В **Settings → SMTP** скопируйте логин (email от аккаунта) и
   SMTP-пароль.
5. Положите креденшалы в `/etc/tagcloud/tagcloud.env` (chmod 600!).

## Порты SendPulse

| Порт | Шифрование | SMTP_SECURE |
|---|---|---|
| 587 | STARTTLS (по умолчанию) | `false` |
| 2525 | STARTTLS (если 587 закрыт хостером) | `false` |
| 465 | implicit TLS | `true` |

## DNS-записи

Для верификации домена и хорошей доставляемости добавьте у регистратора
записи, которые предлагает SendPulse при добавлении домена:

| Тип | Имя | Значение | Зачем |
|---|---|---|---|
| TXT | `@` (SPF) | `v=spf1 include:sendpulse.com ~all` | Авторизуем серверы SendPulse как отправителей. |
| CNAME / TXT | (по инструкции SendPulse) | (по инструкции SendPulse) | DKIM-подпись SendPulse. |
| TXT | `_dmarc` | `v=DMARC1; p=quarantine; rua=mailto:postmaster@2090.fun; adkim=s; aspf=s` | Политика DMARC. |

Конкретные значения DKIM-записей выдаёт SendPulse при добавлении домена
в дашборде — следуйте их инструкциям.

## Лимиты SendPulse

Лимиты зависят от тарифного плана. Актуальные лимиты:
https://sendpulse.com/prices

## Проверки

### 1. SMTP_HOST доступен с сервера

```bash
nc -vz smtp-pulse.com 587
# Connection to smtp-pulse.com 587 port [tcp/submission] succeeded!
```

Если порт 587 заблокирован хостером — попробуйте 2525:

```
SMTP_PORT=2525
```

### 2. Авторизация работает

Триггер — регистрация нового пользователя через UI:

```bash
journalctl -u tagcloud -n 100 -f | grep -iE "smtp|mail|verification"
# Не должно быть строк "535" или "EAUTH" — это значит SMTP-credentials неверные.
```

Быстрая ручная проверка из консоли (если есть `swaks`):

```bash
sudo apt-get install -y swaks
swaks --to you@example.com \
      --from noreply@2090.fun \
      --server smtp-pulse.com:587 \
      --tls \
      --auth LOGIN \
      --auth-user '<email-логин>' \
      --auth-password '<SMTP-пароль>' \
      --header "Subject: tagcloud smtp test"
# Ожидаем 250 2.0.0 OK на финальной строке.
```

### 3. Письма не падают в спам

Отправьте тестовое письмо на `mail-tester.com` (адрес выдаётся на их
сайте) — получите подробный отчёт 0–10. Цель ≥ 8. Чаще всего минусы:

- нет SPF/DKIM/DMARC у своего домена (см. секцию DNS выше);
- SMTP_FROM не совпадает с verified domain в SendPulse;
- HTML-письмо без plain-text alternative (у нас оба есть в
  `src/lib/server/email/`, проверьте, что не сломали).

## Известные ошибки

| Ошибка в логе | Что значит | Что делать |
|---|---|---|
| `535 Authentication failed` | Неверные SMTP-credentials. | Проверить SMTP_USER и SMTP_PASSWORD, при необходимости перегенерировать SMTP-пароль в SendPulse. |
| `EAUTH: Invalid login` | nodemailer не может авторизоваться. | Проверить SMTP_USER и SMTP_PASSWORD, убедиться что нет лишних пробелов. |
| `ECONNREFUSED smtp-pulse.com:587` | Хостер блокирует исходящий 587. | Попробовать порт 2525 или 465 (с SMTP_SECURE=true), либо открыть тикет хостеру. |
| `550 Sender not verified` | SMTP_FROM не верифицирован в SendPulse. | Добавить и верифицировать домен/адрес в дашборде SendPulse. |

## Безопасность

- SMTP-credentials = bearer-токен на отправку от имени аккаунта. Утечка =
  спам с вашего домена. Храним в `/etc/tagcloud/tagcloud.env`
  (chmod 600, owner `tagcloud`).
- Ротация: при необходимости перегенерируйте SMTP-пароль в SendPulse
  (Settings → SMTP).
- DMARC начинаем с `p=quarantine` (мягкий режим), через 1–2 недели при
  стабильно зелёных отчётах ужесточаем до `p=reject`.
