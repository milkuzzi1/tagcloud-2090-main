import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { requireAdmin } from '$lib/server/auth/access';
import { removeMember, changeUserEmail } from '$lib/server/auth/invites';
import { db } from '$lib/server/db';
import { users } from '$lib/server/schema';
import { log } from '$lib/server/log';
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

const PatchBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254)
});

/**
 * PATCH /api/admin/users/:id  — change a user's email (admin authority).
 *
 * The admin acts on the user's behalf, so no per-user password is required.
 * Guards:
 *   - cannot edit an admin account's email here (admins change their own email
 *     via /api/admin/change-email, which re-authenticates with their password);
 *   - email must be unique among live users.
 */
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
  requireAdmin(locals.user);

  const raw = await request.json().catch(() => null);
  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) {
    return json({ error: { code: 'invalid_input', issues: parsed.error.issues } }, { status: 400 });
  }

  const [target] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.id, params.id))
    .limit(1);

  if (!target) {
    return json(
      { error: { code: 'not_found', message: 'Пользователь не найден' } },
      { status: 404 }
    );
  }
  if (target.role === 'admin') {
    return json(
      {
        error: {
          code: 'cannot_edit_admin',
          message: 'Email администратора меняется в разделе «Изменить email»'
        }
      },
      { status: 403 }
    );
  }

  const result = await changeUserEmail({ userId: params.id, newEmail: parsed.data.email });
  if (result === 'email_taken') {
    return json(
      { error: { code: 'email_taken', message: 'Этот email уже занят' } },
      { status: 409 }
    );
  }
  if (result === 'not_found') {
    return json(
      { error: { code: 'not_found', message: 'Пользователь не найден' } },
      { status: 404 }
    );
  }

  log.info('admin_changed_user_email', { userId: params.id });
  return json({ ok: true, email: parsed.data.email }, { status: 200 });
};
