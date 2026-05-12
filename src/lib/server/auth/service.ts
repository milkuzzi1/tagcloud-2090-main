import { eq } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db } from '../db';
import { users } from '../schema';
import { getDummyPasswordHash, hashPassword, verifyPassword } from './hash';
import { createSession, type AuthUser } from './sessions';
import { createVerificationToken, type VerificationToken } from './verification';
import type { Credentials } from './validation';

/**
 * Временный «kill switch» для подтверждения email.
 *
 * Когда `AUTH_DISABLE_EMAIL_VERIFICATION=true` — мы НЕ выпускаем
 * verification-токен и НЕ дёргаем SMTP. Новые пользователи сразу помечаются
 * как `email_verified = true`, а API регистрации сразу логинит их и ставит
 * сессионную cookie. Нужен на время, пока SMTP недоступен.
 * Включать только при необходимости — без подтверждения email злоумышленник
 * может «забрать» чужие ghost-учётки из 0002 backfill, поэтому в нормальном
 * режиме флаг должен быть выключен.
 */
function isEmailVerificationDisabled(): boolean {
  return env.AUTH_DISABLE_EMAIL_VERIFICATION === 'true';
}

/**
 * Результат регистрации. Сессия НЕ создаётся, пока не подтверждён email —
 * иначе кто угодно мог бы зарегистрироваться на чужой адрес и сразу
 * "забрать" опросы из 0002 backfill (см. claim в register()).
 *
 * Кейсы:
 *   - new_pending           — создан новый user, отправлено письмо.
 *   - claim_pending         — найден ghost-user (password_hash NULL), пароль установлен,
 *                             отправлено письмо. После клика — claim сработает.
 *   - reverify_pending      — на этот email уже зарегистрирован неподтверждённый user.
 *                             Без раскрытия пароля шлём ему новое письмо (idempotent).
 *   - auto_verified         — флаг AUTH_DISABLE_EMAIL_VERIFICATION=true; пользователь
 *                             сразу `email_verified=true`, без письма и без токена.
 *   - email_taken           — email уже зарегистрирован И подтверждён.
 */
export type RegisterResult =
  | {
      ok: true;
      status: 'new_pending' | 'claim_pending' | 'reverify_pending';
      user: AuthUser;
      verification: VerificationToken;
    }
  | {
      ok: true;
      status: 'auto_verified';
      user: AuthUser;
    }
  | { ok: false; code: 'email_taken'; message: string };

export type LoginResult =
  | { ok: true; user: AuthUser; sessionId: string; expiresAt: Date }
  | { ok: false; code: 'invalid_credentials'; message: string }
  | { ok: false; code: 'email_not_verified'; message: string; userId: string; email: string };

export async function register(creds: Credentials): Promise<RegisterResult> {
  const passwordHash = await hashPassword(creds.password);
  const autoVerify = isEmailVerificationDisabled();
  const now = new Date();

  const [existing] = await db.select().from(users).where(eq(users.email, creds.email)).limit(1);

  let userId: string;
  let status: 'new_pending' | 'claim_pending' | 'reverify_pending';

  if (existing) {
    if (existing.passwordHash !== null && existing.emailVerified) {
      return { ok: false, code: 'email_taken', message: 'Email уже зарегистрирован' };
    }
    if (existing.passwordHash === null) {
      // Ghost-user из 0002 backfill — устанавливаем пароль, но claim сработает
      // (через привязку surveys.user_id) только после подтверждения email.
      await db
        .update(users)
        .set(
          autoVerify
            ? { passwordHash, emailVerified: true, emailVerifiedAt: now }
            : { passwordHash, emailVerified: false, emailVerifiedAt: null }
        )
        .where(eq(users.id, existing.id));
      status = 'claim_pending';
    } else {
      // Существует, но email не подтверждён. Перезапишем пароль (пользователь
      // явно регистрируется заново) и пошлём свежее письмо. Это предсказуемое
      // поведение для UX "забыл, что регистрировался" и не создаёт уязвимости
      // (нет сессии до подтверждения email).
      await db
        .update(users)
        .set(
          autoVerify
            ? { passwordHash, emailVerified: true, emailVerifiedAt: now }
            : { passwordHash }
        )
        .where(eq(users.id, existing.id));
      status = 'reverify_pending';
    }
    userId = existing.id;
  } else {
    const [created] = await db
      .insert(users)
      .values({
        email: creds.email,
        passwordHash,
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
      user: { id: userId, email: creds.email }
    };
  }

  const verification = await createVerificationToken(userId, creds.email);
  return {
    ok: true,
    status,
    user: { id: userId, email: creds.email },
    verification
  };
}

export async function login(creds: Credentials): Promise<LoginResult> {
  const [u] = await db.select().from(users).where(eq(users.email, creds.email)).limit(1);

  // Если пользователя нет (или это ghost без passwordHash), всё равно делаем
  // bcrypt.compare с фейковым хэшем — это уравнивает время ответа для
  // существующих/несуществующих email и не даёт enumeration через timing.
  // bcrypt 11 rounds = ~80мс; «нашли — не нашли» при сравнении пары DB-вызовов
  // отличались бы на эти же 80мс.
  const hashToCheck = u?.passwordHash ?? (await getDummyPasswordHash());
  const passwordOk = await verifyPassword(creds.password, hashToCheck);

  if (!u || !u.passwordHash || !passwordOk) {
    return { ok: false, code: 'invalid_credentials', message: 'Неверный email или пароль' };
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
