import { json } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth/access';
import { removeMember } from '$lib/server/auth/invites';
import type { RequestHandler } from './$types';

/**
 * DELETE /api/admin/users/:id?keepData=true|false
 *
 * Удаляет пользователя из организации. keepData=true → soft-delete
 * (данные сохраняются, заходить нельзя). keepData=false → hard-delete
 * (cascade удалит сессии, surveys, токены).
 *
 * Защиты внутри removeMember:
 *  - 403 'self' — нельзя удалить самого себя;
 *  - 409 'last_admin' — нельзя удалить последнего админа;
 *  - 404 'not_found' — id не из своей организации либо уже удалён.
 */
export const DELETE: RequestHandler = async ({ params, url, locals }) => {
  const admin = requireAdmin(locals.user);
  const keepData = url.searchParams.get('keepData') === 'true';

  const result = await removeMember({
    organizationId: admin.organizationId,
    userId: params.id,
    initiatorUserId: admin.id,
    keepData
  });

  if (!result.ok) {
    const status = result.code === 'not_found' ? 404 : result.code === 'self' ? 403 : 409;
    return json({ error: { code: result.code, message: result.message } }, { status });
  }

  return json({ ok: true, keepData }, { status: 200 });
};
