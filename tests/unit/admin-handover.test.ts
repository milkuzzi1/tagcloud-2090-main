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

// Variant (A): an incoming person who already has a password can sign in
// immediately, so the handover completes now; otherwise it is deferred until
// they set a password via the emailed link. Mirrors transfer-admin/+server.ts.
function handoverCompletesImmediately(incomingHasPassword: boolean): boolean {
  return incomingHasPassword;
}

// Deterministic login ordering: prefer an admin row, then earliest created.
// Mirrors the ORDER BY in service.login / promoteOrCreateAdmin.
function pickLoginRow(
  rows: { role: 'admin' | 'user'; createdAt: number }[]
): { role: 'admin' | 'user'; createdAt: number } | undefined {
  return [...rows].sort((a, b) => {
    const ra = a.role === 'admin' ? 0 : 1;
    const rb = b.role === 'admin' ? 0 : 1;
    if (ra !== rb) return ra - rb;
    return a.createdAt - b.createdAt;
  })[0];
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

  it('completes immediately only when the incoming person already has a password', () => {
    expect(handoverCompletesImmediately(true)).toBe(true);
    expect(handoverCompletesImmediately(false)).toBe(false);
  });

  it('login prefers a live admin row over a user row with the same email', () => {
    const picked = pickLoginRow([
      { role: 'user', createdAt: 100 },
      { role: 'admin', createdAt: 200 }
    ]);
    expect(picked).toEqual({ role: 'admin', createdAt: 200 });
  });

  it('login falls back to earliest row when no admin exists', () => {
    const picked = pickLoginRow([
      { role: 'user', createdAt: 300 },
      { role: 'user', createdAt: 150 }
    ]);
    expect(picked).toEqual({ role: 'user', createdAt: 150 });
  });
});
