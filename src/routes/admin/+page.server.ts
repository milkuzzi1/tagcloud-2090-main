import { requireAdmin } from '$lib/server/auth/access';
import { listInvites, listMembers } from '$lib/server/auth/invites';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
  requireAdmin(locals.user);
  const [invites, members] = await Promise.all([
    listInvites(),
    listMembers()
  ]);
  return { invites, members };
};
