import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { z } from 'zod';
import { requireAdmin } from '$lib/server/auth/access';
import { promoteOrCreateAdmin } from '$lib/server/auth/service';
import { countAdmins, createAdminHandover, completeAdminHandoverFor } from '$lib/server/auth/invites';
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
 * The current (sole) admin hands administration to another person identified
 * by email.
 *
 * Variant (A): if a live user with that email already exists, we PROMOTE that
 * existing account to admin in place — we do not create a second row for the
 * same email (which previously caused duplicate accounts and a
 * non-deterministic login).
 *
 * Outgoing-admin removal:
 *   - if the incoming person already has a password (existing active user),
 *     the handover completes IMMEDIATELY — they can already sign in, so the
 *     outgoing admin is removed right away (no email needed);
 *   - otherwise (new account, or invited user who never set a password) the
 *     outgoing admin is removed only AFTER the incoming person sets their
 *     password via the emailed link (consumePasswordReset ->
 *     completeAdminHandoverFor), so a failed/abandoned invite never leaves the
 *     system without an admin.
 *
 * Guard: only the SOLE admin may transfer (enforces Req 3).
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

  const result = await promoteOrCreateAdmin(parsed.data.email);
  if (!result.ok) {
    return json({ error: { code: result.code, message: result.message } }, { status: 409 });
  }

  // Case 1: the incoming person can already sign in — complete the handover now.
  if (result.hasPassword) {
    await createAdminHandover({
      incomingUserId: result.user.id,
      outgoingUserId: admin.id,
      keepOutgoingData: parsed.data.keepData
    });
    const removed = await completeAdminHandoverFor(result.user.id);
    log.info('transfer_admin_completed_immediately', {
      incomingUserId: result.user.id,
      incomingEmail: result.user.email,
      outgoingUserId: admin.id,
      removed
    });
    return json(
      {
        ok: true,
        email: result.user.email,
        action: result.action,
        completed: true,
        message: 'Администрирование передано. Ваш аккаунт удалён.'
      },
      { status: 200 }
    );
  }

  // Case 2: incoming person must set a password first — defer removal.
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
    outgoingUserId: admin.id,
    action: result.action
  });

  return json(
    { ok: true, email: result.user.email, action: result.action, completed: false, ttlHours: PASSWORD_RESET_TTL_HOURS },
    { status: 201 }
  );
};
