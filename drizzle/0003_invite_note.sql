-- NOTE: shares the 0003 prefix with 0003_remove_organizations.sql.
-- The migration runner (scripts/migrate.ts) applies files in
-- lexicographic order and tracks them BY FILENAME, so these files must
-- NOT be renamed once applied. 'invite_note' sorts before
-- 'remove_organizations', which is required: this ADD COLUMN must run
-- before that file DROPs the organization_invites table. Do not add a
-- 0003_* file that would sort between them.
ALTER TABLE "organization_invites" ADD COLUMN "note" text;
