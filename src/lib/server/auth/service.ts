import { and, eq, isNull } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db } from '../db';
import { sessions, users } from '../schema';
import { getDummyPasswordHash, hashPassword, verifyPassword } from './hash';
import { createSession, type AuthUser } from './sessions';
import { createVerificationToken, type VerificationToken } from './verification';
import {
  consumePasswordResetToken,
  createPasswordResetToken,
  type PasswordResetToken
} from './password-reset';
import { isAllowlisted } from './invites';
import type { RegisterInput, ForgotPassword, LoginInput } from './validation';

function isEmailVerificationDisabled(): boolean {
  return env.AUTH_DISABLE_EMAIL_VERIFICATION === 'true';
}

export type RegisterResult =
  | {
      ok: true;
      status: 'new_pending' | 'reverify_pending';
      user: AuthUser;
      verification: VerificationToken;
    }
  | {
      ok: true;
      status: 'auto_verified';
      user: AuthUser;
    }
  | { ok: false; code: 'email_taken'; message: string }
  | { ok: false; code: 'not_invited'; message: string };

export type LoginResult =
  | { ok: true; user: AuthUser; sessionId: string; expiresAt: Date }
  | { ok: false; code: 'invalid_credentials'; message: string }
  | { ok: false; code: 'email_not_verified'; message: string; userId: string; email: string };

export async function register(input: RegisterInput): Promise<RegisterResult> {
  // Only allowlisted emails may register as regular users
  const allowed = await isAllowlisted({ email: input.email });
  if (!allowed) {
    return { ok: false, code: 'not_invited', message: 'Регистрация недоступна. Обратитесь к администратору.' };
  }

  const passwordHash = await hashPassword(input.password);
  const autoVerify = isEmailVerificationDisabled();
  const now = new Date();

  const [existing] = await db
    .select()
    .from(users)
    .where(and(eq(users.email, input.email), isNull(users.deletedAt)))
    .limit(1);

  let userId: string;
  let status: 'new_pending' | 'reverify_pending';

  if (existing) {
    if (existing.emailVerified && existing.passwordHash) {
      return { ok: false, code: 'email_taken', message: 'Email уже зарегистрирован' };
    }
    await db
      .update(users)
      .set(
        autoVerify ? { passwordHash, emailVerified: true, emailVerifiedAt: now } : { passwordHash }
      )
      .where(eq(users.id, existing.id));
    userId = existing.id;
    status = 'reverify_pending';
  } else {
    try {
      const [created] = await db
        .insert(users)
        .values({
          email: input.email,
          passwordHash,
          role: 'user',
          emailVerified: autoVerify,
          emailVerifiedAt: autoVerify ? now : null
        })
        .returning({ id: users.id });
      userId = created.id;
      status = 'new_pending';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('users_email_key') || msg.includes('unique')) {
        return { ok: false, code: 'email_taken', message: 'Email уже зарегистрирован' };
      }
      throw err;
    }
  }

  if (autoVerify) {
    return { ok: true, status: 'auto_verified', user: { id: userId, email: input.email } };
  }

  const verification = await createVerificationToken(userId, input.email);
  return { ok: true, status, user: { id: userId, email: input.email }, verification };
}

export async function registerAdmin(input: RegisterInput): Promise<RegisterResult> {
  const passwordHash = await hashPassword(input.password);
  const autoVerify = isEmailVerificationDisabled();
  const now = new Date();

  try {
    const [created] = await db
      .insert(users)
      .values({
        email: input.email,
        passwordHash,
        role: 'admin',
        emailVerified: autoVerify,
        emailVerifiedAt: autoVerify ? now : null
      })
      .returning({ id: users.id });

    if (autoVerify) {
      return { ok: true, status: 'auto_verified', user: { id: created.id, email: input.email } };
    }

    const verification = await createVerificationToken(created.id, input.email);
    return {
      ok: true,
      status: 'new_pending',
      user: { id: created.id, email: input.email },
      verification
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('users_email_key') || msg.includes('unique')) {
      return { ok: false, code: 'email_taken', message: 'Email уже зарегистрирован' };
    }
    throw err;
  }
}

export async function login(input: LoginInput): Promise<LoginResult> {
  const [u] = await db
    .select({
      id: users.id,
      email: users.email,
      passwordHash: users.passwordHash,
      emailVerified: users.emailVerified
    })
    .from(users)
    .where(and(eq(users.email, input.email), isNull(users.deletedAt)))
    .limit(1);

  const hashToCheck = u?.passwordHash ?? (await getDummyPasswordHash());
  const passwordOk = await verifyPassword(input.password, hashToCheck);

  if (!u || !u.passwordHash || !passwordOk) {
    return { ok: false, code: 'invalid_credentials', message: 'Неверные данные для входа' };
  }
  if (!u.emailVerified) {
    return {
      ok: false,
      code: 'email_not_verified',
      message: 'Подтвердите email перед входом',
      userId: u.id,
      email: u.email
    };
  }
  const { id: sessionId, expiresAt } = await createSession(u.id);
  return { ok: true, user: { id: u.id, email: u.email }, sessionId, expiresAt };
}

export async function requestPasswordReset(
  input: ForgotPassword
): Promise<
  | { ok: true; sent: false }
  | { ok: true; sent: true; token: PasswordResetToken; email: string }
> {
  const [u] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(and(eq(users.email, input.email), isNull(users.deletedAt)))
    .limit(1);

  if (!u) {
    return { ok: true, sent: false };
  }

  const token = await createPasswordResetToken(u.id);
  return { ok: true, sent: true, token, email: u.email };
}

export async function consumePasswordReset(input: {
  token: string;
  password: string;
}): Promise<
  | { ok: true; user: AuthUser; sessionId: string; expiresAt: Date }
  | { ok: false; code: 'invalid' | 'expired' | 'used'; message: string }
> {
  const consumed = await consumePasswordResetToken(input.token);
  if (!consumed.ok) {
    return consumed;
  }

  const newHash = await hashPassword(input.password);
  const now = new Date();

  await db
    .update(users)
    .set({ passwordHash: newHash, emailVerified: true, emailVerifiedAt: now })
    .where(eq(users.id, consumed.userId));

  await db.delete(sessions).where(eq(sessions.userId, consumed.userId));

  const [u] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, consumed.userId))
    .limit(1);

  if (!u) {
    return { ok: false, code: 'invalid', message: 'Пользователь не найден' };
  }

  const { id: sessionId, expiresAt } = await createSession(u.id);
  return { ok: true, user: { id: u.id, email: u.email }, sessionId, expiresAt };
}
