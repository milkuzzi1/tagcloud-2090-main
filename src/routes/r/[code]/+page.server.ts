import { error } from '@sveltejs/kit';
import { isValidCode } from '$lib/server/surveys/codes';
import { getSurveyPublic } from '$lib/server/surveys/get';
import { hasVoted } from '$lib/server/voting/rate-limit';
import { getOrCreateDeviceToken } from '$lib/server/voting/device-token';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, cookies }) => {
  const code = params.code;
  if (!isValidCode(code)) error(404, 'Опрос не найден');

  const survey = await getSurveyPublic(code);
  if (!survey) error(404, 'Опрос не найден');

  const expired = survey.status !== 'active' || new Date(survey.expiresAt).getTime() < Date.now();
  // Серверная проверка по per-device токену (через Redis) — единственный способ
  // не показывать форму ответа в другом браузере/инкогнито: localStorage на
  // клиенте про другой браузер не знает. POST-эндпоинт сам тоже проверяет по
  // тому же токену и возвращает 409 — здесь это превентивно, чтобы UI сразу
  // показал «вы уже отвечали». Токен выдаём здесь же (на просмотре формы),
  // чтобы POST переиспользовал то же значение.
  let alreadyVoted = false;
  if (!expired) {
    try {
      // Дедуп голоса привязан к per-device токену (nonce-cookie), а не к IP —
      // иначе класс за общим NAT делил бы один слот. Тот же токен использует
      // POST /answer при tryClaimVote, поэтому превью и реальный голос
      // совпадают.
      const deviceToken = getOrCreateDeviceToken(cookies);
      alreadyVoted = await hasVoted(deviceToken, code);
    } catch {
      // Redis-проблема не должна ломать сам опрос: разрешаем форму,
      // POST-эндпоинт всё равно перепроверит и вернёт 409 при дубле.
      alreadyVoted = false;
    }
  }
  return { survey, expired, alreadyVoted };
};
