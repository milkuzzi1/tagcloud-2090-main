import { error } from '@sveltejs/kit';
import { isValidCode } from '$lib/server/surveys/codes';
import { getSurveyPublic } from '$lib/server/surveys/get';
import { hasVoted } from '$lib/server/voting/rate-limit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, getClientAddress }) => {
  const code = params.code;
  if (!isValidCode(code)) error(404, 'Опрос не найден');

  const survey = await getSurveyPublic(code);
  if (!survey) error(404, 'Опрос не найден');

  const expired = survey.status !== 'active' || new Date(survey.expiresAt).getTime() < Date.now();
  // Серверная проверка по IP (через Redis) — единственный способ не
  // показывать форму ответа в другом браузере/инкогнито: localStorage
  // на клиенте про другой браузер не знает. POST-эндпоинт сам тоже
  // проверяет hasVoted и возвращает 409 — здесь это превентивно, чтобы
  // UI сразу показал «вы уже отвечали».
  let alreadyVoted = false;
  if (!expired) {
    try {
      alreadyVoted = await hasVoted(getClientAddress(), code);
    } catch {
      // Redis-проблема не должна ломать сам опрос: разрешаем форму,
      // POST-эндпоинт всё равно перепроверит и вернёт 409 при дубле.
      alreadyVoted = false;
    }
  }
  return { survey, expired, alreadyVoted };
};
