import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { requireAdmin } from '$lib/server/auth/access';
import { addInvite } from '$lib/server/auth/invites';
import { InviteEmailSchema } from '$lib/server/auth/validation';
import { sendInvitationEmail } from '$lib/server/email/invitation';
import { log } from '$lib/server/log';
import type { RequestHandler } from './$types';

/**
 * POST /api/admin/invites
 *
 * Добавляет email в allowlist организации текущего админа. Если запись
 * уже была (created=false) — не шлём дубль приглашения. Если есть
 * активный member с таким email — отказываем (already_member).
 */
export const POST: RequestHandler = async ({ request, url, locals }) => {
  const admin = requireAdmin(locals.user);
  const raw = await request.json().catch(() => null);
  const parsed = InviteEmailSchema.safeParse(raw);
  if (!parsed.success) {
    return json({ error: { code: 'invalid_input', issues: parsed.error.issues } }, { status: 400 });
  }

  const result = await addInvite({
    organizationId: admin.organizationId,
    email: parsed.data.email,
    invitedBy: admin.id,
    note: parsed.data.note
  });

  if (!result.ok) {
    return json({ error: { code: result.code, message: result.message } }, { status: 409 });
  }

  if (result.created) {
    const baseUrl = env.PUBLIC_BASE_URL || env.ORIGIN || url.origin;
    const inviteUrl = `${baseUrl}/register?org=${encodeURIComponent(admin.organizationName)}&email=${encodeURIComponent(parsed.data.email)}`;
    try {
      await sendInvitationEmail({
        to: parsed.data.email,
        inviteUrl,
        organizationName: admin.organizationName,
        invitedByEmail: admin.email
      });
    } catch (err) {
      log.error('invitation_send_failed', {
        err: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return json({ ok: true, invite: result.invite, sent: result.created }, { status: 200 });
};
