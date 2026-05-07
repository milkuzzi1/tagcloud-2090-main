import { createTransport, type Transporter } from 'nodemailer';
import { env } from '$env/dynamic/private';

let _transporter: Transporter | null = null;

/**
 * Создаёт (один раз) и возвращает SMTP-транспорт. Возвращает null, если
 * SMTP_HOST не задан — вызывающий код сам решает, что делать (в проде
 * — кинуть понятную ошибку, в dev — молча пропустить отправку).
 *
 * Поддерживаемые сценарии:
 *
 *   1. Локальный mail-сервер на той же машине (self-host, рекомендуется
 *      для одной VPS под фронтенд + API + почту):
 *        SMTP_HOST=127.0.0.1
 *        SMTP_PORT=25
 *        SMTP_SECURE=false
 *        SMTP_USER / SMTP_PASSWORD не задаются.
 *      Postfix слушает только на loopback, доверяет mynetworks=127.0.0.0/8
 *      и сам подписывает исходящее DKIM-ом + релеит наружу.
 *
 *   2. Удалённый submission на свой mail-сервер (с TLS + auth):
 *        SMTP_HOST=mail.2090.fun
 *        SMTP_PORT=587
 *        SMTP_SECURE=false (STARTTLS)
 *        SMTP_USER=app@2090.fun
 *        SMTP_PASSWORD=…
 *
 *   3. Внешний провайдер (Yandex/Mailgun/SES/…) — implicit TLS на 465:
 *        SMTP_HOST=smtp.example.com
 *        SMTP_PORT=465
 *        SMTP_SECURE=true
 *        SMTP_USER=…
 *        SMTP_PASSWORD=…
 *
 * Auth подключается только если заданы И SMTP_USER, И SMTP_PASSWORD —
 * иначе nodemailer ходит без аутентификации (нужно для loopback-сценария).
 */
export function getTransporter(): Transporter | null {
  if (_transporter) return _transporter;
  if (!env.SMTP_HOST) return null;

  const port = Number(env.SMTP_PORT ?? 25);
  // Если SMTP_SECURE не задан — выводим из порта: 465 = implicit TLS,
  // всё остальное (25/587) = plain или STARTTLS поверх plain.
  const secure = env.SMTP_SECURE != null ? env.SMTP_SECURE !== 'false' : port === 465;

  const auth =
    env.SMTP_USER && env.SMTP_PASSWORD
      ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD }
      : undefined;

  _transporter = createTransport({
    host: env.SMTP_HOST,
    port,
    secure,
    auth,
    connectionTimeout: 8_000,
    greetingTimeout: 8_000,
    socketTimeout: 15_000
  });
  return _transporter;
}
