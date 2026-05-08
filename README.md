## Инструкции по деплою — `deploy/README.md` (всё на одной VPS, домен `2090.fun`).

## Локальный запуск

```bash
# 1. Установить зависимости
npm install

# 2. Скопировать env
cp .env.example .env

# 3. Заполнить SMTP в .env
# Все письма (verification, итоги опросов) уходят через Gmail SMTP. Чтобы
# письма реально отправлялись:
#   а) включить 2-Step Verification на Google-аккаунте;
#   б) создать App Password: https://myaccount.google.com/apppasswords
#      (обычный пароль не подойдёт — Google режет «less secure apps»);
#   в) подставить адрес аккаунта в SMTP_USER и SMTP_FROM, App Password — в
#      SMTP_PASSWORD.
# Если App Password нет под рукой — в dev можно поднять MailHog:
#   docker run -d -p 1025:1025 -p 8025:8025 mailhog/mailhog
# и выставить SMTP_HOST=127.0.0.1 / SMTP_PORT=1025 / SMTP_SECURE=false без
# SMTP_USER/SMTP_PASSWORD.
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your-account@gmail.com
SMTP_PASSWORD=your-16-char-app-password
SMTP_FROM="Tagcloud <your-account@gmail.com>"

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
