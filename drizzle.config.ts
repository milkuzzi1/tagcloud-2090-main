import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/lib/server/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    // Dev-only fallback for local DX (drizzle-kit generate/studio without a
    // configured .env). Never used by the app at runtime or by the migration
    // runner (scripts/migrate.ts), which both require DATABASE_URL explicitly.
    // The compose stack also fails fast without POSTGRES_PASSWORD, so this weak
    // credential can never reach a real database.
    url: process.env.DATABASE_URL ?? 'postgres://tagcloud:tagcloud_dev@localhost:5432/tagcloud'
  },
  strict: true,
  verbose: true
});
