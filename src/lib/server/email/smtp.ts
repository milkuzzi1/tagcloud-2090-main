import { createTransport, type Transporter } from 'nodemailer';
import { env } from '$env/dynamic/private';

let _transporter: Transporter | null = null;

/**
 * Создаёт (один раз) и возвращает SMTP-транспорт. Возвращает null, если
 * SMTP_HOST не задан — вызывающий код сам решает, что делать (в проде
 * — кинуть понятную ошибку, в dev — молча пропустить отправку).
 *
 * Дефолтный сценарий — SendPulse SMTP (STARTTLS на 587):
 *
 *   SMTP_HOST=smtp-pulse.com
 *   SMTP_PORT=587
 *   SMTP_SECURE=false
 *   SMTP_USER=<email от аккаунта SendPulse>
 *   SMTP_PASSWORD=<SMTP-пароль из SendPulse, см. Settings → SMTP>
 *   SMTP_FROM="Tagcloud <noreply@yourdomain.tld>"
 *
 * Альтернативные порты SendPulse: 2525 (если 587 заблокирован хостером)
 * и 465 (implicit TLS, тогда SMTP_SECURE=true).
 *
 * Для SendPulse:
 *   - Включите SMTP в личном кабинете и подтвердите домен отправителя
 *     (SPF/DKIM записи).
 *   - SMTP_FROM должен быть verified sender/domain.
 *
 * Auth подключается только если заданы И SMTP_USER, И SMTP_PASSWORD.
 * Без auth (например, локальный MailHog в dev на 127.0.0.1:1025) транспорт
 * уйдёт без креденшалов.
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
