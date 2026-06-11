import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { building } from '$app/environment';
import { env } from '$env/dynamic/private';
import * as schema from './schema';

// Во время `vite build` SvelteKit импортирует серверные модули для анализа
// (prerender/analyse), когда реальных env ещё нет. Подставляем заглушку —
// postgres-js подключается лениво, соединение не открывается.
const url = building ? 'postgres://build:build@localhost:5432/build' : env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

// Размер пула — настраивается из env под целевую нагрузку. Под 1000
// concurrent на 4 инстанса разумный диапазон 15-25 (4 × 20 = 80 коннектов
// при дефолтном postgres `max_connections=100`). Выше — упрёмся в лимит
// postgres; ниже — будем зря очередить запросы при пиках голосования.
const poolMax = Math.max(1, Number(env.PG_POOL_MAX ?? 20));
const idleTimeoutSec = Math.max(0, Number(env.PG_IDLE_TIMEOUT_SEC ?? 20));
const connectTimeoutSec = Math.max(1, Number(env.PG_CONNECT_TIMEOUT_SEC ?? 5));

const queryClient = postgres(url, {
  max: poolMax,
  idle_timeout: idleTimeoutSec,
  connect_timeout: connectTimeoutSec,
  onnotice: () => {}
});

export const db = drizzle(queryClient, { schema });
export { schema };

// Исполнитель запросов: либо пул (`db`), либо транзакция (`tx`). Функции,
// которые должны уметь работать и автономно, и внутри транзакции, принимают
// этот тип параметром (дефолт — `db`).
export type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function pingDb(): Promise<boolean> {
  try {
    await queryClient`select 1`;
    return true;
  } catch {
    return false;
  }
}

/**
 * Закрывает пул соединений Postgres. Вызывается на graceful shutdown
 * (см. hooks.server.ts), чтобы не оставлять висящие коннекты при остановке
 * контейнера/сервиса. `{ timeout: 5 }` — даём активным запросам до 5с.
 */
export async function closeDb(): Promise<void> {
  await queryClient.end({ timeout: 5 });
}
