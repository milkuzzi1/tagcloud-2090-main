import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { requireAdmin } from '$lib/server/auth/access';
import { changeAdminEmail } from '$lib/server/auth/invites';
import { verifyPassword, getDummyPasswordHash } from '$lib/server/auth/hash';
import { db } from '$lib/server/db';
import { users } from '$lib/server/schema';
import { checkAuthRateLimit } from '$lib/server/voting/rate-limit';
import { log } from '$lib/server/log';
import type { RequestHandler } from './$types';

const Body = z.object({
  newEmail: z.string().trim().toLowerCase().email().max(254),
  // Re-authenticate with the current password before changing the email.
  currentPassword: z.string().min(1).max(72)
});

/**
 * POST /api/admin/change-email  (Req 4b)
 *
 * Changes the email of the currently logged-in admin account. Requires the
 * current password (re-auth) to prevent a hijacked session from silently
 * taking over the account by switching its email.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
  const admin = requireAdmin(locals.user);

  const rl = await checkAuthRateLimit(locals.clientIp, `change-email:${admin.id}`);
  if (!rl.allowed) {
    return json(
      { error: { code: 'rate_limited', message: 'Слишком много попыток, попробуйте позже' } },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
    );
  }

  const raw = await request.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return json({ error: { code: 'invalid_input', issues: parsed.error.issues } }, { status: 400 });
  }

  // Re-authenticate (timing-equalised with a dummy hash when none is set).
  const [row] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, admin.id))
    .limit(1);
  const hashToCheck = row?.passwordHash ?? (await getDummyPasswordHash());
  const ok = await verifyPassword(parsed.data.currentPassword, hashToCheck);
  if (!row?.passwordHash || !ok) {
    return json(
      { error: { code: 'invalid_password', message: 'Неверный текущий пароль' } },
      { status: 403 }
    );
  }

  const result = await changeAdminEmail({ userId: admin.id, newEmail: parsed.data.newEmail });
  if (result === 'email_taken') {
    return json(
      { error: { code: 'email_taken', message: 'Этот email уже занят' } },
      { status: 409 }
    );
  }
  if (result === 'not_found') {
    return json({ error: { code: 'not_found', message: 'Аккаунт не найден' } }, { status: 404 });
  }

  log.info('admin_email_changed', { userId: admin.id, newEmail: parsed.data.newEmail });
  return json({ ok: true, email: parsed.data.newEmail }, { status: 200 });
};
