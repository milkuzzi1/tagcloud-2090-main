import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db';
import { organizationInvites, users } from '../schema';

export type AddInviteResult = 'added' | 'already_exists' | 'already_member';

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
  role: string;
  note: string | null;
  createdAt: Date;
};

export type RemoveMemberResult = 'ok' | 'self_removal' | 'last_admin' | 'not_found';

/**
 * Добавляет email в аллоулист.
 * Если email уже зарегистрирован среди возвращает 'already_member'.
 */
export async function addInvite(params: {
  email: string;
  invitedBy: string;
  note?: string;
}): Promise<AddInviteResult> {
  const [existingUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.email, params.email), isNull(users.deletedAt)))
    .limit(1);

  if (existingUser) return 'already_member';

  const result = await db
    .insert(organizationInvites)
    .values({
      email: params.email,
      invitedBy: params.invitedBy,
      note: params.note
    })
    .onConflictDoNothing()
    .returning({ id: organizationInvites.id });

  return result.length > 0 ? 'added' : 'already_exists';
}

export async function removeInvite(params: {
  inviteId: string;
}): Promise<boolean> {
  const result = await db
    .delete(organizationInvites)
    .where(eq(organizationInvites.id, params.inviteId))
    .returning({ id: organizationInvites.id });
  return result.length > 0;
}

export async function listInvites(): Promise<InviteRow[]> {
  const rows = await db
    .select({
      id: organizationInvites.id,
      email: organizationInvites.email,
      note: organizationInvites.note,
      invitedAt: organizationInvites.invitedAt,
      userId: users.id
    })
    .from(organizationInvites)
    .leftJoin(users, and(eq(users.email, organizationInvites.email), isNull(users.deletedAt)));
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    note: r.note,
    invitedAt: r.invitedAt,
    registered: r.userId != null
  }));
}

export async function isAllowlisted(params: {
  email: string;
}): Promise<boolean> {
  const [row] = await db
    .select({ id: organizationInvites.id })
    .from(organizationInvites)
    .where(eq(organizationInvites.email, params.email))
    .limit(1);
  return !!row;
}

export async function listMembers(): Promise<MemberRow[]> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      note: organizationInvites.note,
      createdAt: users.createdAt
    })
    .from(users)
    .leftJoin(organizationInvites, eq(organizationInvites.email, users.email))
    .where(isNull(users.deletedAt));
  return rows;
}

export async function removeMember(params: {
  userId: string;
  initiatorUserId: string;
  keepData: boolean;
}): Promise<RemoveMemberResult> {
  if (params.userId === params.initiatorUserId) return 'self_removal';

  const [user] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(and(eq(users.id, params.userId), isNull(users.deletedAt)))
    .limit(1);

  if (!user) return 'not_found';

  if (user.role === 'admin') {
    const admins = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, 'admin'), isNull(users.deletedAt)));
    if (admins.length <= 1) return 'last_admin';
  }

  if (params.keepData) {
    await db
      .update(users)
      .set({ deletedAt: new Date() })
      .where(eq(users.id, params.userId));
  } else {
    await db.delete(users).where(eq(users.id, params.userId));
  }

  return 'ok';
}
