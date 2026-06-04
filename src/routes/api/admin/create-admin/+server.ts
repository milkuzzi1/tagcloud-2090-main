import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { z } from 'zod';
import { requireAdmin } from '$lib/server/auth/access';
import { registerAdmin } from '$lib/server/auth/service';
import { createPasswordResetToken, PASSWORD_RESET_TTL_HOURS } from '$lib/server/auth/password-reset';
import { sendPasswordResetEmail } from '$lib/server/email/password-reset';
import { log } from '$lib/server/log';
import type { RequestHandler } from './$types';

const Body = z.object({
  email: z.string().trim().toLowerCase().email().max(254)
});

// Create a new admin account and send a password-set link.
// Only existing admins can call this.
export const POST: RequestHandler = async ({ request, url, locals }) => {
  requireAdmin(locals.user);

  const raw = await request.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return json({ error: { code: 'invalid_input', issues: parsed.error.issues } }, { status: 400 });
  }

  // Generate a random temporary password -- the user will never see it;
  // they set their real password via the reset link.
  const tmpPassword = crypto.randomUUID();
  const result = await registerAdmin({ email: parsed.data.email, password: tmpPassword });

  if (!result.ok) {
    return json({ error: { code: result.code, message: result.message } }, { status: 409 });
  }

  // Create a password-reset token so the new admin can set their password.
  const token = await createPasswordResetToken(result.user.id);
  const baseUrl = env.PUBLIC_BASE_URL || env.ORIGIN || url.origin;
  const setPasswordUrl = `${baseUrl}/reset-password?t=${token.token}`;

  try {
    await sendPasswordResetEmail({
      to: result.user.email,
      resetUrl: setPasswordUrl,
      ttlHours: PASSWORD_RESET_TTL_HOURS
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
