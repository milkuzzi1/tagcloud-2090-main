import { error, redirect } from '@sveltejs/kit';
import { isValidCode } from '$lib/server/surveys/codes';
import { getSurveyForCreator } from '$lib/server/surveys/get';
import { qrPngBase64 } from '$lib/server/qr/generate';
import { aggregateQuestion } from '$lib/server/cloud/aggregate';
import { env } from '$env/dynamic/private';
import type { CloudWord } from '$lib/types/cloud';
import type { PageServerLoad } from './$types';

/**
 * Режим презентации (creator-only).
 *
 * Логика доступа и SSR-снэпшота — та же, что у дашборда `/s/[code]`:
 *   - либо session-владелец опроса, либо `?t=<creatorToken>` (бэккомпат);
 *   - для уже завершённых опросов начальный агрегат тянем из Postgres
 *     (Redis-ключи cloud:* почищены в processExpired).
 *
 * На клиенте используется тот же `/ws/<code>?t=<token>` канал — снэпшоты
 * прилетают каждые ~2.5с при наличии изменений.
 */
export const load: PageServerLoad = async ({ params, url, locals }) => {
  const code = params.code;
  const token = url.searchParams.get('t') ?? undefined;

  if (!isValidCode(code)) error(400, 'Некорректный код опроса');

  const userId = locals.user?.id;
  if (!userId && !token) {
    redirect(303, `/login?next=${encodeURIComponent(url.pathname)}`);
  }

  const survey = await getSurveyForCreator(code, { userId, token });
  if (!survey) error(404, 'Опрос не найден или нет доступа');

  const baseUrl = env.PUBLIC_BASE_URL || url.origin;
  const respondentUrl = `${baseUrl}/r/${code}`;
  const qrPngBase64Data = await qrPngBase64(respondentUrl);

  let initialWords: Record<string, CloudWord[]> = {};
  if (survey.status !== 'active') {
    const entries = await Promise.all(
      survey.questions.map(async (q) => [q.id, await aggregateQuestion(q.id)] as const)
    );
    initialWords = Object.fromEntries(entries);
  }

  return {
    survey,
    respondentUrl,
    qrPngBase64Data,
    // Токен не отдаём залогиненному владельцу — клиент идёт по session-cookie.
    creatorToken: userId ? undefined : survey.creatorToken,
    initialWords
  };
};
