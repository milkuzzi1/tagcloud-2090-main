import { error, redirect } from '@sveltejs/kit';
import { isValidCode } from '$lib/server/surveys/codes';
import { getSurveyForCreator } from '$lib/server/surveys/get';
import { qrPngBase64 } from '$lib/server/qr/generate';
import { aggregateQuestion } from '$lib/server/cloud/aggregate';
import { env } from '$env/dynamic/private';
import type { CloudWord } from '$lib/types/cloud';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, url, locals }) => {
  const code = params.code;
  const token = url.searchParams.get('t') ?? undefined;

  if (!isValidCode(code)) error(400, 'Некорректный код опроса');

  // Доступ: session-владелец ИЛИ старый ?t=token (бэккомпат)
  const userId = locals.user?.id;
  if (!userId && !token) {
    redirect(303, `/login?next=${encodeURIComponent(url.pathname)}`);
  }

  const survey = await getSurveyForCreator(code, { userId, token });
  if (!survey) error(404, 'Опрос не найден или нет доступа');

  const baseUrl = env.PUBLIC_BASE_URL || url.origin;
  const respondentUrl = `${baseUrl}/r/${code}`;
  const qrPngBase64Data = await qrPngBase64(respondentUrl);

  // Для завершённых опросов (sent/failed/expired) Redis-ключи cloud:${qid}
  // уже почищены в processExpired, а WS открывает короткий канал и сразу
  // шлёт 'closed' без снапшотов. Чтобы дашборд не упирался в пустое облако,
  // достаём агрегат напрямую из Postgres (responses) — данные живы навсегда.
  let initialWords: Record<string, CloudWord[]> = {};
  if (survey.status !== 'active') {
    const entries = await Promise.all(
      survey.questions.map(async (q) => [q.id, await aggregateQuestion(q.id)] as const)
    );
    initialWords = Object.fromEntries(entries);
  }

  // creatorToken используется на клиенте для WS upgrade.
  // При session-доступе тоже отдаём — клиент уже прошёл проверку прав.
  return {
    survey,
    respondentUrl,
    qrPngBase64Data,
    creatorToken: survey.creatorToken,
    initialWords
  };
};
