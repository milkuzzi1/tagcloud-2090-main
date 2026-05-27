import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import { db } from '../db';
import { emailVerificationTokens, users } from '../schema';

export const VERIFICATION_TTL_HOURS = 24;

export type VerificationToken = {
  token: string;
  userId: string;
  email: string;
  expiresAt: Date;
};

/**
 * Создаёт новый verification-токен. Старые неиспользованные токены этого
 * пользователя сразу помечаем `used_at = NOW()` — иначе ссылка из старого
 * письма продолжала бы работать после "забыл, переотправил".
 */
export async function createVerificationToken(
  userId: string,
  email: string
): Promise<VerificationToken> {
  const expiresAt = new Date(Date.now() + VERIFICATION_TTL_HOURS * 60 * 60 * 1000);

  return await db.transaction(async (tx) => {
    await tx
      .update(emailVerificationTokens)
      .set({ usedAt: new Date() })
      .where(
        and(eq(emailVerificationTokens.userId, userId), isNull(emailVerificationTokens.usedAt))
      );

    const [created] = await tx
      .insert(emailVerificationTokens)
      .values({ userId, email, expiresAt })
      .returning({ token: emailVerificationTokens.token });

    return { token: created.token, userId, email, expiresAt };
  });
}

export type ConsumeResult =
  | { ok: true; userId: string; email: string }
  | { ok: false; code: 'invalid' | 'expired' | 'used'; message: string };

/**
 * Атомарно "тратит" токен и помечает пользователя email_verified.
 * Используется `UPDATE … RETURNING` для защиты от двойного клика по ссылке.
 */
export async function consumeVerificationToken(token: string): Promise<ConsumeResult> {
  const now = new Date();

  // Атомарно помечаем токен использованным (только если он валиден и не использован).
  const claimed = await db
    .update(emailVerificationTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(emailVerificationTokens.token, token),
        isNull(emailVerificationTokens.usedAt),
        gt(emailVerificationTokens.expiresAt, now)
      )
    )
    .returning({
      userId: emailVerificationTokens.userId,
      email: emailVerificationTokens.email
    });

  if (claimed.length === 0) {
    // Разделим причины: токен вообще не существует / истёк / уже использован.
    const [row] = await db
      .select({
        usedAt: emailVerificationTokens.usedAt,
        expiresAt: emailVerificationTokens.expiresAt
      })
      .from(emailVerificationTokens)
      .where(eq(emailVerificationTokens.token, token))
      .limit(1);

    if (!row) return { ok: false, code: 'invalid', message: 'Ссылка недействительна' };
    if (row.usedAt) return { ok: false, code: 'used', message: 'Ссылка уже использована' };
    return { ok: false, code: 'expired', message: 'Срок действия ссылки истёк' };
  }

  // Помечаем пользователя как verified. Идемпотентно: если уже стоял true —
  // просто перезапишем `email_verified_at`, что нестрашно.
  await db
    .update(users)
    .set({ emailVerified: true, emailVerifiedAt: now })
    .where(eq(users.id, claimed[0].userId));

  return { ok: true, userId: claimed[0].userId, email: claimed[0].email };
}

export async function purgeExpiredVerificationTokens(): Promise<number> {
  const deleted = await db
    .delete(emailVerificationTokens)
    .where(lt(emailVerificationTokens.expiresAt, new Date()))
    .returning({ token: emailVerificationTokens.token });
  return deleted.length;
}
