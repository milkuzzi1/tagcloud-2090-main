import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { renderMetrics } from '$lib/server/metrics';
import type { RequestHandler } from './$types';

/**
 * Prometheus scrape endpoint.
 *
 * Доступ ограничивается настройками reverse-proxy (Caddy) — публиковать
 * наружу нельзя, т.к. метрики раскрывают кардинальные внутренности
 * (количество запросов, латентности, счётчики голосов).
 *
 * На уровне приложения дополнительно поддерживаем shared-secret через
 * заголовок `Authorization: Bearer <METRICS_TOKEN>` — на случай, если
 * Caddy сконфигурирован неправильно или /metrics утечёт за пределы LAN.
 * Если METRICS_TOKEN не задан — endpoint открыт (рассчитываем на ACL прокси).
 */
export const GET: RequestHandler = async ({ request, setHeaders }) => {
  const expected = env.METRICS_TOKEN;
  if (expected) {
    const auth = request.headers.get('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/.exec(auth);
    if (!match || match[1] !== expected) {
      throw error(401, 'unauthorized');
    }
  }

  const { contentType, body } = await renderMetrics();
  setHeaders({ 'content-type': contentType, 'cache-control': 'no-store' });
  return new Response(body);
};
