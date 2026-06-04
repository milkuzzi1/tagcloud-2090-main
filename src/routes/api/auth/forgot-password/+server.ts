import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { ForgotPasswordSchema } from '$lib/server/auth/validation';
import { requestPasswordReset } from '$lib/server/auth/service';
import { PASSWORD_RESET_TTL_HOURS } from '$lib/server/auth/password-reset';
import { sendPasswordResetEmail } from '$lib/server/email/password-reset';
import { checkAuthRateLimit } from '$lib/server/voting/rate-limit';
import { log } from '$lib/server/log';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, url, locals }) => {
  const raw = await request.json().catch(() => null);
  const parsed = ForgotPasswordSchema.safeParse(raw);
  if (!parsed.success) {
    return json({ error: { code: 'invalid_input', issues: parsed.error.issues } }, { status: 400 });
  }

  const rl = await checkAuthRateLimit(locals.clientIp, parsed.data.email);
  if (!rl.allowed) {
    return json(
      { error: { code: 'rate_limited', message: '\u0421\u043b\u0438\u0448\u043a\u043e\u043c \u043c\u043d\u043e\u0433\u043e \u043f\u043e\u043f\u044b\u0442\u043e\u043a, \u043f\u043e\u043f\u0440\u043e\u0431\u0443\u0439\u0442\u0435 \u043f\u043e\u0437\u0436\u0435' } },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
    );
  }

  const result = await requestPasswordReset(parsed.data);

  if (result.sent) {
    const baseUrl = env.PUBLIC_BASE_URL || env.ORIGIN || url.origin;
    const resetUrl = `${baseUrl}/reset-password?t=${result.token.token}`;
    const organizationName = env.APP_NAME || '\u041e\u0431\u043b\u0430\u043a\u043e \u0442\u0435\u0433\u043e\u0432 2090';
    try {
      await sendPasswordResetEmail({
        to: result.email,
        resetUrl,
        ttlHours: PASSWORD_RESET_TTL_HOURS,
        organizationName
      });
    } catch (err) {
      log.error('forgot_password_send_failed', {
        err: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return json({ ok: true, ttlHours: PASSWORD_RESET_TTL_HOURS }, { status: 202 });
};
