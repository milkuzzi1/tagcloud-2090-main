import { eq } from 'drizzle-orm';
import { db } from '../db';
import { surveys } from '../schema';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const LENGTH = 6;
const CODE_REGEX = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

export function isValidCode(code: string): boolean {
  return CODE_REGEX.test(code);
}

export function generateCode(): string {
  const buf = new Uint8Array(LENGTH);
  crypto.getRandomValues(buf);
  let s = '';
  for (let i = 0; i < LENGTH; i++) {
    s += ALPHABET[buf[i] % ALPHABET.length];
  }
  return s;
}

export async function generateUniqueCode(maxAttempts = 5): Promise<string> {
  for (let i = 0; i < maxAttempts; i++) {
    const code = generateCode();
    const existing = await db
      .select({ id: surveys.id })
      .from(surveys)
      .where(eq(surveys.code, code))
      .limit(1);
    if (existing.length === 0) return code;
  }
  throw new Error(`Не удалось сгенерировать уникальный код за ${maxAttempts} попыток`);
}
