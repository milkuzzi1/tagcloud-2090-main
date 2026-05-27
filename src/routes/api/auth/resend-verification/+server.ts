import { json } from '@sveltejs/kit';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { organizations, users } from '$lib/server/schema';
import { createVerificationToken, VERIFICATION_TTL_HOURS } from '$lib/server/auth/verification';
import { sendVerificationEmail } from '$lib/server/email/verification';
import { checkAuthRateLimit } from '$lib/server/voting/rate-limit';
import { normalizeOrgName, OrganizationNameSchema } from '$lib/server/auth/validation';
import { log } from '$lib/server/log';
import type { RequestHandler } from './$types';

const Body = z.object({
  organizationName: OrganizationNameSchema,
  email: z.string().trim().toLowerCase().email().max(254)
});

/**
 * Переотправка verification-ссылки. Отвечает 202 в любом случае, чтобы
 * атакующий не мог по разнице ответов перебирать зарегистрированные (org, email).
 * Реальная отправка (и логирование ошибки SMTP) происходит только если
 * пользователь существует, имеет пароль и ещё не подтверждён.
 */
export const POST: RequestHandler = async ({ request, url, getClientAddress }) => {
  const raw = await request.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return json({ error: { code: 'invalid_input', issues: parsed.error.issues } }, { status: 400 });
  }

  const rl = await checkAuthRateLimit(getClientAddress(), parsed.data.email);
  if (!rl.allowed) {
    return json(
      { error: { code: 'rate_limited', message: 'Слишком много попыток, попробуйте позже' } },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
    );
  }

  const nameNormalized = normalizeOrgName(parsed.data.organizationName);
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
        eq(users.email, parsed.data.email),
        isNull(users.deletedAt)
      )
    )
    .limit(1);

  if (u && u.passwordHash && !u.emailVerified) {
    const v = await createVerificationToken(u.id, u.email);
    const baseUrl = env.PUBLIC_BASE_URL || env.ORIGIN || url.origin;
    try {
      await sendVerificationEmail({
        to: u.email,
        verifyUrl: `${baseUrl}/verify?t=${v.token}`,
        ttlHours: VERIFICATION_TTL_HOURS
      });
    } catch (err) {
      log.error('resend_verification_send_failed', {
        err: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return json({ ok: true, ttlHours: VERIFICATION_TTL_HOURS }, { status: 202 });
};
