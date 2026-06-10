import { error, redirect } from '@sveltejs/kit';
import { isValidCode } from '$lib/server/surveys/codes';
import { getSurveyForCreator } from '$lib/server/surveys/get';
import { aggregateQuestion } from '$lib/server/cloud/aggregate';
import type { CloudWord } from '$lib/types/cloud';
import type { PageServerLoad } from './$types';

/**
 * Чистый просмотр облака (creator-only, chromeless).
 *
 * Эта страница открывается из дашборда `/s/[code]` по клику на облако
 * («Открыть облако в новой вкладке», правка №2). На странице нет шапки,
 * футера и навигации — только canvas с облаком.
 *
 * Доступ — только у создателя опроса (по session-cookie или ?t=<token>),
 * как и у дашборда/презентации. Публичная страница просмотра облака
 * и отдельная кнопка «Посмотреть облако» в конце опроса удалены
 * (правка №4).
 */
export const load: PageServerLoad = async ({ params, url, locals }) => {
  const code = params.code;
  const token = url.searchParams.get('t') ?? undefined;

  if (!isValidCode(code)) error(404, 'Опрос не найден');

  const userId = locals.user?.id;
  if (!userId && !token) {
    redirect(303, `/login?next=${encodeURIComponent(url.pathname)}`);
  }

  const survey = await getSurveyForCreator(code, { userId, token });
  if (!survey) error(404, 'Опрос не найден или нет доступа');

  // SSR-снэпшот облак для каждого вопроса. Дальше клиент подключается
  // к креатор-WS `/ws/<code>?t=<token>`, где сервер пушит snapshots
  // по pub/sub (без поллинга и без нагрузки на Postgres).
  const entries = await Promise.all(
    survey.questions.map(async (q) => [q.id, await aggregateQuestion(q.id, 200)] as const)
  );
  const initialWords: Record<string, CloudWord[]> = Object.fromEntries(entries);

  // Токен не отдаём залогиненному владельцу — клиент идёт по session-cookie.
  return { survey, initialWords, creatorToken: userId ? undefined : survey.creatorToken };
};
