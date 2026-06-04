-- Recreate organization_invites table (removed in 0003, needed for invite-based access control)
CREATE TABLE IF NOT EXISTS organization_invites (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL,
  invited_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  note        TEXT,
  invited_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS org_invites_email_idx ON organization_invites (email);
