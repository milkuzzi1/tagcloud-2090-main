import client from 'prom-client';

/**
 * Prometheus-метрики. Подцепляются Caddy/Prom через GET /metrics.
 *
 * Базовый `default-registry` собирает CPU/heap/event-loop процесса —
 * `collectDefaultMetrics` включает их сам. Свои бизнес-метрики
 * регистрируются ниже.
 */

// Идемпотентность: при HMR-перезагрузке в dev модуль может импортироваться
// дважды; prom-client тогда падает на регистрации одноимённых метрик.
const g = globalThis as unknown as { __tagcloud_metrics_initialized?: boolean };

const registry = client.register;

if (!g.__tagcloud_metrics_initialized) {
  g.__tagcloud_metrics_initialized = true;
  client.collectDefaultMetrics({ register: registry, prefix: 'tagcloud_' });
}

/**
 * Histogram длительности HTTP-запросов в секундах. Ярлыки даём минимально
 * (method/route/status), чтобы кардинальность не взорвалась — `route` берётся
 * из event.route.id (шаблон), а не из URL.
 */
const httpDurationSeconds = getOrCreate<client.Histogram<string>>(
  'tagcloud_http_request_duration_seconds',
  () =>
    new client.Histogram({
      name: 'tagcloud_http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'route', 'status'],
      // По SLO-у: p50 ~50ms, p95 ~250ms, p99 ~1s — buckets в районе.
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [registry]
    })
);

const votesAcceptedTotal = getOrCreate<client.Counter<string>>(
  'tagcloud_votes_accepted_total',
  () =>
    new client.Counter({
      name: 'tagcloud_votes_accepted_total',
      help: 'Number of vote answers accepted into the queue',
      registers: [registry]
    })
);

const votesFlushedTotal = getOrCreate<client.Counter<string>>(
  'tagcloud_votes_flushed_total',
  () =>
    new client.Counter({
      name: 'tagcloud_votes_flushed_total',
      help: 'Number of vote answers persisted to Postgres',
      labelNames: ['outcome'],
      registers: [registry]
    })
);

const votesPendingGauge = getOrCreate<client.Gauge<string>>(
  'tagcloud_votes_pending',
  () =>
    new client.Gauge({
      name: 'tagcloud_votes_pending',
      help: 'Pending votes in in-memory buffer (not yet flushed)',
      registers: [registry]
    })
);

const wsConnectedGauge = getOrCreate<client.Gauge<string>>(
  'tagcloud_ws_connected',
  () =>
    new client.Gauge({
      name: 'tagcloud_ws_connected',
      help: 'Currently connected WebSocket subscribers',
      registers: [registry]
    })
);

const renderDurationSeconds = getOrCreate<client.Histogram<string>>(
  'tagcloud_render_duration_seconds',
  () =>
    new client.Histogram({
      name: 'tagcloud_render_duration_seconds',
      help: 'PNG render duration (worker thread offload) in seconds',
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [registry]
    })
);

function getOrCreate<T extends client.Metric<string>>(name: string, factory: () => T): T {
  // При повторном импорте модуля (HMR) уже зарегистрированную метрику
  // нужно переиспользовать — иначе prom-client бросит "already a metric…".
  const existing = registry.getSingleMetric(name);
  if (existing) return existing as T;
  return factory();
}

export function observeHttpRequest(p: {
  method: string;
  route: string;
  status: number;
  durationSec: number;
}): void {
  httpDurationSeconds.labels(p.method, p.route, String(p.status)).observe(p.durationSec);
}

export function incVotesAccepted(n: number): void {
  votesAcceptedTotal.inc(n);
}

export function incVotesFlushed(n: number, outcome: 'ok' | 'failed'): void {
  votesFlushedTotal.labels(outcome).inc(n);
}

export function setVotesPending(n: number): void {
  votesPendingGauge.set(n);
}

export function incWsConnected(): void {
  wsConnectedGauge.inc();
}

export function decWsConnected(n: number = 1): void {
  if (n <= 0) return;
  wsConnectedGauge.dec(n);
}

export function observeRenderDuration(durationSec: number): void {
  renderDurationSeconds.observe(durationSec);
}

/**
 * Возвращает текстовое представление всех метрик (формат Prometheus 0.0.4).
 * Используется в /metrics endpoint.
 */
export async function renderMetrics(): Promise<{ contentType: string; body: string }> {
  return { contentType: registry.contentType, body: await registry.metrics() };
}
