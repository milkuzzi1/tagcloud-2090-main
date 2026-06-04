import { requireAdmin } from '$lib/server/auth/access';
import { listMembers, countAdmins } from '$lib/server/auth/invites';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
  const admin = requireAdmin(locals.user);
  const [members, adminCount] = await Promise.all([listMembers(), countAdmins()]);
  return {
    members,
    adminCount,
    currentUserId: admin.id,
    currentUserEmail: admin.email
  };
};
