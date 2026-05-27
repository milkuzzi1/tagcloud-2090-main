import { json } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth/access';
import { removeInvite } from '$lib/server/auth/invites';
import type { RequestHandler } from './$types';

/**
 * DELETE /api/admin/invites/:id
 *
 * Убирает email из allowlist организации текущего админа. Если запись
 * принадлежит другой организации — removeInvite не найдёт её и вернёт
 * false (404) — это и есть защита от cross-org удаления.
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
  const admin = requireAdmin(locals.user);
  const removed = await removeInvite({
    organizationId: admin.organizationId,
    inviteId: params.id
  });
  if (!removed) {
    return json(
      { error: { code: 'not_found', message: 'Приглашение не найдено' } },
      { status: 404 }
    );
  }
  return json({ ok: true }, { status: 200 });
};
