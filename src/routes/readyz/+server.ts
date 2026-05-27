import { json } from '@sveltejs/kit';
import { pingDb } from '$lib/server/db';
import { pingRedis } from '$lib/server/redis';
import type { RequestHandler } from './$types';

/**
 * Readiness-проба: 200 — процесс готов обслуживать запросы, 503 — нет.
 * Reverse-proxy (Caddy/nginx) использует это, чтобы во время рестарта
 * не маршрутизировать трафик на ещё не прогретый инстанс.
 *
 * Прогон параллельно — общий таймаут ~3с (см. connectTimeout в redis.ts
 * и connect_timeout в db.ts).
 */
export const GET: RequestHandler = async ({ setHeaders }) => {
  setHeaders({ 'cache-control': 'no-store' });
  const [db, redis] = await Promise.all([pingDb(), pingRedis()]);
  const ok = db && redis;
  return json({ ok, db, redis }, { status: ok ? 200 : 503 });
};
