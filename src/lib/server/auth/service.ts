import { and, eq, isNull } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db } from '../db';
import { organizationInvites, organizations, sessions, users } from '../schema';
import { getDummyPasswordHash, hashPassword, verifyPassword } from './hash';
import { createSession, type AuthUser } from './sessions';
import { createVerificationToken, type VerificationToken } from './verification';
import {
  consumePasswordResetToken,
  createPasswordResetToken,
  type PasswordResetToken
} from './password-reset';
import type { AdminRegister, ForgotPassword, LoginInput, UserRegister } from './validation';
import { normalizeOrgName } from './validation';

/**
 * Временный «kill switch» для подтверждения email.
 *
 * Когда `AUTH_DISABLE_EMAIL_VERIFICATION=true` — мы НЕ выпускаем
 * verification-токен и НЕ дёргаем SMTP. Новые пользователи сразу помечаются
 * как `email_verified = true`, а API регистрации сразу логинит их и ставит
 * сессионную cookie. Нужен на время, пока SMTP недоступен.
 */
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
  | { ok: false; code: 'org_taken'; message: string }
  | { ok: false; code: 'org_not_found'; message: string }
  | { ok: false; code: 'no_access'; message: string };

export type LoginResult =
  | { ok: true; user: AuthUser; sessionId: string; expiresAt: Date }
  | { ok: false; code: 'invalid_credentials'; message: string }
  | { ok: false; code: 'email_not_verified'; message: string; userId: string; email: string };

/**
 * Создаёт новую организацию и первого админа в ней.
 *
 * Атомарно: либо успешно создаются org+user, либо возвращается ошибка
 * 'org_taken' / 'email_taken'. UNIQUE-индекс на name_normalized защищает
 * от гонки одновременной регистрации одинакового имени.
 */
export async function registerAdmin(input: AdminRegister): Promise<RegisterResult> {
  const passwordHash = await hashPassword(input.password);
  const autoVerify = isEmailVerificationDisabled();
  const now = new Date();
  const nameNormalized = normalizeOrgName(input.organizationName);

  let userId: string;
  let orgId: string;
  try {
    const result = await db.transaction(async (tx) => {
      const [org] = await tx
        .insert(organizations)
        .values({ name: input.organizationName.trim(), nameNormalized })
        .returning({ id: organizations.id });

      const [created] = await tx
        .insert(users)
        .values({
          organizationId: org.id,
          email: input.email,
          passwordHash,
          role: 'admin',
          emailVerified: autoVerify,
          emailVerifiedAt: autoVerify ? now : null
        })
        .returning({ id: users.id });

      // Сами себя добавляем в allowlist, чтобы admin-аккаунт был
      // консистентен с моделью «members = users в org».
      await tx
        .insert(organizationInvites)
        .values({ organizationId: org.id, email: input.email, invitedBy: created.id })
        .onConflictDoNothing();

      return { userId: created.id, orgId: org.id };
    });
    userId = result.userId;
    orgId = result.orgId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('organizations_name_normalized_unique')) {
      return {
        ok: false,
        code: 'org_taken',
        message: 'Организация с таким названием уже существует'
      };
    }
    if (msg.includes('users_org_email_unique')) {
      return { ok: false, code: 'email_taken', message: 'Email уже зарегистрирован' };
    }
    throw err;
  }

  // Без unused-var: orgId возвращён для будущих нужд, но сейчас используется
  // только косвенно через created user.
  void orgId;

  if (autoVerify) {
    return {
      ok: true,
      status: 'auto_verified',
      user: { id: userId, email: input.email }
    };
  }

  const verification = await createVerificationToken(userId, input.email);
  return {
    ok: true,
    status: 'new_pending',
    user: { id: userId, email: input.email },
    verification
  };
}

/**
 * Регистрирует обычного пользователя в существующей организации.
 *
 * Двойная проверка:
 *  1. Организация существует (иначе → 'org_not_found' — «Проверьте название
 *     организации»).
 *  2. Email в allowlist (organization_invites) этой организации
 *     (иначе → 'no_access' — «У вас нет доступа к сервису в этой организации»).
 */
export async function registerUser(input: UserRegister): Promise<RegisterResult> {
  const passwordHash = await hashPassword(input.password);
  const autoVerify = isEmailVerificationDisabled();
  const now = new Date();
  const nameNormalized = normalizeOrgName(input.organizationName);

  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.nameNormalized, nameNormalized))
    .limit(1);

  if (!org) {
    return { ok: false, code: 'org_not_found', message: 'Проверьте название организации' };
  }

  const [invite] = await db
    .select({ id: organizationInvites.id })
    .from(organizationInvites)
    .where(
      and(
        eq(organizationInvites.organizationId, org.id),
        eq(organizationInvites.email, input.email)
      )
    )
    .limit(1);

  if (!invite) {
    return {
      ok: false,
      code: 'no_access',
      message: 'У вас нет доступа к сервису в этой организации'
    };
  }

  // Если уже есть user с этим email в этой org — это либо повторная попытка
  // (claim_pending / reverify_pending), либо настоящее столкновение.
  const [existing] = await db
    .select()
    .from(users)
    .where(
      and(eq(users.organizationId, org.id), eq(users.email, input.email), isNull(users.deletedAt))
    )
    .limit(1);

  let userId: string;
  let status: 'new_pending' | 'reverify_pending';

  if (existing) {
    if (existing.emailVerified && existing.passwordHash) {
      return { ok: false, code: 'email_taken', message: 'Email уже зарегистрирован' };
    }
    // Email ещё не подтверждён — перезапишем пароль и пошлём свежее письмо.
    // Это путь "забыл, что регистрировался"; до подтверждения email сессии нет,
    // поэтому такое поведение безопасно.
    await db
      .update(users)
      .set(
        autoVerify ? { passwordHash, emailVerified: true, emailVerifiedAt: now } : { passwordHash }
      )
      .where(eq(users.id, existing.id));
    userId = existing.id;
    status = 'reverify_pending';
  } else {
    const [created] = await db
      .insert(users)
      .values({
        organizationId: org.id,
        email: input.email,
        passwordHash,
        role: 'user',
        emailVerified: autoVerify,
        emailVerifiedAt: autoVerify ? now : null
      })
      .returning({ id: users.id });
    userId = created.id;
    status = 'new_pending';
  }

  if (autoVerify) {
    return {
      ok: true,
      status: 'auto_verified',
      user: { id: userId, email: input.email }
    };
  }

  const verification = await createVerificationToken(userId, input.email);
  return {
    ok: true,
    status,
    user: { id: userId, email: input.email },
    verification
  };
}

/**
 * Логин по (организация, email, пароль).
 *
 * Timing-safe: даже если организации/пользователя нет, всё равно делаем
 * bcrypt.compare с фейковым хэшем (см. оригинальный login()). Это
 * выравнивает время ответа и не даёт enumerate ни орг, ни email через
 * замер задержки.
 */
export async function login(input: LoginInput): Promise<LoginResult> {
  const nameNormalized = normalizeOrgName(input.organizationName);

  const [u] = await db
    .select({
      id: users.id,
      email: users.email,
      passwordHash: users.passwordHash,
      emailVerified: users.emailVerified
    })
    .from(users)
    .innerJoin(organizations, eq(users.organizationId, organizations.id))
    .where(
      and(
        eq(organizations.nameNormalized, nameNormalized),
        eq(users.email, input.email),
        isNull(users.deletedAt)
      )
    )
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
  return {
    ok: true,
    user: { id: u.id, email: u.email },
    sessionId,
    expiresAt
  };
}

/**
 * Идемпотентно генерирует токен восстановления пароля.
 *
 * Если связки (org, email) нет в БД — ничего не делаем и возвращаем
 * { ok: true, sent: false }. Эндпоинт всё равно отдаёт 202 OK
 * (см. /api/auth/forgot-password) — это защита от email enumeration.
 */
export async function requestPasswordReset(
  input: ForgotPassword
): Promise<
  | { ok: true; sent: false }
  | { ok: true; sent: true; token: PasswordResetToken; email: string; organizationName: string }
> {
  const nameNormalized = normalizeOrgName(input.organizationName);

  const [u] = await db
    .select({
      id: users.id,
      email: users.email,
      organizationName: organizations.name
    })
    .from(users)
    .innerJoin(organizations, eq(users.organizationId, organizations.id))
    .where(
      and(
        eq(organizations.nameNormalized, nameNormalized),
        eq(users.email, input.email),
        isNull(users.deletedAt)
      )
    )
    .limit(1);

  if (!u) {
    return { ok: true, sent: false };
  }

  const token = await createPasswordResetToken(u.id);
  return {
    ok: true,
    sent: true,
    token,
    email: u.email,
    organizationName: u.organizationName
  };
}

/**
 * Атомарно потребляет токен (см. consumePasswordResetToken), обновляет
 * пароль, выставляет email_verified=true (раз пользователь только что
 * доказал владение почтой) и убивает все прежние сессии — защита от
 * угнанной сессии параллельно со сбросом пароля. Создаёт новую сессию.
 */
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

  // Гасим все прежние сессии — если пароль сбрасывают, прежняя сессия
  // считается скомпрометированной до доказательств обратного.
  await db.delete(sessions).where(eq(sessions.userId, consumed.userId));

  const [u] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, consumed.userId))
    .limit(1);

  if (!u) {
    // Не должно случаться — токен FK→users on delete cascade.
    return { ok: false, code: 'invalid', message: 'Пользователь не найден' };
  }

  const { id: sessionId, expiresAt } = await createSession(u.id);
  return {
    ok: true,
    user: { id: u.id, email: u.email },
    sessionId,
    expiresAt
  };
}
