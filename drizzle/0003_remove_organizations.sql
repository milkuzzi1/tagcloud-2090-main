-- Drop organization tables and remove org_id FK from users
-- Run this migration after deploying the code changes

-- 1. Drop FK constraint and column from users
ALTER TABLE users DROP COLUMN IF EXISTS organization_id;

-- 2. Drop organization_invites table (depends on organizations)
DROP TABLE IF EXISTS organization_invites;

-- 3. Drop organizations table
DROP TABLE IF EXISTS organizations;
