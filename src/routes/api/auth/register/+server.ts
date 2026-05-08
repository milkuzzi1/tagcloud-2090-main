import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { CredentialsSchema } from '$lib/server/auth/validation';
import { register } from '$lib/server/auth/service';
import { COOKIE_NAME, createSession } from '$lib/server/auth/sessions';
import { VERIFICATION_TTL_HOURS } from '$lib/server/auth/verification';
import { sendVerificationEmail } from '$lib/server/email/verification';
import { checkAuthRateLimit } from '$lib/server/voting/rate-limit';
import { log } from '$lib/server/log';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, url, getClientAddress, cookies }) => {
  const raw = await request.json().catch(() => null);
  const parsed = CredentialsSchema.safeParse(raw);
  if (!parsed.success) {
    return json({ error: { code: 'invalid_input', issues: parsed.error.issues } }, { status: 400 });
  }

  const rl = await checkAuthRateLimit(getClientAddress(), parsed.data.email);
  if (!rl.allowed) {
    return json(
      { error: { code: 'rate_limited', message: 'Слишком много попыток, попробуйте позже' } },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
    );
  }

  const result = await register(parsed.data);
  if (!result.ok) {
    return json({ error: { code: result.code, message: result.message } }, { status: 409 });
  }

  // Временный режим без подтверждения email (AUTH_DISABLE_EMAIL_VERIFICATION=true).
  // Сразу создаём сессию и логиним пользователя — SMTP не дёргаем вообще,
  // потому что флаг включают именно тогда, когда отправка писем недоступна.
  if (result.status === 'auto_verified') {
    log.warn('register_auto_verified', { userId: result.user.id });
    const { id: sessionId, expiresAt } = await createSession(result.user.id);
    cookies.set(COOKIE_NAME, sessionId, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      expires: expiresAt
    });
    return json(
      { ok: true, status: result.status, user: result.user, autoVerified: true },
      { status: 200 }
    );
  }

  // Базовый URL для ссылки в письме: предпочитаем PUBLIC_BASE_URL (за reverse-proxy
  // url.origin может вернуть localhost), затем ORIGIN, затем фактический origin.
  const baseUrl = env.PUBLIC_BASE_URL || env.ORIGIN || url.origin;
  const verifyUrl = `${baseUrl}/verify?t=${result.verification.token}`;

  try {
    await sendVerificationEmail({
      to: result.user.email,
      verifyUrl,
      ttlHours: VERIFICATION_TTL_HOURS
    });
  } catch (err) {
    // Не возвращаем 500: пользователь может запросить переотправку через
    // /api/auth/resend-verification. В логи кладём детали для отладки SMTP.
    log.error('register_send_verification_failed', {
      err: err instanceof Error ? err.message : String(err)
    });
  }

  return json(
    {
      ok: true,
      status: result.status,
      email: result.user.email,
      ttlHours: VERIFICATION_TTL_HOURS
    },
    { status: 202 }
  );
};
