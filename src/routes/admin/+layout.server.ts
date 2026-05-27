import { redirect } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth/access';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
  if (!locals.user) {
    redirect(303, '/login');
  }
  // requireAdmin кидает error(403) если не админ — для UX лучше показать 403,
  // чем редиректить, потому что пользователь явно знает, что зашёл сюда.
  requireAdmin(locals.user);
  return {};
};
