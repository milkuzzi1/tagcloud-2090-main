import { json } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth/access';
import { removeMember } from '$lib/server/auth/invites';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = async ({ params, url, locals }) => {
  const admin = requireAdmin(locals.user);
  const keepData = url.searchParams.get('keepData') !== 'false';

  const result = await removeMember({
    userId: params.id,
    initiatorUserId: admin.id,
    keepData
  });

  if (result === 'ok') {
    return json({ ok: true, keepData }, { status: 200 });
  }

  const statusMap: Record<string, number> = {
    not_found: 404,
    self_removal: 403,
    last_admin: 409
  };

  const messageMap: Record<string, string> = {
    not_found: 'Пользователь не найден',
    self_removal: 'Нельзя удалить самого себя',
    last_admin: 'Нельзя удалить последнего администратора'
  };

  return json(
    { error: { code: result, message: messageMap[result] ?? result } },
    { status: statusMap[result] ?? 400 }
  );
};
