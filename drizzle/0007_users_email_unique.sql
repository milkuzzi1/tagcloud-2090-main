-- Restore a uniqueness guarantee on users.email.
--
-- History: 0000 had a global UNIQUE(email). 0002 recreated users with a
-- composite unique on (organization_id, email). 0003_remove_organizations
-- dropped the organization_id column, which also dropped that composite index
-- — leaving users.email with NO uniqueness at all. As a result the same email
-- could end up on multiple live rows (e.g. a 'user' row and an 'admin' row),
-- which produced duplicate accounts and a non-deterministic login.
--
-- We enforce uniqueness only among LIVE users (deleted_at IS NULL): soft-
-- deleted rows are allowed to share an email with a live row (e.g. an outgoing
-- admin that was soft-deleted during a handover, then the email reused).
--
-- NOTE: this index creation will FAIL if there are currently two or more LIVE
-- rows with the same email. Deduplicate first (keep the intended account,
-- DELETE/soft-delete the rest) and re-run the migration.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_live_unique
  ON users (email)
  WHERE deleted_at IS NULL;
