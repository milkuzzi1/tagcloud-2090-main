import { env } from '$env/dynamic/private';
import { getTransporter } from './smtp';
import { getLogoPng, getPublicLogoUrl } from './logo';
import { escapeHtml } from './escape';

const NAVY = '#0E2A5C';
const MUTED = '#6B7280';
const TEXT = '#1A1A1A';
const BORDER = '#E5E7EB';
const SURFACE = '#F7F8FA';

export type PasswordResetEmailInput = {
  to: string;
  resetUrl: string;
  ttlHours: number;
  organizationName: string;
};

export function passwordResetHtml(input: PasswordResetEmailInput): string {
  const url = escapeHtml(input.resetUrl);
  const org = escapeHtml(input.organizationName);
  const logoSrc = getPublicLogoUrl() ?? 'cid:logo';
  return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${TEXT};background:#FFFFFF;margin:0;padding:24px;-webkit-font-smoothing:antialiased;">
  <table width="100%" style="max-width:560px;margin:0 auto;border-collapse:collapse;">
    <tr><td>
      <table style="width:100%;border-bottom:3px solid ${NAVY};padding-bottom:16px;border-collapse:collapse;">
        <tr>
          <td style="vertical-align:middle;width:56px;padding-right:14px;">
            <img src="${logoSrc}" alt="Школа №2090" width="48" height="48" style="display:block;border-radius:6px;">
          </td>
          <td style="vertical-align:middle;">
            <div style="font-weight:600;color:${NAVY};font-size:12px;letter-spacing:0.06em;text-transform:uppercase;">Облако тегов · ${org}</div>
            <h1 style="font-size:20px;margin:4px 0 0;color:${NAVY};font-weight:600;">Сброс пароля</h1>
          </td>
        </tr>
      </table>
      <p style="margin:24px 0 20px;line-height:1.5;">Нажмите кнопку, чтобы задать новый пароль:</p>
      <p style="text-align:center;margin:24px 0;">
        <a href="${url}" style="display:inline-block;background:${NAVY};color:#FFFFFF;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:500;font-size:15px;">Задать новый пароль</a>
      </p>
      <p style="color:${MUTED};font-size:13px;margin:20px 0 6px;">Если кнопка не работает, скопируйте адрес в браузер:</p>
      <p style="word-break:break-all;font-family:'SF Mono',Menlo,monospace;font-size:12px;color:${TEXT};background:${SURFACE};padding:10px 12px;border-radius:6px;border:1px solid ${BORDER};margin:0;">${url}</p>
      <p style="color:${MUTED};font-size:12px;margin:28px 0 0;border-top:1px solid ${BORDER};padding-top:16px;line-height:1.5;">
        Ссылка действует ${input.ttlHours} ${input.ttlHours === 1 ? 'час' : 'часа'}. Если вы не запрашивали сброс — просто проигнорируйте письмо.
      </p>
    </td></tr>
  </table>
</body></html>`;
}

export function passwordResetText(input: PasswordResetEmailInput): string {
  return [
    `Сброс пароля — ${input.organizationName} · Облако тегов`,
    '',
    'Перейдите по ссылке, чтобы задать новый пароль:',
    input.resetUrl,
    '',
    `Ссылка действует ${input.ttlHours} ${input.ttlHours === 1 ? 'час' : 'часа'}.`,
    'Если вы не запрашивали сброс — проигнорируйте письмо.'
  ].join('\n');
}

export async function sendPasswordResetEmail(input: PasswordResetEmailInput): Promise<void> {
  const t = getTransporter();
  if (!t) throw new Error('SMTP не настроен (SMTP_HOST пуст)');

  const fromAddr = env.SMTP_FROM ?? env.SMTP_USER;
  if (!fromAddr) throw new Error('SMTP_FROM не задан (и SMTP_USER пуст)');
  const logo = await getLogoPng();

  await t.sendMail({
    from: fromAddr,
    to: input.to,
    subject: `Сброс пароля — ${input.organizationName}`,
    text: passwordResetText(input),
    html: passwordResetHtml(input),
    attachments: logo
      ? [{ filename: 'logo.png', content: logo, contentType: 'image/png', cid: 'logo' }]
      : []
  });
}
