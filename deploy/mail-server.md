# Почта через Gmail SMTP

Все письма (verification и итоги опросов) уходят через Gmail SMTP.
Приложение авторизуется в Gmail по App Password и шлёт напрямую — ни
Postfix, ни OpenDKIM поднимать не нужно.

> Домен в примерах — `2090.fun`. Замените на свой, если другой.

## TL;DR

1. Включите 2-Step Verification на Google-аккаунте, который будет
   отправителем (`noreply@2090.fun` через Google Workspace или обычный
   `@gmail.com` для small-scale).
2. Создайте App Password: https://myaccount.google.com/apppasswords
   (обычный пароль не сработает — Google блокирует «less secure apps»).
3. Подставьте креденшалы в `/etc/tagcloud/tagcloud.env`:

   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=465
   SMTP_SECURE=true
   SMTP_USER=your-account@gmail.com
   SMTP_PASSWORD=<App Password>
   SMTP_FROM="Tagcloud <your-account@gmail.com>"
   ```

4. `sudo systemctl restart tagcloud` — и письма пойдут.

## Какой аккаунт использовать

| Тип | Как получить | Когда подходит |
|---|---|---|
| Обычный `@gmail.com` | https://accounts.google.com/SignUp | dev / pet-project / до 500 писем/сутки |
| Google Workspace `noreply@2090.fun` | https://workspace.google.com — добавить домен и MX-записи Google | production, custom From, до 2000 писем/сутки |
| Sender alias через send-as | Gmail → Settings → Accounts → Send mail as | если хочется отправлять как `noreply@2090.fun`, а аккаунт `personal@gmail.com` |

Для production рекомендуется отдельный сервисный Workspace-аккаунт
`noreply@2090.fun` — его App Password не делит лимиты с личной почтой
и легко ротировать без блокировки людей.

## Подробная настройка App Password

1. Откройте https://myaccount.google.com → Security.
2. Включите **2-Step Verification** (без неё пункт App Passwords не
   появится). Подтвердите номер телефона / Authenticator.
3. Перейдите на https://myaccount.google.com/apppasswords.
4. App name: `tagcloud` (или любое — нужно только вам, чтобы потом
   отозвать конкретный пароль).
5. Нажмите **Create** — Google покажет 16-значный код вида
   `abcd efgh ijkl mnop`. Пробелы можно убрать или оставить — Gmail
   принимает оба варианта.
6. Скопируйте пароль в менеджер паролей и положите в
   `/etc/tagcloud/tagcloud.env` (chmod 600!).

App Password можно отозвать там же на странице App Passwords — после
этого приложение получит `535 5.7.8 Username and Password not accepted`
и нужно будет создать и подставить новый.

## DNS-записи (для своего домена через Workspace)

Если SMTP_FROM на собственном домене (`noreply@2090.fun`), добавьте у
регистратора стандартные записи Workspace для авторизации Google как
отправителя — так письма не падают в спам.

| Тип | Имя | Значение | Зачем |
|---|---|---|---|
| TXT | `@` (SPF) | `v=spf1 include:_spf.google.com -all` | Авторизуем серверы Google как отправителей. |
| CNAME | `google._domainkey` (DKIM) | значение из Workspace Admin → Apps → Gmail → Authenticate email | DKIM-подпись Google. |
| TXT | `_dmarc` | `v=DMARC1; p=quarantine; rua=mailto:postmaster@2090.fun; adkim=s; aspf=s` | Политика DMARC. |
| MX | `@` | `1 ASPMX.L.GOOGLE.COM.` (+ резервы из доки Workspace) | Только если хотите ещё и принимать почту на этот домен. |

DKIM-ключ генерируется в Workspace Admin (Apps → Google Workspace →
Gmail → Authenticate email → Generate new record); добавьте предложенный
CNAME или TXT и нажмите **Start authentication** — Workspace проверит,
что запись опубликована.

Для обычного `@gmail.com` (без своего домена) DNS трогать не нужно —
SPF/DKIM/DMARC у `gmail.com` уже настроены Google.

## Лимиты Gmail

| Аккаунт | Получателей/сутки | Через SMTP |
|---|---|---|
| Обычный `@gmail.com` | 500 | да, через App Password |
| Google Workspace | 2 000 | да, через App Password |
| Workspace + Trial / Flexible | 500 | как обычный (до апгрейда) |

Если упираетесь в лимиты:

- Workspace вместо Gmail (×4 лимит).
- Сторонний ESP (Mailgun / SES / Resend) — тот же `nodemailer`, просто
  другие SMTP_HOST/PORT/USER/PASSWORD.
- Очередь с retry'ями — у нас отправка уже асинхронная (`setImmediate`
  в `routes/api/surveys/[code]/finish/+server.ts`), failed-попытки
  можно повторить через `routes/api/surveys/[code]/retry/+server.ts`.

## Проверки

### 1. SMTP_HOST доступен с сервера

```bash
nc -vz smtp.gmail.com 465
# Connection to smtp.gmail.com 465 port [tcp/smtps] succeeded!
```

Если порт 465 заблокирован хостером — попробуйте 587 (STARTTLS):

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
```

### 2. Авторизация работает

Триггер — регистрация нового пользователя через UI:

```bash
journalctl -u tagcloud -n 100 -f | grep -iE "smtp|mail|verification"
# Не должно быть строк "535 5.7.8 Username and Password not accepted"
# или "EAUTH" — это значит App Password неверный или 2FA не включена.
```

Быстрая ручная проверка из консоли (если есть `swaks`):

```bash
sudo apt-get install -y swaks
swaks --to you@example.com \
      --from your-account@gmail.com \
      --server smtp.gmail.com:465 \
      --tls-on-connect \
      --auth LOGIN \
      --auth-user your-account@gmail.com \
      --auth-password '<App Password>' \
      --header "Subject: tagcloud smtp test"
# Ожидаем 250 2.0.0 OK на финальной строке.
```

### 3. Письма не падают в спам

Отправьте тестовое письмо на `mail-tester.com` (адрес выдаётся на их
сайте) — получите подробный отчёт 0–10. Цель ≥ 8. Чаще всего минусы:

- нет SPF/DKIM/DMARC у своего домена (см. секцию DNS выше);
- SMTP_FROM не совпадает с SMTP_USER и не настроен как send-as alias —
  Google переписывает From, и DKIM-подпись может оказаться от чужого
  домена;
- HTML-письмо без plain-text alternative (у нас оба есть в
  `src/lib/server/email/`, проверьте, что не сломали).

## Известные ошибки

| Ошибка в логе | Что значит | Что делать |
|---|---|---|
| `535 5.7.8 Username and Password not accepted` | Неверный App Password или 2FA не включена. | Перегенерировать App Password, проверить SMTP_USER. |
| `534 5.7.9 Application-specific password required` | Включена 2FA, но используется обычный пароль. | Создать App Password (см. выше). |
| `421 4.7.0 Try again later` | Превышен суточный лимит или подозрительная активность. | Подождать 24 часа, разнести отправку по времени, или перейти на Workspace/ESP. |
| `EAUTH: Invalid login` | nodemailer не может авторизоваться. | Проверить SMTP_USER == адрес аккаунта (не alias), App Password 16 символов без лишних пробелов. |
| `ECONNREFUSED smtp.gmail.com:465` | Хостер блокирует исходящий 465. | Попробовать 587 (STARTTLS), либо открыть тикет хостеру. |

## Безопасность

- App Password = bearer-токен на отправку от имени аккаунта. Утечка =
  спам с вашего домена. Храним в `/etc/tagcloud/tagcloud.env`
  (chmod 600, owner `tagcloud`).
- Ротация: раз в 6–12 месяцев или сразу после увольнения админа,
  имевшего доступ к серверу. На странице App Passwords у Google можно
  отозвать конкретный пароль, не трогая остальные интеграции.
- Если SMTP_FROM на собственном домене — DMARC начинаем с
  `p=quarantine` (мягкий режим), через 1–2 недели при стабильно
  зелёных отчётах ужесточаем до `p=reject`.
