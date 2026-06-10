import { redirect } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { consumeVerificationToken } from '$lib/server/auth/verification';
import { COOKIE_NAME, createSession } from '$lib/server/auth/sessions';
import type { PageServerLoad } from './$types';

/**
 * SSR-обработчик ссылки из письма (`/verify?t=<uuid>`).
 *
 * Поведение:
 *   - Валидный токен → атомарно тратим, помечаем user.email_verified=true,
 *     создаём сессию, ставим cookie и редиректим на /my.
 *   - Невалидный/использованный/истёкший → возвращаем status в page-данные,
 *     UI показывает соответствующее сообщение и кнопку "переотправить".
 */
export const load: PageServerLoad = async ({ url, cookies }) => {
  const token = url.searchParams.get('t');
  if (!token) {
    return { ok: false, code: 'missing', message: 'В ссылке нет токена' };
  }

  const result = await consumeVerificationToken(token);
  if (!result.ok) {
    return { ok: false, code: result.code, message: result.message };
  }

  const { id: sessionId, expiresAt } = await createSession(result.userId);
  cookies.set(COOKIE_NAME, sessionId, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    // !dev — выключается только в локальной разработке (http://localhost).
    secure: !dev,
    expires: expiresAt
  });

  // Редирект — стандартный приём после успешной верификации; пользователь
  // оказывается в личном кабинете уже залогиненным.
  throw redirect(303, '/my?verified=1');
};
