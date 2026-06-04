import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
  if (locals.user) redirect(303, '/my');
  const email = url.searchParams.get('email') ?? '';
  // Without an invite link (email param) registration is not allowed
  if (!email) redirect(303, '/login');
  return { initialEmail: email };
};
