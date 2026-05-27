import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import { db } from '../db';
import { passwordResetTokens } from '../schema';

export const PASSWORD_RESET_TTL_HOURS = 1;

export type PasswordResetToken = {
  token: string;
  userId: string;
  expiresAt: Date;
};

function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Создаёт новый password-reset токен. Старые неиспользованные токены этого
 * пользователя сразу помечаем `used_at = NOW()` — паттерн как у
 * verification-токенов (см. verification.ts:19), чтобы ссылка из старого
 * письма не работала после повторного "забыли пароль".
 */
export async function createPasswordResetToken(userId: string): Promise<PasswordResetToken> {
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_HOURS * 60 * 60 * 1000);
  const token = generateToken();

  return await db.transaction(async (tx) => {
    await tx
      .update(passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)));

    await tx.insert(passwordResetTokens).values({ token, userId, expiresAt });

    return { token, userId, expiresAt };
  });
}

export type ConsumeResult =
  | { ok: true; userId: string }
  | { ok: false; code: 'invalid' | 'expired' | 'used'; message: string };

/**
 * Атомарно "тратит" токен. Зеркалит логику consumeVerificationToken
 * (см. verification.ts:50) — UPDATE с условиями + RETURNING, ручная
 * диагностика причины (invalid/expired/used) для UX.
 */
export async function consumePasswordResetToken(token: string): Promise<ConsumeResult> {
  const now = new Date();

  const claimed = await db
    .update(passwordResetTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(passwordResetTokens.token, token),
        isNull(passwordResetTokens.usedAt),
        gt(passwordResetTokens.expiresAt, now)
      )
    )
    .returning({ userId: passwordResetTokens.userId });

  if (claimed.length === 0) {
    const [row] = await db
      .select({
        usedAt: passwordResetTokens.usedAt,
        expiresAt: passwordResetTokens.expiresAt
      })
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.token, token))
      .limit(1);

    if (!row) return { ok: false, code: 'invalid', message: 'Ссылка недействительна' };
    if (row.usedAt) return { ok: false, code: 'used', message: 'Ссылка уже использована' };
    return { ok: false, code: 'expired', message: 'Срок действия ссылки истёк' };
  }

  return { ok: true, userId: claimed[0].userId };
}

/**
 * Без consume — проверка валидности (для load на странице /reset-password,
 * чтобы решить, показывать форму или ошибку).
 */
export async function peekPasswordResetToken(token: string): Promise<ConsumeResult> {
  const now = new Date();
  const [row] = await db
    .select({
      userId: passwordResetTokens.userId,
      usedAt: passwordResetTokens.usedAt,
      expiresAt: passwordResetTokens.expiresAt
    })
    .from(passwordResetTokens)
    .where(eq(passwordResetTokens.token, token))
    .limit(1);

  if (!row) return { ok: false, code: 'invalid', message: 'Ссылка недействительна' };
  if (row.usedAt) return { ok: false, code: 'used', message: 'Ссылка уже использована' };
  if (row.expiresAt <= now)
    return { ok: false, code: 'expired', message: 'Срок действия ссылки истёк' };
  return { ok: true, userId: row.userId };
}

export async function purgeExpiredPasswordResetTokens(): Promise<number> {
  const deleted = await db
    .delete(passwordResetTokens)
    .where(lt(passwordResetTokens.expiresAt, new Date()))
    .returning({ token: passwordResetTokens.token });
  return deleted.length;
}
