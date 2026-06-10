import { json } from '@sveltejs/kit';
import { isValidCode } from '$lib/server/surveys/codes';
import { SubmitAnswersSchema } from '$lib/server/voting/validation';
import { validateSubmission } from '$lib/server/voting/validate';
import { submitAnswers } from '$lib/server/voting/submit';
import { checkRateLimit, releaseVote, tryClaimVote } from '$lib/server/voting/rate-limit';
import { log } from '$lib/server/log';
import type { RequestHandler } from './$types';

function statusForError(code: string): number {
  switch (code) {
    case 'survey_not_found':
    case 'question_not_found':
      return 404;
    case 'survey_expired':
      return 410;
    default:
      return 400;
  }
}

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const code = params.code!;
  if (!isValidCode(code)) {
    return json(
      { error: { code: 'invalid_code', message: 'Некорректный код опроса' } },
      { status: 400 }
    );
  }

  const ip = locals.clientIp;

  // Rate-limit ПЕРЕД любой обработкой — иначе флуд невалидным мусором не лимитируется.
  // Redis — обязательная зависимость голосования: при его падении checkRateLimit
  // бросает, и без обёртки эндпоинт отдавал бы 500. Деградируем явно в 503
  // Retry-After (fail-closed), чтобы клиент понял «временно недоступно».
  let rl;
  try {
    rl = await checkRateLimit(ip);
  } catch (err) {
    log.error('rate_limit_redis_unavailable', { code, err: String(err) });
    return json(
      {
        error: {
          code: 'overloaded',
          message: 'Сервис временно недоступен, попробуйте через несколько секунд'
        }
      },
      { status: 503, headers: { 'Retry-After': '10' } }
    );
  }
  if (!rl.allowed) {
    return json(
      {
        error: {
          code: 'rate_limit',
          retryAfterSec: rl.retryAfterSec,
          message: `Слишком много запросов, подождите ${rl.retryAfterSec}с`
        }
      },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
    );
  }

  const raw = await request.json().catch(() => null);
  const parsed = SubmitAnswersSchema.safeParse(raw);
  if (!parsed.success) {
    return json({ error: { code: 'invalid_input', issues: parsed.error.issues } }, { status: 400 });
  }

  const v = await validateSubmission(code, parsed.data.answers);
  if (!v.ok) {
    return json({ error: v.error }, { status: statusForError(v.error.code) });
  }

  // Атомарный SET NX: одной командой проверяем «не голосовал ли этот IP» и
  // занимаем слот. Раньше `hasVoted` + `markVoted` шли двумя командами — два
  // параллельных запроса с одного IP проходили проверку и оба отправлялись в
  // submitAnswers. Если SET NX вернул false — слот уже занят (повторный голос).
  let claimed = true;
  try {
    claimed = await tryClaimVote(ip, code, v.survey.expiresAt);
  } catch (err) {
    // Redis недоступен: вместо 500 на всём эндпоинте — деградируем мягко.
    // Голос важнее идемпотентности на короткое окно недоступности Redis,
    // поэтому принимаем ответ без дедупликации (возможен дубль за время
    // даунтайма Redis). Дедуп восстановится, когда Redis вернётся.
    log.error('vote_claim_redis_unavailable', { code, err: String(err) });
  }
  if (!claimed) {
    return json(
      { error: { code: 'already_voted', message: 'Вы уже отправили ответы на этот опрос' } },
      { status: 409 }
    );
  }

  const submit = await submitAnswers(v.processed);
  if (!submit.ok) {
    // Buffer переполнен — БД/Redis в недоступности, дренаж не успевает.
    // Освобождаем уже занятый слот, чтобы клиент мог ретрайнуть; иначе
    // следующий запрос упёрся бы в 409 «уже голосовали». releaseVote сам
    // ходит в Redis — если он лёг, не роняем 500, а просто логируем: слот
    // отпустится по TTL.
    try {
      await releaseVote(ip, code);
    } catch (err) {
      log.error('vote_release_failed', { code, err: String(err) });
    }
    return json(
      {
        error: {
          code: 'overloaded',
          message: 'Сервис временно перегружен, попробуйте через несколько секунд'
        }
      },
      { status: 503, headers: { 'Retry-After': '5' } }
    );
  }

  return json({ ok: true, accepted: submit.accepted }, { status: 201 });
};
