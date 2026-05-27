import { json } from '@sveltejs/kit';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { surveys } from '$lib/server/schema';
import { processExpired } from '$lib/server/expiry/process';
import { requireCreatorAccess } from '$lib/server/auth/access';
import { notifyUserSurveyStatus } from '$lib/server/realtime/broadcast';
import { log, withLogContext } from '$lib/server/log';
import type { RequestHandler } from './$types';

/**
 * Повторная попытка обработки/отправки результатов.
 *
 * Помечаем опрос как `expired` (если был `failed`) и запускаем обработку
 * в фоне через `setImmediate`. HTTP отвечает 202 сразу — UI снимает
 * крутилку «Отправляем…» и подписывается на статус через WS / опрос
 * страницы. Если фон упадёт — cron подберёт как stuck-expired через
 * STUCK_EXPIRED_THRESHOLD_MS.
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

  // Можно retry только если опрос завершён неудачно или застрял в обработке.
  const [claimed] = await db
    .update(surveys)
    .set({ status: 'expired' })
    .where(and(eq(surveys.id, survey.id), inArray(surveys.status, ['failed', 'expired'])))
    .returning();

  if (!claimed) {
    return json(
      {
        error: {
          code: 'cannot_retry',
          message: `Нельзя retry для статуса ${survey.status}`,
          status: survey.status
        }
      },
      { status: 409 }
    );
  }

  // Возвращаем UI в состояние «Истёк» сразу — пользователь видит,
  // что попытка началась, до завершения SMTP.
  notifyUserSurveyStatus(claimed.userId, claimed.code, 'expired');

  setImmediate(() => {
    void withLogContext({ surveyCode: claimed.code, surveyId: claimed.id }, () =>
      processExpired(claimed).catch((err) => {
        log.error('retry_background_process_failed', {
          err: err instanceof Error ? err.message : String(err)
        });
      })
    );
  });

  return json({ ok: true, status: 'expired' as const }, { status: 202 });
};
