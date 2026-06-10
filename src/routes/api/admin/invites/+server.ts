import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { requireAdmin } from '$lib/server/auth/access';
import { addInvite } from '$lib/server/auth/invites';
import { InviteEmailSchema } from '$lib/server/auth/validation';
import { sendInvitationEmail } from '$lib/server/email/invitation';
import { log } from '$lib/server/log';
import { resolvePublicBaseUrl } from '$lib/server/net/base-url';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, url, locals }) => {
  const admin = requireAdmin(locals.user);
  const raw = await request.json().catch(() => null);
  const parsed = InviteEmailSchema.safeParse(raw);
  if (!parsed.success) {
    return json({ error: { code: 'invalid_input', issues: parsed.error.issues } }, { status: 400 });
  }

  // addInvite returns a string: 'added' | 'already_exists' | 'already_member'
  const result = await addInvite({
    email: parsed.data.email,
    invitedBy: admin.id,
    note: parsed.data.note
  });

  if (result === 'already_member') {
    return json(
      { error: { code: 'already_member', message: 'Пользователь уже является участником' } },
      { status: 409 }
    );
  }

  // 'added' or 'already_exists' — both are fine, just don't re-send email on duplicate
  const created = result === 'added';

  if (created) {
    const baseUrl = resolvePublicBaseUrl(url.origin);
    const organizationName = env.APP_NAME || 'Облако тегов 2090';
    const inviteUrl = `${baseUrl}/register?org=${encodeURIComponent(organizationName)}&email=${encodeURIComponent(parsed.data.email)}`;
    try {
      await sendInvitationEmail({
        to: parsed.data.email,
        inviteUrl,
        organizationName
      });
    } catch (err) {
      log.error('invitation_send_failed', {
        err: err instanceof Error ? err.message : String(err)
      });
    }
  }

  // Return a minimal invite object so the UI can add it to the list
  return json(
    {
      ok: true,
      invite: {
        id: crypto.randomUUID(),
        email: parsed.data.email,
        note: parsed.data.note ?? null,
        registered: false
      },
      sent: created
    },
    { status: 200 }
  );
};
