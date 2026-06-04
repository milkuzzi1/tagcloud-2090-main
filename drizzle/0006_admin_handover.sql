-- Admin handover (Req 2): transfer of administration from the current sole
-- admin to a newly invited admin. The outgoing admin is deleted ONLY after
-- the incoming admin actually activates (sets their password), so a failed
-- email or abandoned invite can never leave the system without an admin.
--
-- A row links the freshly-created (pending) admin to the outgoing admin.
-- It is consumed (deleted) when the incoming admin sets their password.
CREATE TABLE IF NOT EXISTS pending_admin_handover (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The newly invited admin who must activate.
  incoming_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The current admin who will be removed once the incoming admin activates.
  outgoing_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- If true, hard-delete the outgoing admin's row; if false, soft-delete.
  keep_outgoing_data BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One pending handover per incoming admin.
CREATE UNIQUE INDEX IF NOT EXISTS pending_handover_incoming_idx
  ON pending_admin_handover (incoming_user_id);
