import { requireAdmin } from '$lib/server/auth/access';
import { listMembers } from '$lib/server/auth/invites';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
  requireAdmin(locals.user);
  const members = await listMembers();
  return { members, currentUserId: locals.user!.id };
};
