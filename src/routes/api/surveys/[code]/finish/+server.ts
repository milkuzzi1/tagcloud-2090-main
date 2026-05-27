import { json } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { surveys } from '$lib/server/schema';
import { processExpired } from '$lib/server/expiry/process';
import { requireCreatorAccess } from '$lib/server/auth/access';
import { notifyUserSurveyStatus } from '$lib/server/realtime/broadcast';
import { log, withLogContext } from '$lib/server/log';
import type { RequestHandler } from './$types';

/**
 * Завершает голосование. Атомарный переход active → expired, после этого
 * ставим обработку (рендер PNG + CSV + SMTP) на фон через `setImmediate`,
 * а клиенту сразу возвращаем 202.
 *
 * Раньше тут был `await processExpired`: HTTP висел до завершения SMTP
 * (десятки секунд при медленном провайдере), один HTTP-воркер был занят
 * всё это время. Если фоновая задача упадёт — cron подберёт опрос как
 * stuck-expired (см. STUCK_EXPIRED_THRESHOLD_MS) и повторит попытку.
 */
export const POST: RequestHandler = async ({ params, url, locals }) => {
  const access = await requireCreatorAccess({
    code: params.code!,
    userId: locals.user?.id,
    token: url.searchParams.get('t')
  });
  if (!access.ok) {
    return json(
      { error: { code: access.code, message: access.message } },
      { status: access.status }
    );
  }
  const survey = access.survey;

  // Атомарный переход active → expired. Если кто-то уже забрал — 409.
  const [claimed] = await db
    .update(surveys)
    .set({ status: 'expired', expiresAt: new Date() })
    .where(and(eq(surveys.id, survey.id), eq(surveys.status, 'active')))
    .returning();

  if (!claimed) {
    return json(
      {
        error: {
          code: 'already_finished',
          message: 'Опрос уже завершён',
          status: survey.status
        }
      },
      { status: 409 }
    );
  }

  // Push в /ws/u: владельцу на других вкладках сразу видно «Истёк».
  // Финальный 'sent'/'failed' прилетит из processExpired ниже.
  notifyUserSurveyStatus(claimed.userId, claimed.code, 'expired');

  // Запускаем обработку в фоне. Ошибки логируем — статус будет 'failed',
  // дашборд автоматически предложит retry.
  setImmediate(() => {
    void withLogContext({ surveyCode: claimed.code, surveyId: claimed.id }, () =>
      processExpired(claimed).catch((err) => {
        log.error('finish_background_process_failed', {
          err: err instanceof Error ? err.message : String(err)
        });
      })
    );
  });

  return json({ ok: true, status: 'expired' as const }, { status: 202 });
};
