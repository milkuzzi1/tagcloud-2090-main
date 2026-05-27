## Инструкции по деплою — `deploy/README.md` (всё на одной VPS, домен `2090.fun`).

## Локальный запуск

```bash
# 1. Установить зависимости
npm install

# 2. Скопировать env
cp .env.example .env

# 3. Заполнить SMTP в .env
# Все письма (verification, итоги опросов) уходят через Sender.net SMTP.
# Чтобы письма реально отправлялись:
#   а) зарегистрироваться на https://www.sender.net и активировать
#      Transactional emails;
#   б) добавить и верифицировать домен отправителя;
#   в) создать SMTP-пользователя: Transactional emails → Setup instructions
#      → SMTP → Add SMTP user;
#   г) подставить логин в SMTP_USER, пароль — в SMTP_PASSWORD.
# Если учётки Sender.net нет под рукой — в dev можно поднять MailHog:
#   docker run -d -p 1025:1025 -p 8025:8025 mailhog/mailhog
# и выставить SMTP_HOST=127.0.0.1 / SMTP_PORT=1025 / SMTP_SECURE=false без
# SMTP_USER/SMTP_PASSWORD.
SMTP_HOST=smtp.sender.net
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-smtp-user
SMTP_PASSWORD=your-smtp-password
SMTP_FROM="Tagcloud <noreply@yourdomain.tld>"

# 4. Запуск Postgres + Redis
npm run db:up

# 5. Применение миграций
# Миграции из drizzle/ уже в репо — генерировать заново не нужно.
npm run db:migrate

# 6. Запуск
npm run dev
```

> `npm run db:generate` запускайте только если меняете схему в `src/lib/server/schema.ts`.
> На свежем чек-ауте он создаст дубликат миграции, которая конфликтует с baseline
> (`type "answer_type" already exists`).
