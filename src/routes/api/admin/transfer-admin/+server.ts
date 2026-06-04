import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { z } from 'zod';
import { requireAdmin } from '$lib/server/auth/access';
import { registerAdmin } from '$lib/server/auth/service';
import { countAdmins, createAdminHandover } from '$lib/server/auth/invites';
import { createPasswordResetToken, PASSWORD_RESET_TTL_HOURS } from '$lib/server/auth/password-reset';
import { sendPasswordResetEmail } from '$lib/server/email/password-reset';
import { log } from '$lib/server/log';
import { resolvePublicBaseUrl } from '$lib/server/net/base-url';
import type { RequestHandler } from './$types';

const Body = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  // Whether to keep the outgoing (current) admin's data when they are removed.
  keepData: z.boolean().optional().default(false)
});

/**
 * POST /api/admin/transfer-admin  (Req 2 + Req 3)
 *
 * The current admin hands administration to a new admin identified by email.
 * A new admin account is created in a pending state and emailed a link to set
 * their password. The current admin is removed ONLY after the new admin
 * activates (see consumePasswordReset -> completeAdminHandoverFor).
 *
 * Guard: this is only allowed while the caller is the SOLE admin. That makes
 * the operation a true one-time handover and enforces Req 3 (a non-sole admin
 * — i.e. the post-handover admin — can never mint additional admins).
 */
export const POST: RequestHandler = async ({ request, url, locals }) => {
  const admin = requireAdmin(locals.user);

  const total = await countAdmins();
  if (total !== 1) {
    return json(
      {
        error: {
          code: 'not_sole_admin',
          message: 'Передача администрирования доступна только единственному администратору'
        }
      },
      { status: 409 }
    );
  }

  const raw = await request.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return json({ error: { code: 'invalid_input', issues: parsed.error.issues } }, { status: 400 });
  }

  if (parsed.data.email === admin.email) {
    return json(
      { error: { code: 'self_transfer', message: 'Нельзя передать администрирование самому себе' } },
      { status: 400 }
    );
  }

  const tmpPassword = crypto.randomUUID();
  const result = await registerAdmin({ email: parsed.data.email, password: tmpPassword });
  if (!result.ok) {
    return json({ error: { code: result.code, message: result.message } }, { status: 409 });
  }

  await createAdminHandover({
    incomingUserId: result.user.id,
    outgoingUserId: admin.id,
    keepOutgoingData: parsed.data.keepData
  });

  const token = await createPasswordResetToken(result.user.id);
  const baseUrl = resolvePublicBaseUrl(url.origin);
  const setPasswordUrl = `${baseUrl}/reset-password?t=${token.token}`;
  const organizationName = env.APP_NAME || 'Облако тегов 2090';

  try {
    await sendPasswordResetEmail({
      to: result.user.email,
      resetUrl: setPasswordUrl,
      ttlHours: PASSWORD_RESET_TTL_HOURS,
      organizationName
    });
  } catch (err) {
    log.error('transfer_admin_send_failed', {
      err: err instanceof Error ? err.message : String(err)
    });
  }

  log.info('transfer_admin_initiated', {
    incomingUserId: result.user.id,
    incomingEmail: result.user.email,
    outgoingUserId: admin.id
  });

  return json(
    { ok: true, email: result.user.email, ttlHours: PASSWORD_RESET_TTL_HOURS },
    { status: 201 }
  );
};
