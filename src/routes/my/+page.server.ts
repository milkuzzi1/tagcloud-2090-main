import { redirect } from '@sveltejs/kit';
import { listUserSurveys } from '$lib/server/surveys/get';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) {
    redirect(303, '/login?next=/my');
  }
  const surveys = await listUserSurveys(locals.user.id);
  return { surveys };
};
