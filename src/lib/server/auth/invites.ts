import { and, eq, isNull, ne } from 'drizzle-orm';
import { db, type Executor } from '../db';
import { organizationInvites, pendingAdminHandover, sessions, users } from '../schema';

export type AddInviteResult =
  | { status: 'added'; id: string }
  | { status: 'already_exists'; id: string }
  | { status: 'already_member' };

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
  emailVerified: boolean;
};

export type RemoveMemberResult = 'ok' | 'self_removal' | 'last_admin' | 'not_found';

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

  if (existingUser) return { status: 'already_member' };

  const result = await db
    .insert(organizationInvites)
    .values({
      email: params.email,
      invitedBy: params.invitedBy,
      note: params.note
    })
    .onConflictDoNothing()
    .returning({ id: organizationInvites.id });

  if (result.length > 0) {
    return { status: 'added', id: result[0].id };
  }

  // Conflict: a row for this email already exists. Look up its real id so the
  // caller (and UI) can act on it (e.g. DELETE) without a full reload.
  const [existingInvite] = await db
    .select({ id: organizationInvites.id })
    .from(organizationInvites)
    .where(eq(organizationInvites.email, params.email))
    .limit(1);

  return { status: 'already_exists', id: existingInvite.id };
}

export async function removeInvite(params: { inviteId: string }): Promise<boolean> {
  const result = await db
    .delete(organizationInvites)
    .where(eq(organizationInvites.id, params.inviteId))
    .returning({ id: organizationInvites.id });
  return result.length > 0;
}

export async function listInvites(): Promise<InviteRow[]> {
  // Note: we avoid selecting users.id alongside organizationInvites.id
  // because postgres-js collapses duplicate column names in the result set.
  // Instead we select users.email (aliased as userEmail) to detect registration.
  const rows = await db
    .select({
      id: organizationInvites.id,
      email: organizationInvites.email,
      note: organizationInvites.note,
      invitedAt: organizationInvites.invitedAt,
      userEmail: users.email
    })
    .from(organizationInvites)
    .leftJoin(users, and(eq(users.email, organizationInvites.email), isNull(users.deletedAt)));
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    note: r.note,
    invitedAt: r.invitedAt,
    registered: r.userEmail != null
  }));
}

export async function isAllowlisted(params: { email: string }): Promise<boolean> {
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
      createdAt: users.createdAt,
      emailVerified: users.emailVerified
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
    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, params.userId));
  } else {
    await db.delete(users).where(eq(users.id, params.userId));
  }

  // Инвалидируем сессии удаляемого пользователя. При hard-delete FK-cascade
  // их и так снесёт, но при soft-delete (keepData) строки сессий остаются —
  // явная чистка не даёт восстановленному аккаунту «ожить» со старой сессией.
  await db.delete(sessions).where(eq(sessions.userId, params.userId));

  return 'ok';
}

// --- Admin count -----------------------------------------------------------

export async function countAdmins(exec: Executor = db): Promise<number> {
  const rows = await exec
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, 'admin'), isNull(users.deletedAt)));
  return rows.length;
}

// --- Change admin email (Req 4b) -------------------------------------------

export type ChangeEmailResult = 'ok' | 'email_taken' | 'not_found';

/**
 * Change a user's email. Generic over any user id (used both for an admin
 * changing their own email and for an admin editing another user's email).
 *
 * Uniqueness is checked only against LIVE users (deleted_at IS NULL), matching
 * the partial unique index on (email) WHERE deleted_at IS NULL — a soft-deleted
 * row may legitimately share an email with a live one.
 */
export async function changeUserEmail(params: {
  userId: string;
  newEmail: string;
}): Promise<ChangeEmailResult> {
  const [taken] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(eq(users.email, params.newEmail), ne(users.id, params.userId), isNull(users.deletedAt))
    )
    .limit(1);
  if (taken) return 'email_taken';

  const updated = await db
    .update(users)
    .set({ email: params.newEmail })
    .where(and(eq(users.id, params.userId), isNull(users.deletedAt)))
    .returning({ id: users.id });

  // Смена email инвалидирует все сессии пользователя: иначе угнанная (или
  // просто старая, на чужом устройстве) сессия продолжала бы жить после
  // того, как контактный адрес аккаунта сменился. Тот же паттерн, что при
  // сбросе пароля (см. auth/service.ts: consumePasswordReset).
  if (updated.length > 0) {
    await db.delete(sessions).where(eq(sessions.userId, params.userId));
  }

  return updated.length > 0 ? 'ok' : 'not_found';
}

/** Back-compat alias used by the admin self-service change-email endpoint. */
export const changeAdminEmail = changeUserEmail;

// --- Admin handover (Req 2) ------------------------------------------------
//
// The outgoing admin is removed ONLY after the incoming admin activates
// (sets their password). createAdminHandover records the intent; complete
// AdminHandoverFor is called from the password-reset consume path.

export async function createAdminHandover(
  params: {
    incomingUserId: string;
    outgoingUserId: string;
    keepOutgoingData: boolean;
  },
  exec: Executor = db
): Promise<void> {
  await exec
    .insert(pendingAdminHandover)
    .values({
      incomingUserId: params.incomingUserId,
      outgoingUserId: params.outgoingUserId,
      keepOutgoingData: params.keepOutgoingData
    })
    .onConflictDoNothing();
}

/**
 * If the given (now-activated) user is the incoming side of a pending
 * handover, finalise it: remove the outgoing admin, then delete the handover
 * record. Returns the outgoing user id if a handover was completed.
 *
 * Runs in a transaction so we never delete the outgoing admin without also
 * clearing the handover row (which would otherwise re-trigger).
 */
async function doCompleteHandover(exec: Executor, incomingUserId: string): Promise<string | null> {
  const [row] = await exec
    .select({
      id: pendingAdminHandover.id,
      outgoingUserId: pendingAdminHandover.outgoingUserId,
      keepOutgoingData: pendingAdminHandover.keepOutgoingData
    })
    .from(pendingAdminHandover)
    .where(eq(pendingAdminHandover.incomingUserId, incomingUserId))
    .limit(1);

  if (!row) return null;

  if (row.keepOutgoingData) {
    await exec.update(users).set({ deletedAt: new Date() }).where(eq(users.id, row.outgoingUserId));
  } else {
    await exec.delete(users).where(eq(users.id, row.outgoingUserId));
  }

  // Гасим сессии исходящего админа: при soft-delete FK-cascade не сработает,
  // а getSessionUser хоть и фильтрует deletedAt, явная чистка убирает
  // «висящие» строки и закрывает возможность повторного входа при
  // потенциальном восстановлении аккаунта.
  await exec.delete(sessions).where(eq(sessions.userId, row.outgoingUserId));

  await exec.delete(pendingAdminHandover).where(eq(pendingAdminHandover.id, row.id));
  return row.outgoingUserId;
}

export async function completeAdminHandoverFor(
  incomingUserId: string,
  exec?: Executor
): Promise<string | null> {
  // Если передали транзакцию (например, transfer-admin держит advisory-lock) —
  // работаем внутри неё. Иначе открываем свою, чтобы delete-outgoing и
  // delete-pending были атомарны (иначе handover мог бы повторно сработать).
  if (exec) return doCompleteHandover(exec, incomingUserId);
  return await db.transaction((tx) => doCompleteHandover(tx, incomingUserId));
}
