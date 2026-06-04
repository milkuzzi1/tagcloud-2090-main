import { requireAdmin } from '$lib/server/auth/access';
import { listMembers, listInvites, countAdmins } from '$lib/server/auth/invites';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
  const admin = requireAdmin(locals.user);
  const [members, invites, adminCount] = await Promise.all([
    listMembers(),
    listInvites(),
    countAdmins()
  ]);
  return {
    members,
    invites,
    adminCount,
    currentUserId: admin.id,
    currentUserEmail: admin.email
  };
};
