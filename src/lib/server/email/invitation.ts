import { env } from '$env/dynamic/private';
import { getTransporter } from './smtp';
import { getPublicLogoUrl } from './logo';
import { escapeHtml } from './escape';

const NAVY = '#0E2A5C';
const MUTED = '#6B7280';
const TEXT = '#1A1A1A';
const BORDER = '#E5E7EB';
const SURFACE = '#F7F8FA';

export type InvitationEmailInput = {
  to: string;
  inviteUrl: string;
  organizationName: string;
};

export function invitationHtml(input: InvitationEmailInput): string {
  const url = escapeHtml(input.inviteUrl);
  const org = escapeHtml(input.organizationName);
  const logoSrc = getPublicLogoUrl();
  const logoImg = logoSrc
    ? `<td style="vertical-align:middle;width:56px;padding-right:14px;">
            <img src="${logoSrc}" alt="Школа №2090" width="48" height="48" style="display:block;border-radius:6px;">
          </td>`
    : '';
  return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${TEXT};background:#FFFFFF;margin:0;padding:24px;-webkit-font-smoothing:antialiased;">
  <table width="100%" style="max-width:560px;margin:0 auto;border-collapse:collapse;">
    <tr><td>
      <table style="width:100%;border-bottom:3px solid ${NAVY};padding-bottom:16px;border-collapse:collapse;">
        <tr>
          ${logoImg}
          <td style="vertical-align:middle;">
            <div style="font-weight:600;color:${NAVY};font-size:12px;letter-spacing:0.06em;text-transform:uppercase;">Облако тегов · Приглашение</div>
            <h1 style="font-size:20px;margin:4px 0 0;color:${NAVY};font-weight:600;">Вас пригласили в «${org}»</h1>
          </td>
        </tr>
      </table>
      <p style="margin:24px 0 20px;line-height:1.5;">Администратор организации добавил ваш email в список разрешённых пользователей. Чтобы получить доступ, зарегистрируйтесь:</p>
      <p style="text-align:center;margin:24px 0;">
        <a href="${url}" style="display:inline-block;background:${NAVY};color:#FFFFFF;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:500;font-size:15px;">Зарегистрироваться</a>
      </p>
      <p style="color:${MUTED};font-size:13px;margin:20px 0 6px;">Если кнопка не работает, скопируйте адрес в браузер:</p>
      <p style="word-break:break-all;font-family:'SF Mono',Menlo,monospace;font-size:12px;color:${TEXT};background:${SURFACE};padding:10px 12px;border-radius:6px;border:1px solid ${BORDER};margin:0;">${url}</p>
      <p style="color:${MUTED};font-size:12px;margin:28px 0 0;border-top:1px solid ${BORDER};padding-top:16px;line-height:1.5;">
        Если вы не ожидаете приглашения от организации «${org}» — просто проигнорируйте это письмо.
      </p>
    </td></tr>
  </table>
</body></html>`;
}

export function invitationText(input: InvitationEmailInput): string {
  return [
    `Вас пригласили в «${input.organizationName}» — Облако тегов`,
    '',
    'Администратор организации добавил ваш email в список разрешённых пользователей.',
    '',
    'Зарегистрируйтесь по ссылке:',
    input.inviteUrl,
    '',
    'Если вы не ожидаете приглашения — проигнорируйте письмо.'
  ].join('\n');
}

export async function sendInvitationEmail(input: InvitationEmailInput): Promise<void> {
  const t = getTransporter();
  if (!t) throw new Error('SMTP не настроен (SMTP_HOST пуст)');

  const fromAddr = env.SMTP_FROM ?? env.SMTP_USER;
  if (!fromAddr) throw new Error('SMTP_FROM не задан (и SMTP_USER пуст)');

  await t.sendMail({
    from: fromAddr,
    to: input.to,
    subject: `Вас пригласили в «${input.organizationName}» — Облако тегов`,
    text: invitationText(input),
    html: invitationHtml(input)
  });
}
