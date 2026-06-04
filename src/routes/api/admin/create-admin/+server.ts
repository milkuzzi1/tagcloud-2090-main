import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { z } from 'zod';
import { requireAdmin } from '$lib/server/auth/access';
import { registerAdmin } from '$lib/server/auth/service';
import { createPasswordResetToken, PASSWORD_RESET_TTL_HOURS } from '$lib/server/auth/password-reset';
import { sendPasswordResetEmail } from '$lib/server/email/password-reset';
import { log } from '$lib/server/log';
import { resolvePublicBaseUrl } from '$lib/server/net/base-url';
import type { RequestHandler } from './$types';

const Body = z.object({
  email: z.string().trim().toLowerCase().email().max(254)
});

export const POST: RequestHandler = async ({ request, url, locals }) => {
  requireAdmin(locals.user);

  const raw = await request.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return json({ error: { code: 'invalid_input', issues: parsed.error.issues } }, { status: 400 });
  }

  const tmpPassword = crypto.randomUUID();
  const result = await registerAdmin({ email: parsed.data.email, password: tmpPassword });

  if (!result.ok) {
    return json({ error: { code: result.code, message: result.message } }, { status: 409 });
  }

  const token = await createPasswordResetToken(result.user.id);
  const baseUrl = resolvePublicBaseUrl(url.origin);
  const setPasswordUrl = `${baseUrl}/reset-password?t=${token.token}`;
  const organizationName = env.APP_NAME || '\u041e\u0431\u043b\u0430\u043a\u043e \u0442\u0435\u0433\u043e\u0432 2090';

  try {
    await sendPasswordResetEmail({
      to: result.user.email,
      resetUrl: setPasswordUrl,
      ttlHours: PASSWORD_RESET_TTL_HOURS,
      organizationName
    });
  } catch (err) {
    log.error('create_admin_send_failed', {
      err: err instanceof Error ? err.message : String(err)
    });
  }

  log.info('create_admin', {
    newUserId: result.user.id,
    newUserEmail: result.user.email,
    initiatorId: locals.user?.id
  });

  return json(
    { ok: true, email: result.user.email, ttlHours: PASSWORD_RESET_TTL_HOURS },
    { status: 201 }
  );
};
