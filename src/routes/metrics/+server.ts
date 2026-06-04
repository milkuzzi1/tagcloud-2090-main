import { error } from '@sveltejs/kit';
import { timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { renderMetrics } from '$lib/server/metrics';
import type { RequestHandler } from './$types';

/**
 * Prometheus scrape endpoint — fail-closed.
 *
 *   - если задан METRICS_TOKEN — требуется `Authorization: Bearer <token>`
 *     (сравнение timing-safe);
 *   - если токен НЕ задан — endpoint закрыт (404), чтобы при ошибке в ACL
 *     reverse-proxy метрики не утекли наружу. Открыть анонимно можно только
 *     явным opt-in: METRICS_ALLOW_UNAUTHENTICATED=true.
 *
 * 404 (а не 401) при отсутствии токена — чтобы не подтверждать существование
 * эндпоинта анонимному сканеру.
 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export const GET: RequestHandler = async ({ request, setHeaders }) => {
  const expected = env.METRICS_TOKEN;

  if (expected) {
    const auth = request.headers.get('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/.exec(auth);
    if (!match || !safeEqual(match[1], expected)) {
      throw error(401, 'unauthorized');
    }
  } else if (env.METRICS_ALLOW_UNAUTHENTICATED !== 'true') {
    throw error(404, 'not found');
  }

  const { contentType, body } = await renderMetrics();
  setHeaders({ 'content-type': contentType, 'cache-control': 'no-store' });
  return new Response(body);
};
