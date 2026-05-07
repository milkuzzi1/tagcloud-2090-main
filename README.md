## Инструкции по деплою — `deploy/README.md` (всё на одной VPS, домен `2090.fun`).

## Локальный запуск

```bash
# 1. Установить зависимости
npm install

# 2. Скопировать env
cp .env.example .env

# 3. (Опционально) поправить SMTP в .env
# По умолчанию app ходит на 127.0.0.1:25 без авторизации — ожидается
# локальный Postfix. Если его нет — отправка писем (verification, итоги
# опросов) будет падать; всё остальное работает. Для разработки можно
# поднять MailHog: `docker run -d -p 1025:1025 -p 8025:8025 mailhog/mailhog`
# и выставить SMTP_HOST=127.0.0.1 / SMTP_PORT=1025.
SMTP_HOST=127.0.0.1
SMTP_PORT=25
SMTP_SECURE=false
SMTP_FROM="Tagcloud <noreply@2090.fun>"

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
