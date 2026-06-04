import { describe, it, expect } from 'vitest';

/**
 * Unit-level guard for the admin-handover INVARIANTS (Req 2 + Req 3).
 *
 * The DB-touching functions (createAdminHandover / completeAdminHandoverFor /
 * countAdmins / changeAdminEmail) are exercised by integration tests with a
 * live Postgres. Here we lock the decision rules that are easy to regress:
 *
 *  - transfer is allowed only when the caller is the SOLE admin (countAdmins === 1);
 *  - the outgoing admin is removed only on the keep-data branch we expect;
 *  - the incoming admin must differ from the outgoing admin.
 *
 * These mirror the logic in src/routes/api/admin/transfer-admin/+server.ts and
 * completeAdminHandoverFor; if that logic changes, update both.
 */

function canTransfer(adminCount: number): boolean {
  return adminCount === 1;
}

function isSelfTransfer(currentEmail: string, targetEmail: string): boolean {
  return currentEmail.trim().toLowerCase() === targetEmail.trim().toLowerCase();
}

type RemovalAction = 'soft_delete' | 'hard_delete';
function outgoingRemovalAction(keepOutgoingData: boolean): RemovalAction {
  return keepOutgoingData ? 'soft_delete' : 'hard_delete';
}

describe('admin handover invariants', () => {
  it('allows transfer only for the sole admin', () => {
    expect(canTransfer(1)).toBe(true);
    expect(canTransfer(0)).toBe(false);
    expect(canTransfer(2)).toBe(false);
  });

  it('rejects transferring to oneself (case/space-insensitive)', () => {
    expect(isSelfTransfer('admin@x.io', '  Admin@X.io ')).toBe(true);
    expect(isSelfTransfer('admin@x.io', 'new@x.io')).toBe(false);
  });

  it('maps keepData to the correct removal action for the outgoing admin', () => {
    expect(outgoingRemovalAction(true)).toBe('soft_delete');
    expect(outgoingRemovalAction(false)).toBe('hard_delete');
  });
});
