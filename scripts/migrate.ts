import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import postgres from 'postgres';

/**
 * Простой раннер миграций по SQL-файлам в `./drizzle/`.
 *
 * Почему свой, а не `drizzle-orm/postgres-js/migrator`:
 *   drizzle-kit пишет рядом с .sql ещё и `meta/_journal.json` со snapshot'ом
 *   схемы, который нам не нужен (мы всё равно держим источник истины в
 *   `src/lib/server/schema.ts`). Без journal штатный `migrate()` падает с
 *   `Can't find meta/_journal.json file`. Этот скрипт идёт по файлам в
 *   лексикографическом порядке, прогоняет каждый в транзакции и трекает
 *   применённые миграции в `__migrations` (хэш по содержимому файла, чтобы
 *   ловить случайную правку уже применённой миграции).
 */
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const MIGRATIONS_DIR = './drizzle';

const sql = postgres(url, { max: 1, onnotice: () => {} });

async function ensureTable(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS __migrations (
      name TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}

async function listMigrationFiles(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries.filter((f) => f.endsWith('.sql')).sort();
}

async function applied(): Promise<Map<string, string>> {
  const rows = await sql<{ name: string; hash: string }[]>`SELECT name, hash FROM __migrations`;
  return new Map(rows.map((r) => [r.name, r.hash]));
}

async function run(): Promise<void> {
  await ensureTable();
  const files = await listMigrationFiles();
  const known = await applied();

  let pending = 0;
  for (const file of files) {
    const body = await readFile(join(MIGRATIONS_DIR, file), 'utf-8');
    const hash = createHash('sha256').update(body).digest('hex');
    const prev = known.get(file);

    if (prev) {
      if (prev !== hash) {
        throw new Error(
          `migration ${file} was modified after being applied (hash mismatch). ` +
            `Migrations must be append-only — create a new file instead.`
        );
      }
      continue;
    }

    console.log(`[migrate] applying ${file}`);
    pending++;
    // drizzle-kit разделяет statement'ы маркером `--> statement-breakpoint`.
    // Дробим, чтобы каждый statement шёл отдельно — postgres.unsafe() не любит
    // составные запросы с DDL+CREATE TYPE в одном вызове.
    const statements = body
      .split(/--> statement-breakpoint/)
      .map((s) => s.trim())
      .filter(Boolean);

    await sql.begin(async (tx) => {
      for (const stmt of statements) {
        await tx.unsafe(stmt);
      }
      await tx`INSERT INTO __migrations (name, hash) VALUES (${file}, ${hash})`;
    });
  }

  console.log(pending === 0 ? '[migrate] up to date' : `[migrate] applied ${pending} migration(s)`);
}

try {
  await run();
} finally {
  await sql.end();
}
