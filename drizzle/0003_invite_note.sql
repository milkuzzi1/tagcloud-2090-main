-- ADD COLUMN IF NOT EXISTS: на БД, где organization_invites была пересоздана
-- в 0005 (уже с колонкой note), повторное применение этой миграции не должно
-- падать «column already exists». См. также дубль префикса 0003 (исторический).
ALTER TABLE "organization_invites" ADD COLUMN IF NOT EXISTS "note" text;
