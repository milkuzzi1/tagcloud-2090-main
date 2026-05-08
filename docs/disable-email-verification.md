# Временное отключение подтверждения email при регистрации

Этот документ описывает kill switch для подтверждения email — нужен на
случай, когда SMTP физически недоступен (например, провайдер блокирует
исходящий 465/587 и саппорт ещё не разблокировал порт).

> **Важно.** Это временная мера. Сразу после восстановления SMTP
> верните флаг в `false` (или удалите). Пока флаг включён, любой может
> зарегистрироваться на чужой email и сразу получить сессию — это
> позволяет «угонять» ghost-учётки из миграции `0002_backfill_users` и
> создаёт другие риски, ради которых verification и существует.

## Что меняется при включении

Когда `AUTH_DISABLE_EMAIL_VERIFICATION=true`:

- `POST /api/auth/register` НЕ создаёт verification-токен и НЕ дёргает
  SMTP. Новый пользователь сразу помечается `email_verified=true`.
- В ответе на регистрацию приходит `200 OK` с
  `{ ok: true, status: 'auto_verified', autoVerified: true, user }` и
  выставляется session-cookie `tagcloud_session` — пользователь сразу
  залогинен.
- UI на `/register` редиректит на `/my` вместо экрана «Письмо отправлено».
- `POST /api/auth/login` работает без изменений: пользователи, созданные
  с включённым флагом, проходят как обычные verified-аккаунты.
- В логах при каждой такой регистрации появляется warn-запись
  `register_auto_verified` — удобно потом проверить, кого надо
  «дореверифицировать» вручную, если решите вернуть строгий режим.

`POST /api/auth/resend-verification` остаётся как есть и просто отдаёт
202 (он уже идемпотентный и не раскрывает наличие email).

## Применение правки

Правка уже в коде. На сервере остаётся только включить флаг и
перезапустить сервис.

### 1. Подтянуть код

```bash
cd /opt/tagcloud
sudo -u tagcloud git fetch origin
sudo -u tagcloud git checkout main
sudo -u tagcloud git pull --ff-only
```

> Если используете другую ветку (или ещё не успели смержить PR) —
> сделайте `git checkout <ветка>` и `git pull`.

### 2. Поставить зависимости и пересобрать

```bash
sudo -u tagcloud npm ci
sudo -u tagcloud npm run build
```

Миграции БД не требуются — схема не менялась, флаг работает на
существующих колонках `users.email_verified` / `email_verified_at`.

### 3. Включить флаг

Добавьте строку в `/etc/tagcloud/tagcloud.env`:

```ini
AUTH_DISABLE_EMAIL_VERIFICATION=true
```

(см. блок-комментарий с тем же именем в `deploy/tagcloud.env.example`).

Любое значение, кроме строки `true`, считается выключенным —
подтверждение email работает в обычном режиме.

### 4. Перезапустить сервис

```bash
sudo systemctl restart tagcloud
sudo systemctl status tagcloud
sudo journalctl -u tagcloud -n 100 --no-pager
```

В логах должно быть `Listening on …` и никаких ошибок SMTP при
последующей регистрации.

### 5. Smoke-test

1. Открыть `https://<ваш-домен>/register`, ввести новый email и пароль.
2. После сабмита страница должна сразу уйти на `/my` (а не на экран
   «Письмо отправлено»).
3. В логах появится запись `register_auto_verified` с `userId`.
4. Логаут → логин с тем же email/паролем должен пройти без ошибки
   `email_not_verified`.

## Откат после разблокировки порта

1. В `/etc/tagcloud/tagcloud.env` удалите/закомментируйте строку
   `AUTH_DISABLE_EMAIL_VERIFICATION=true` (или поставьте `=false`).
2. Убедитесь, что `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` /
   `SMTP_PASSWORD` / `SMTP_FROM` заполнены корректно, и что письмо
   реально доходит:

   ```bash
   sudo journalctl -u tagcloud -f &
   curl -fsS -X POST https://<ваш-домен>/api/auth/resend-verification \
     -H 'content-type: application/json' \
     -d '{"email":"<тестовый-адрес>"}'
   ```

   В логах не должно быть `resend_verification_send_failed`.
3. `sudo systemctl restart tagcloud`.
4. Проверьте, что новая регистрация снова показывает экран «Письмо
   отправлено» и в почте лежит письмо с подтверждением.

## Что делать с пользователями, зарегистрировавшимися «без письма»

После выключения флага такие аккаунты остаются полностью валидными —
у них в БД `email_verified=true`, и login работает как обычно. Если
по политике нужно заставить их пройти verification ещё раз, можно
точечно прогнать SQL по `userId` из логов `register_auto_verified`:

```sql
UPDATE users
SET email_verified = false, email_verified_at = NULL
WHERE id = '<uuid>';
```

После этого пользователь при следующем входе получит
`email_not_verified` и сможет нажать «Отправить письмо ещё раз».
