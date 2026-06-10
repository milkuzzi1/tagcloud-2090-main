import { json } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { ResetPasswordSchema } from '$lib/server/auth/validation';
import { consumePasswordReset } from '$lib/server/auth/service';
import { COOKIE_NAME } from '$lib/server/auth/sessions';
import { checkAuthRateLimit } from '$lib/server/voting/rate-limit';
import type { RequestHandler } from './$types';

/**
 * POST /api/auth/reset-password
 *
 * Атомарно потребляет токен и устанавливает новый пароль. Все прежние
 * сессии пользователя инвалидируются (см. consumePasswordReset), создаётся
 * новая, и кука выставляется тут же — пользователь сразу залогинен.
 */
export const POST: RequestHandler = async ({ request, cookies, locals }) => {
  const raw = await request.json().catch(() => null);
  const parsed = ResetPasswordSchema.safeParse(raw);
  if (!parsed.success) {
    return json({ error: { code: 'invalid_input', issues: parsed.error.issues } }, { status: 400 });
  }

  // По IP лимитируем без email-бакета — email мы не знаем, пока токен не
  // консьюмили. IP-бакета достаточно для защиты от bruteforce токенов.
  const rl = await checkAuthRateLimit(locals.clientIp, 'reset-password');
  if (!rl.allowed) {
    return json(
      { error: { code: 'rate_limited', message: 'Слишком много попыток, попробуйте позже' } },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
    );
  }

  const result = await consumePasswordReset(parsed.data);
  if (!result.ok) {
    const status = result.code === 'invalid' ? 404 : 400;
    return json({ error: { code: result.code, message: result.message } }, { status });
  }

  cookies.set(COOKIE_NAME, result.sessionId, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: !dev,
    expires: result.expiresAt
  });

  return json({ ok: true, user: result.user }, { status: 200 });
};
