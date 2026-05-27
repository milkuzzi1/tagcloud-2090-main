import { error } from '@sveltejs/kit';
import { buildSurveyCsv } from '$lib/server/export/csv';
import { requireCreatorAccess } from '$lib/server/auth/access';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, url, locals }) => {
  const access = await requireCreatorAccess({
    code: params.code!,
    userId: locals.user?.id,
    token: url.searchParams.get('t')
  });
  if (!access.ok) {
    error(access.status, access.message);
  }

  const csv = await buildSurveyCsv(access.survey.id);
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="results-${access.survey.code}.csv"`,
      'Cache-Control': 'no-store'
    }
  });
};
