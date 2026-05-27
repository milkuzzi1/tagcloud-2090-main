# Почта через Sender.net SMTP

Все письма (verification и итоги опросов) уходят через Sender.net SMTP.
Приложение авторизуется в Sender.net по SMTP-credentials и шлёт напрямую — ни
Postfix, ни OpenDKIM поднимать не нужно.

> Домен в примерах — `2090.fun`. Замените на свой, если другой.

## TL;DR

1. Зарегистрируйтесь на https://www.sender.net и активируйте
   Transactional emails.
2. Добавьте и верифицируйте домен отправителя.
3. Создайте SMTP-пользователя: Transactional emails → Setup instructions
   → SMTP → Add SMTP user.
4. Подставьте креденшалы в `/etc/tagcloud/tagcloud.env`:

   ```
   SMTP_HOST=smtp.sender.net
   SMTP_PORT=587
   SMTP_SECURE=false
   SMTP_USER=<SMTP-логин>
   SMTP_PASSWORD=<SMTP-пароль>
   SMTP_FROM="Tagcloud <noreply@2090.fun>"
   ```

5. `sudo systemctl restart tagcloud` — и письма пойдут.

## Подготовка аккаунта Sender.net

1. Зарегистрируйтесь на https://www.sender.net.
2. Перейдите в **Transactional emails** и убедитесь, что функция
   активирована.
3. Добавьте домен отправителя и пройдите верификацию (Sender.net
   попросит добавить DNS-записи — см. секцию DNS ниже).
4. Перейдите в **Transactional emails → Setup instructions → SMTP** и
   нажмите **Add SMTP user** — Sender.net сгенерирует логин и пароль.
5. Скопируйте логин и пароль в менеджер паролей и положите в
   `/etc/tagcloud/tagcloud.env` (chmod 600!).

## DNS-записи

Для верификации домена и хорошей доставляемости добавьте у регистратора
записи, которые предлагает Sender.net при добавлении домена:

| Тип | Имя | Значение | Зачем |
|---|---|---|---|
| TXT | `@` (SPF) | `v=spf1 include:sender.net -all` | Авторизуем серверы Sender.net как отправителей. |
| CNAME | (по инструкции Sender.net) | (по инструкции Sender.net) | DKIM-подпись Sender.net. |
| TXT | `_dmarc` | `v=DMARC1; p=quarantine; rua=mailto:postmaster@2090.fun; adkim=s; aspf=s` | Политика DMARC. |

Конкретные значения DKIM-записей выдаёт Sender.net при добавлении домена
в дашборде — следуйте их инструкциям.

## Лимиты Sender.net

Лимиты зависят от тарифного плана. Актуальные лимиты:
https://www.sender.net/pricing

## Проверки

### 1. SMTP_HOST доступен с сервера

```bash
nc -vz smtp.sender.net 587
# Connection to smtp.sender.net 587 port [tcp/submission] succeeded!
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
      --server smtp.sender.net:587 \
      --tls \
      --auth LOGIN \
      --auth-user '<SMTP-логин>' \
      --auth-password '<SMTP-пароль>' \
      --header "Subject: tagcloud smtp test"
# Ожидаем 250 2.0.0 OK на финальной строке.
```

### 3. Письма не падают в спам

Отправьте тестовое письмо на `mail-tester.com` (адрес выдаётся на их
сайте) — получите подробный отчёт 0–10. Цель ≥ 8. Чаще всего минусы:

- нет SPF/DKIM/DMARC у своего домена (см. секцию DNS выше);
- SMTP_FROM не совпадает с verified domain в Sender.net;
- HTML-письмо без plain-text alternative (у нас оба есть в
  `src/lib/server/email/`, проверьте, что не сломали).

## Известные ошибки

| Ошибка в логе | Что значит | Что делать |
|---|---|---|
| `535 Authentication failed` | Неверные SMTP-credentials. | Проверить SMTP_USER и SMTP_PASSWORD, при необходимости пересоздать SMTP-пользователя в Sender.net. |
| `EAUTH: Invalid login` | nodemailer не может авторизоваться. | Проверить SMTP_USER и SMTP_PASSWORD, убедиться что нет лишних пробелов. |
| `ECONNREFUSED smtp.sender.net:587` | Хостер блокирует исходящий 587. | Попробовать порт 2525, либо открыть тикет хостеру. |
| `550 Sender not verified` | SMTP_FROM не верифицирован в Sender.net. | Добавить и верифицировать домен/адрес в дашборде Sender.net. |

## Безопасность

- SMTP-credentials = bearer-токен на отправку от имени аккаунта. Утечка =
  спам с вашего домена. Храним в `/etc/tagcloud/tagcloud.env`
  (chmod 600, owner `tagcloud`).
- Ротация: при необходимости удалите старого SMTP-пользователя и создайте
  нового в Sender.net (Transactional emails → Setup instructions → SMTP).
- DMARC начинаем с `p=quarantine` (мягкий режим), через 1–2 недели при
  стабильно зелёных отчётах ужесточаем до `p=reject`.
