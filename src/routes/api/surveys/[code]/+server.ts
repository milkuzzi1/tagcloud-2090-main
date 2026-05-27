import { json } from '@sveltejs/kit';
import { isValidCode } from '$lib/server/surveys/codes';
import { getSurveyForCreator } from '$lib/server/surveys/get';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, url, locals }) => {
  const code = params.code!;
  const token = url.searchParams.get('t') ?? undefined;

  if (!isValidCode(code)) {
    return json({ error: { code: 'invalid_code' } }, { status: 400 });
  }

  const userId = locals.user?.id;
  if (!userId && !token) {
    return json({ error: { code: 'unauthorized' } }, { status: 401 });
  }

  const survey = await getSurveyForCreator(code, { userId, token });
  if (!survey) {
    return json({ error: { code: 'survey_not_found_or_forbidden' } }, { status: 404 });
  }
  return json(survey);
};
