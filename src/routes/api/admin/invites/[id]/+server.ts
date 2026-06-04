import { json } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth/access';
import { removeInvite } from '$lib/server/auth/invites';
import type { RequestHandler } from './$types';

/**
 * DELETE /api/admin/invites/:id
 *
 * Убирает email из allowlist. Если записи нет — 404.
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
  requireAdmin(locals.user);
  const removed = await removeInvite({ inviteId: params.id });
  if (!removed) {
    return json(
      { error: { code: 'not_found', message: 'Приглашение не найдено' } },
      { status: 404 }
    );
  }
  return json({ ok: true }, { status: 200 });
};
