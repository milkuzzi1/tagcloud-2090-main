import { createTransport, type Transporter } from 'nodemailer';
import { env } from '$env/dynamic/private';

let _transporter: Transporter | null = null;

/**
 * Создаёт (один раз) и возвращает SMTP-транспорт. Возвращает null, если
 * SMTP_HOST не задан — вызывающий код сам решает, что делать (в проде
 * — кинуть понятную ошибку, в dev — молча пропустить отправку).
 *
 * Дефолтный сценарий — Gmail SMTP (implicit TLS на 465):
 *
 *   SMTP_HOST=smtp.gmail.com
 *   SMTP_PORT=465
 *   SMTP_SECURE=true
 *   SMTP_USER=your-account@gmail.com
 *   SMTP_PASSWORD=<App Password из https://myaccount.google.com/apppasswords>
 *   SMTP_FROM="Tagcloud <your-account@gmail.com>"
 *
 * Альтернатива — STARTTLS на 587 (если 465 заблокирован файрволом):
 *
 *   SMTP_HOST=smtp.gmail.com
 *   SMTP_PORT=587
 *   SMTP_SECURE=false
 *
 * Для Gmail обязательны:
 *   - 2-Step Verification на аккаунте;
 *   - App Password (обычный пароль не подойдёт — Google блокирует
 *     «less secure apps»);
 *   - SMTP_FROM должен совпадать с SMTP_USER (или быть verified send-as
 *     alias в настройках Gmail), иначе Google молча перепишет From.
 *
 * Auth подключается только если заданы И SMTP_USER, И SMTP_PASSWORD —
 * для Gmail оба обязательны. Без auth (например, локальный MailHog
 * в dev на 127.0.0.1:1025) транспорт уйдёт без креденшалов.
 */
export function getTransporter(): Transporter | null {
  if (_transporter) return _transporter;
  if (!env.SMTP_HOST) return null;

  const port = Number(env.SMTP_PORT ?? 465);
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
