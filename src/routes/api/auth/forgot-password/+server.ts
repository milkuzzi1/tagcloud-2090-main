import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { ForgotPasswordSchema } from '$lib/server/auth/validation';
import { requestPasswordReset } from '$lib/server/auth/service';
import { PASSWORD_RESET_TTL_HOURS } from '$lib/server/auth/password-reset';
import { sendPasswordResetEmail } from '$lib/server/email/password-reset';
import { checkAuthRateLimit } from '$lib/server/voting/rate-limit';
import { log } from '$lib/server/log';
import type { RequestHandler } from './$types';

/**
* POST /api/auth/forgot-password
*
* Идемпотентно возвращает 202 — независимо от того, существует ли пользователь.
* Защита от email enumeration: атакующий не может отличить «нет такой пары
* (org, email)» от «есть, письмо отправлено».
*/
export const POST: RequestHandler = async ({ request, url, locals }) => {
 const raw = await request.json().catch(() => null);
 const parsed = ForgotPasswordSchema.safeParse(raw);
 if (!parsed.success) {
   return json({ error: { code: 'invalid_input', issues: parsed.error.issues } }, { status: 400 });
 }

 const rl = await checkAuthRateLimit(locals.clientIp, parsed.data.email);
 if (!rl.allowed) {
   return json(
     { error: { code: 'rate_limited', message: 'Слишком много попыток, попробуйте позже' } },
     { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
   );
 }

 const result = await requestPasswordReset(parsed.data);

 if (result.sent) {
   const baseUrl = env.PUBLIC_BASE_URL || env.ORIGIN || url.origin;
   const resetUrl = `${baseUrl}/reset-password?t=${result.token.token}`;
   try {
     await sendPasswordResetEmail({
       to: result.email,
       resetUrl,
       ttlHours: PASSWORD_RESET_TTL_HOURS,
       organizationName: result.organizationName
     });
   } catch (err) {
     log.error('forgot_password_send_failed', {
       err: err instanceof Error ? err.message : String(err)
     });
   }
 }

 return json({ ok: true, ttlHours: PASSWORD_RESET_TTL_HOURS }, { status: 202 });
};
