import { redirect } from '@sveltejs/kit';
import { peekPasswordResetToken } from '$lib/server/auth/password-reset';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
  if (locals.user) redirect(303, '/my');

  const token = url.searchParams.get('t') ?? '';
  if (!token) {
    return { token: '', state: { ok: false as const, message: 'Ссылка недействительна' } };
  }

  const peek = await peekPasswordResetToken(token);
  if (peek.ok) {
    return { token, state: { ok: true as const } };
  }
  return { token, state: { ok: false as const, message: peek.message } };
};
