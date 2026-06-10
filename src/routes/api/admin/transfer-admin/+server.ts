import { json } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { z } from 'zod';
import { requireAdmin } from '$lib/server/auth/access';
import { promoteOrCreateAdmin } from '$lib/server/auth/service';
import {
  countAdmins,
  createAdminHandover,
  completeAdminHandoverFor
} from '$lib/server/auth/invites';
import {
  createPasswordResetToken,
  PASSWORD_RESET_TTL_HOURS
} from '$lib/server/auth/password-reset';
import { sendPasswordResetEmail } from '$lib/server/email/password-reset';
import { db } from '$lib/server/db';
import { log } from '$lib/server/log';
import { resolvePublicBaseUrl } from '$lib/server/net/base-url';
import type { RequestHandler } from './$types';

const Body = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  // Whether to keep the outgoing (current) admin's data when they are removed.
  keepData: z.boolean().optional().default(false)
});

// Константа advisory-lock'а для сериализации передачи администрирования.
// Любой произвольный bigint; важно лишь, что он уникален для этой операции.
const TRANSFER_ADMIN_LOCK_KEY = 4823_1001;

/**
 * POST /api/admin/transfer-admin  (Req 2 + Req 3)
 *
 * The current (sole) admin hands administration to another person identified
 * by email.
 *
 * Variant (A): if a live user with that email already exists, we PROMOTE that
 * existing account to admin in place — we do not create a second row for the
 * same email (which previously caused duplicate accounts and a
 * non-deterministic login).
 *
 * Outgoing-admin removal:
 *   - if the incoming person already has a password (existing active user),
 *     the handover completes IMMEDIATELY — they can already sign in, so the
 *     outgoing admin is removed right away (no email needed);
 *   - otherwise (new account, or invited user who never set a password) the
 *     outgoing admin is removed only AFTER the incoming person sets their
 *     password via the emailed link (consumePasswordReset ->
 *     completeAdminHandoverFor), so a failed/abandoned invite never leaves the
 *     system without an admin.
 *
 * Guard: only the SOLE admin may transfer (enforces Req 3). The sole-admin
 * check, the promotion и регистрация handover выполняются в ОДНОЙ транзакции
 * под pg advisory-lock — иначе два параллельных запроса оба видели бы «1 админ»
 * и оба проходили (гонка → 0 или 2+ админов).
 */
export const POST: RequestHandler = async ({ request, url, locals }) => {
  const admin = requireAdmin(locals.user);

  const raw = await request.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return json({ error: { code: 'invalid_input', issues: parsed.error.issues } }, { status: 400 });
  }

  if (parsed.data.email === admin.email) {
    return json(
      {
        error: { code: 'self_transfer', message: 'Нельзя передать администрирование самому себе' }
      },
      { status: 400 }
    );
  }

  type TxOutcome =
    | { kind: 'not_sole_admin' }
    | { kind: 'promote_failed'; code: string; message: string }
    | {
        kind: 'immediate';
        email: string;
        action: 'promoted' | 'created';
      }
    | {
        kind: 'deferred';
        userId: string;
        email: string;
        action: 'promoted' | 'created';
      };

  const outcome = await db.transaction(async (tx): Promise<TxOutcome> => {
    // Сериализуем все одновременные передачи: второй запрос будет ждать здесь,
    // пока первый не закоммитит (и не увидит уже двух админов → not_sole_admin).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${TRANSFER_ADMIN_LOCK_KEY})`);

    const total = await countAdmins(tx);
    if (total !== 1) return { kind: 'not_sole_admin' };

    const result = await promoteOrCreateAdmin(parsed.data.email, tx);
    if (!result.ok) {
      return { kind: 'promote_failed', code: result.code, message: result.message };
    }

    await createAdminHandover(
      {
        incomingUserId: result.user.id,
        outgoingUserId: admin.id,
        keepOutgoingData: parsed.data.keepData
      },
      tx
    );

    // Входящий уже может войти — завершаем handover немедленно (внутри той же
    // транзакции, т.к. completeAdminHandoverFor принимает executor).
    if (result.hasPassword) {
      await completeAdminHandoverFor(result.user.id, tx);
      return { kind: 'immediate', email: result.user.email, action: result.action };
    }

    return {
      kind: 'deferred',
      userId: result.user.id,
      email: result.user.email,
      action: result.action
    };
  });

  if (outcome.kind === 'not_sole_admin') {
    return json(
      {
        error: {
          code: 'not_sole_admin',
          message: 'Передача администрирования доступна только единственному администратору'
        }
      },
      { status: 409 }
    );
  }
  if (outcome.kind === 'promote_failed') {
    return json({ error: { code: outcome.code, message: outcome.message } }, { status: 409 });
  }

  if (outcome.kind === 'immediate') {
    log.info('transfer_admin_completed_immediately', {
      incomingEmail: outcome.email,
      outgoingUserId: admin.id
    });
    return json(
      {
        ok: true,
        email: outcome.email,
        action: outcome.action,
        completed: true,
        message: 'Администрирование передано. Ваш аккаунт удалён.'
      },
      { status: 200 }
    );
  }

  // Deferred: высылаем ссылку для установки пароля. Промоут + handover уже
  // закоммичены, поэтому НЕ откатываемся при сбое SMTP — вместо этого честно
  // сообщаем клиенту emailSent:false, чтобы UI предложил «переотправить».
  const token = await createPasswordResetToken(outcome.userId);
  const baseUrl = resolvePublicBaseUrl(url.origin);
  const setPasswordUrl = `${baseUrl}/reset-password?t=${token.token}`;
  const organizationName = env.APP_NAME || 'Облако тегов 2090';

  let emailSent = true;
  try {
    await sendPasswordResetEmail({
      to: outcome.email,
      resetUrl: setPasswordUrl,
      ttlHours: PASSWORD_RESET_TTL_HOURS,
      organizationName
    });
  } catch (err) {
    emailSent = false;
    log.error('transfer_admin_send_failed', {
      incomingUserId: outcome.userId,
      err: err instanceof Error ? err.message : String(err)
    });
  }

  log.info('transfer_admin_initiated', {
    incomingUserId: outcome.userId,
    outgoingUserId: admin.id,
    action: outcome.action,
    emailSent
  });

  return json(
    {
      ok: true,
      email: outcome.email,
      action: outcome.action,
      completed: false,
      emailSent,
      ttlHours: PASSWORD_RESET_TTL_HOURS,
      message: emailSent
        ? undefined
        : 'Аккаунт назначен, но письмо со ссылкой не отправилось. Переотправьте ссылку.'
    },
    { status: emailSent ? 201 : 502 }
  );
};
