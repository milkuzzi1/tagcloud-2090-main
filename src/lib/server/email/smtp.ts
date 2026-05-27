import { createTransport, type Transporter } from 'nodemailer';
import { env } from '$env/dynamic/private';

let _transporter: Transporter | null = null;

/**
 * Создаёт (один раз) и возвращает SMTP-транспорт. Возвращает null, если
 * SMTP_HOST не задан — вызывающий код сам решает, что делать (в проде
 * — кинуть понятную ошибку, в dev — молча пропустить отправку).
 *
 * Дефолтный сценарий — Sender.net SMTP (STARTTLS на 587):
 *
 *   SMTP_HOST=smtp.sender.net
 *   SMTP_PORT=587
 *   SMTP_SECURE=false
 *   SMTP_USER=<SMTP-пользователь из Sender.net>
 *   SMTP_PASSWORD=<SMTP-пароль из Sender.net>
 *   SMTP_FROM="Tagcloud <noreply@yourdomain.tld>"
 *
 * Альтернативный порт — 2525 (если 587 заблокирован хостером).
 *
 * Для Sender.net:
 *   - Создайте SMTP-пользователя: Transactional emails → Setup instructions → SMTP → Add SMTP user.
 *   - SMTP_FROM должен быть verified sender/domain в Sender.net.
 *
 * Auth подключается только если заданы И SMTP_USER, И SMTP_PASSWORD —
 * для Sender.net оба обязательны. Без auth (например, локальный MailHog
 * в dev на 127.0.0.1:1025) транспорт уйдёт без креденшалов.
 */
export function getTransporter(): Transporter | null {
  if (_transporter) return _transporter;
  if (!env.SMTP_HOST) return null;

  const port = Number(env.SMTP_PORT ?? 587);
  // Если SMTP_SECURE не задан — выводим из порта: 465 = implicit TLS,
  // всё остальное (25/587/1025) = plain или STARTTLS поверх plain.
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
