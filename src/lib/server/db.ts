import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '$env/dynamic/private';
import * as schema from './schema';

const url = env.DATABASE_URL;
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

export async function pingDb(): Promise<boolean> {
  try {
    await queryClient`select 1`;
    return true;
  } catch {
    return false;
  }
}
