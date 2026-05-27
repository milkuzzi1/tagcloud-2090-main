import { requireAdmin } from '$lib/server/auth/access';
import { listInvites, listMembers } from '$lib/server/auth/invites';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
  const admin = requireAdmin(locals.user);
  const [invites, members] = await Promise.all([
    listInvites(admin.organizationId),
    listMembers(admin.organizationId)
  ]);
  return {
    organizationName: admin.organizationName,
    invites,
    members,
    currentUserId: admin.id
  };
};
