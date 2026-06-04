import { json } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { RegisterSchema } from '$lib/server/auth/validation';
import { register } from '$lib/server/auth/service';
import { COOKIE_NAME, createSession } from '$lib/server/auth/sessions';
import { VERIFICATION_TTL_HOURS } from '$lib/server/auth/verification';
import { sendVerificationEmail } from '$lib/server/email/verification';
import { checkAuthRateLimit } from '$lib/server/voting/rate-limit';
import { resolvePublicBaseUrl } from '$lib/server/net/base-url';
import { log } from '$lib/server/log';
import type { RequestHandler } from './$types';

// Public registration is only allowed for role="user".
// Admin accounts are created exclusively by existing admins
// via POST /api/admin/create-admin.

export const POST: RequestHandler = async ({ request, url, locals, cookies }) => {
  const raw = await request.json().catch(() => null);

  // Block any attempt to register as admin via public endpoint
  if (raw && typeof raw === 'object' && (raw as { role?: unknown }).role === 'admin') {
    return json(
      { error: { code: 'forbidden', message: 'Регистрация администратора недоступна' } },
      { status: 403 }
    );
  }

  const parsed = RegisterSchema.safeParse(raw);
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

  const result = await register(parsed.data);

  if (!result.ok) {
    return json({ error: { code: result.code, message: result.message } }, { status: 409 });
  }

  if (result.status === 'auto_verified') {
    log.warn('register_auto_verified', { userId: result.user.id });
    const { id: sessionId, expiresAt } = await createSession(result.user.id);
    cookies.set(COOKIE_NAME, sessionId, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: !dev,
      expires: expiresAt
    });
    return json(
      { ok: true, status: result.status, user: result.user, autoVerified: true },
      { status: 200 }
    );
  }

  const baseUrl = resolvePublicBaseUrl(url.origin);
  const verifyUrl = `${baseUrl}/verify?t=${result.verification.token}`;

  try {
    await sendVerificationEmail({
      to: result.user.email,
      verifyUrl,
      ttlHours: VERIFICATION_TTL_HOURS
    });
  } catch (err) {
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
