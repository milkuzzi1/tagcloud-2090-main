import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
  if (locals.user) {
    const next = url.searchParams.get('next') || '/my';
    redirect(303, next);
  }
  return {};
};
