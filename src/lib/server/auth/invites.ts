import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db';
import { organizationInvites, sessions, users } from '../schema';

export type InviteRow = {
  id: string;
  email: string;
  note: string | null;
  invitedAt: Date;
  registered: boolean;
};

export type MemberRow = {
  id: string;
  email: string;
  role: 'admin' | 'user';
  emailVerified: boolean;
  createdAt: Date;
};

export type AddInviteResult =
  | { ok: true; created: boolean; invite: { id: string; email: string } }
  | { ok: false; code: 'already_member'; message: string };

/**
 * Добавляет email в allowlist организации. Если запись уже есть — возвращает её
 * (created=false). Если email уже зарегистрирован в этой организации как
 * активный пользователь — возвращает 'already_member', нет смысла приглашать.
 */
export async function addInvite(params: {
  organizationId: string;
  email: string;
  invitedBy: string;
  note?: string;
}): Promise<AddInviteResult> {
  const { organizationId, email, invitedBy, note } = params;

  const [existingUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(eq(users.organizationId, organizationId), eq(users.email, email), isNull(users.deletedAt))
    )
    .limit(1);

  if (existingUser) {
    return {
      ok: false,
      code: 'already_member',
      message: 'Этот email уже зарегистрирован в организации'
    };
  }

  // INSERT ... ON CONFLICT (organization_id, email) DO NOTHING — повторное
  // приглашение того же email не порождает дублирующих строк.
  const inserted = await db
    .insert(organizationInvites)
    .values({ organizationId, email, invitedBy, note: note ?? null })
    .onConflictDoNothing({
      target: [organizationInvites.organizationId, organizationInvites.email]
    })
    .returning({ id: organizationInvites.id, email: organizationInvites.email });

  if (inserted.length > 0) {
    return { ok: true, created: true, invite: inserted[0] };
  }

  const [existing] = await db
    .select({ id: organizationInvites.id, email: organizationInvites.email })
    .from(organizationInvites)
    .where(
      and(
        eq(organizationInvites.organizationId, organizationId),
        eq(organizationInvites.email, email)
      )
    )
    .limit(1);

  return { ok: true, created: false, invite: existing };
}

export async function removeInvite(params: {
  organizationId: string;
  inviteId: string;
}): Promise<boolean> {
  const deleted = await db
    .delete(organizationInvites)
    .where(
      and(
        eq(organizationInvites.id, params.inviteId),
        eq(organizationInvites.organizationId, params.organizationId)
      )
    )
    .returning({ id: organizationInvites.id });
  return deleted.length > 0;
}

export async function listInvites(organizationId: string): Promise<InviteRow[]> {
  const rows = await db
    .select({
      id: organizationInvites.id,
      email: organizationInvites.email,
      note: organizationInvites.note,
      invitedAt: organizationInvites.invitedAt,
      registeredCount: sql<number>`COUNT(${users.id})::int`
    })
    .from(organizationInvites)
    .leftJoin(
      users,
      and(
        eq(users.organizationId, organizationInvites.organizationId),
        eq(users.email, organizationInvites.email),
        isNull(users.deletedAt)
      )
    )
    .where(eq(organizationInvites.organizationId, organizationId))
    .groupBy(organizationInvites.id)
    .orderBy(organizationInvites.invitedAt);

  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    note: r.note,
    invitedAt: r.invitedAt,
    registered: r.registeredCount > 0
  }));
}

export async function isAllowlisted(params: {
  organizationId: string;
  email: string;
}): Promise<boolean> {
  const [row] = await db
    .select({ id: organizationInvites.id })
    .from(organizationInvites)
    .where(
      and(
        eq(organizationInvites.organizationId, params.organizationId),
        eq(organizationInvites.email, params.email)
      )
    )
    .limit(1);
  return Boolean(row);
}

export async function listMembers(organizationId: string): Promise<MemberRow[]> {
  return await db
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      emailVerified: users.emailVerified,
      createdAt: users.createdAt
    })
    .from(users)
    .where(and(eq(users.organizationId, organizationId), isNull(users.deletedAt)))
    .orderBy(users.createdAt);
}

export type RemoveMemberResult =
  | { ok: true }
  | { ok: false; code: 'not_found' | 'self' | 'last_admin'; message: string };

/**
 * Удаляет пользователя из организации.
 *
 * keepData=false — DELETE FROM users (cascade удалит surveys/sessions/tokens).
 * keepData=true  — soft-delete: ставим deleted_at=NOW(), убиваем все сессии,
 *                  гасим email_verification_tokens/password_reset_tokens
 *                  через cascade. surveys у пользователя остаются.
 *
 * Защиты:
 *  - нельзя удалить самого себя (требование: «должно появляться окно с
 *    подтверждением» — только для удаления других людей);
 *  - нельзя удалить последнего админа в организации (иначе организация
 *    станет неуправляемой).
 */
export async function removeMember(params: {
  organizationId: string;
  userId: string;
  initiatorUserId: string;
  keepData: boolean;
}): Promise<RemoveMemberResult> {
  const { organizationId, userId, initiatorUserId, keepData } = params;

  if (userId === initiatorUserId) {
    return { ok: false, code: 'self', message: 'Нельзя удалить самого себя' };
  }

  return await db.transaction(async (tx) => {
    const [target] = await tx
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(
        and(eq(users.id, userId), eq(users.organizationId, organizationId), isNull(users.deletedAt))
      )
      .limit(1);

    if (!target) {
      return { ok: false, code: 'not_found', message: 'Пользователь не найден' } as const;
    }

    if (target.role === 'admin') {
      const admins = await tx
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.organizationId, organizationId),
            eq(users.role, 'admin'),
            isNull(users.deletedAt)
          )
        );
      const remaining = admins.filter((r) => r.id !== userId).length;
      if (remaining === 0) {
        return {
          ok: false,
          code: 'last_admin',
          message: 'Нельзя удалить последнего администратора организации'
        } as const;
      }
    }

    if (keepData) {
      await tx.update(users).set({ deletedAt: new Date() }).where(eq(users.id, userId));
      // sessions cascade by FK on hard delete, но при soft-delete нужно
      // явно гасить — иначе пользователь продолжит ходить по сайту.
      await tx.delete(sessions).where(eq(sessions.userId, userId));
    } else {
      await tx.delete(users).where(eq(users.id, userId));
    }

    return { ok: true } as const;
  });
}
