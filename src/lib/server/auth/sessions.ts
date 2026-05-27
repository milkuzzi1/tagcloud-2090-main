import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import { db } from '../db';
import { organizations, sessions, users } from '../schema';

export const COOKIE_NAME = 'tagcloud_session';
export const SESSION_TTL_DAYS = 30;

export type AuthUser = { id: string; email: string };

/**
 * Расширенный профиль из сессии. Грузится из БД на каждый запрос —
 * включает роль и контекст организации (нужно для requireAdmin и для
 * условного показа UI-элементов).
 */
export type AuthUserExt = {
  id: string;
  email: string;
  role: 'admin' | 'user';
  organizationId: string;
  organizationName: string;
};

function generateSessionId(): string {
  return randomBytes(32).toString('base64url');
}

export async function createSession(userId: string): Promise<{ id: string; expiresAt: Date }> {
  const id = generateSessionId();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  await db.insert(sessions).values({ id, userId, expiresAt });
  return { id, expiresAt };
}

export async function getSessionUser(
  sessionId: string | undefined | null
): Promise<AuthUserExt | null> {
  if (!sessionId) return null;
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      organizationId: users.organizationId,
      organizationName: organizations.name
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .innerJoin(organizations, eq(users.organizationId, organizations.id))
    .where(
      and(eq(sessions.id, sessionId), gt(sessions.expiresAt, new Date()), isNull(users.deletedAt))
    )
    .limit(1);
  if (rows.length === 0) return null;
  return rows[0];
}

export async function deleteSession(sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

export async function purgeExpiredSessions(): Promise<number> {
  const deleted = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, new Date()))
    .returning({ id: sessions.id });
  return deleted.length;
}
