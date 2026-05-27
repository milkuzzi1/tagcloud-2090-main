import { json } from '@sveltejs/kit';
import { CreateSurveySchema } from '$lib/server/surveys/validation';
import { createSurvey } from '$lib/server/surveys/create';
import { qrPngBase64 } from '$lib/server/qr/generate';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, url, locals }) => {
  if (!locals.user) {
    return json(
      { error: { code: 'unauthorized', message: 'Войдите, чтобы создать опрос' } },
      { status: 401 }
    );
  }

  const raw = await request.json().catch(() => null);
  const parsed = CreateSurveySchema.safeParse(raw);
  if (!parsed.success) {
    return json({ error: { code: 'invalid_input', issues: parsed.error.issues } }, { status: 400 });
  }

  const result = await createSurvey(parsed.data, {
    userId: locals.user.id,
    email: locals.user.email
  });
  const baseUrl = env.PUBLIC_BASE_URL || url.origin;
  const respondentUrl = `${baseUrl}/r/${result.code}`;
  const dashboardUrl = `${baseUrl}/s/${result.code}`;
  const qr = await qrPngBase64(respondentUrl);

  return json(
    {
      code: result.code,
      url: respondentUrl,
      dashboardUrl,
      qrPngBase64: qr,
      expiresAt: result.expiresAt
    },
    { status: 201 }
  );
};
