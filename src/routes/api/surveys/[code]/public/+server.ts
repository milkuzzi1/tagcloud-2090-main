import { json } from '@sveltejs/kit';
import { isValidCode } from '$lib/server/surveys/codes';
import { getSurveyPublic } from '$lib/server/surveys/get';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
  const code = params.code!;
  if (!isValidCode(code)) {
    return json({ error: { code: 'invalid_code' } }, { status: 400 });
  }
  const survey = await getSurveyPublic(code);
  if (!survey) {
    return json({ error: { code: 'survey_not_found' } }, { status: 404 });
  }
  return json(survey);
};
