import { json } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { z } from 'zod';
import { RegisterSchema } from '$lib/server/auth/validation';
import { register, registerAdmin } from '$lib/server/auth/service';
import { COOKIE_NAME, createSession } from '$lib/server/auth/sessions';
import { VERIFICATION_TTL_HOURS } from '$lib/server/auth/verification';
import { sendVerificationEmail } from '$lib/server/email/verification';
import { checkAuthRateLimit } from '$lib/server/voting/rate-limit';
import { log } from '$lib/server/log';
import type { RequestHandler } from './$types';

const RoleSchema = z.enum(['admin', 'user']);

export const POST: RequestHandler = async ({ request, url, locals, cookies }) => {
  const raw = await request.json().catch(() => null);

  const roleParse = RoleSchema.safeParse(
    raw && typeof raw === 'object' ? (raw as { role?: unknown }).role : undefined
  );
  if (!roleParse.success) {
    return json(
      { error: { code: 'invalid_input', message: 'Не указан режим регистрации' } },
      { status: 400 }
    );
  }
  const role = roleParse.data;

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

  const result = role === 'admin'
    ? await registerAdmin(parsed.data)
    : await register(parsed.data);

  if (!result.ok) {
    return json({ error: { code: result.code, message: result.message } }, { status: 409 });
  }

  if (result.status === 'auto_verified') {
    log.warn('register_auto_verified', { userId: result.user.id, role });
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

  const baseUrl = env.PUBLIC_BASE_URL || env.ORIGIN || url.origin;
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
