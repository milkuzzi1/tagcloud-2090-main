import { json } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { LoginSchema } from '$lib/server/auth/validation';
import { login } from '$lib/server/auth/service';
import { COOKIE_NAME } from '$lib/server/auth/sessions';
import { checkAuthRateLimit } from '$lib/server/voting/rate-limit';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, cookies, getClientAddress }) => {
const raw = await request.json().catch(() => null);
const parsed = LoginSchema.safeParse(raw);
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

const result = await login(parsed.data);
if (!result.ok) {
  if (result.code === 'email_not_verified') {
    return json(
      { error: { code: result.code, message: result.message, email: result.email } },
      { status: 403 }
    );
  }
  return json({ error: { code: result.code, message: result.message } }, { status: 401 });
}

cookies.set(COOKIE_NAME, result.sessionId, {
  path: '/',
  httpOnly: true,
  sameSite: 'lax',
  secure: !dev,
  expires: result.expiresAt
});

return json({ user: result.user }, { status: 200 });
};
