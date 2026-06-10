import { json } from '@sveltejs/kit';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '$lib/server/db';
import { users } from '$lib/server/schema';
import { createVerificationToken, VERIFICATION_TTL_HOURS } from '$lib/server/auth/verification';
import { sendVerificationEmail } from '$lib/server/email/verification';
import { checkAuthRateLimit } from '$lib/server/voting/rate-limit';
import { resolvePublicBaseUrl } from '$lib/server/net/base-url';
import { log } from '$lib/server/log';
import type { RequestHandler } from './$types';

const Body = z.object({
  email: z.string().trim().toLowerCase().email().max(254)
});

export const POST: RequestHandler = async ({ request, url, locals }) => {
  const raw = await request.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return json({ error: { code: 'invalid_input', issues: parsed.error.issues } }, { status: 400 });
  }

  const rl = await checkAuthRateLimit(locals.clientIp, parsed.data.email);
  if (!rl.allowed) {
    return json(
      { error: { code: 'rate_limited', message: 'Слишком много попыток, попробуйте позже' } },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
    );
  }

  const [u] = await db
    .select({
      id: users.id,
      email: users.email,
      passwordHash: users.passwordHash,
      emailVerified: users.emailVerified
    })
    .from(users)
    .where(and(eq(users.email, parsed.data.email), isNull(users.deletedAt)))
    .limit(1);

  if (u && u.passwordHash && !u.emailVerified) {
    const v = await createVerificationToken(u.id, u.email);
    // resolvePublicBaseUrl fail-closed в проде: не доверяем Host (url.origin).
    const baseUrl = resolvePublicBaseUrl(url.origin);
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
