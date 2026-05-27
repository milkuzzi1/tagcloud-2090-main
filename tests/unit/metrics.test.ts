import { describe, it, expect, beforeEach } from 'vitest';
import client from 'prom-client';
import {
  observeHttpRequest,
  incVotesAccepted,
  incVotesFlushed,
  setVotesPending,
  incWsConnected,
  decWsConnected,
  observeRenderDuration,
  renderMetrics
} from '../../src/lib/server/metrics';

describe('metrics', () => {
  // Метрики глобальны; перед каждым тестом сбрасываем счётчики, чтобы
  // тесты не зависели друг от друга (порядок исполнения у vitest
  // непредсказуем).
  beforeEach(() => {
    client.register.resetMetrics();
  });

  it('renderMetrics возвращает Prometheus-формат и включает наши метрики', async () => {
    incVotesAccepted(5);
    observeHttpRequest({ method: 'GET', route: '/api/x', status: 200, durationSec: 0.1 });

    const { contentType, body } = await renderMetrics();
    expect(contentType).toMatch(/text\/plain/);
    expect(body).toContain('tagcloud_votes_accepted_total 5');
    expect(body).toContain('tagcloud_http_request_duration_seconds');
  });

  it('incVotesFlushed различает outcome=ok и outcome=failed', async () => {
    incVotesFlushed(3, 'ok');
    incVotesFlushed(2, 'failed');
    const { body } = await renderMetrics();
    expect(body).toContain('tagcloud_votes_flushed_total{outcome="ok"} 3');
    expect(body).toContain('tagcloud_votes_flushed_total{outcome="failed"} 2');
  });

  it('setVotesPending перезаписывает (gauge), а не аккумулирует', async () => {
    setVotesPending(10);
    setVotesPending(5);
    const { body } = await renderMetrics();
    expect(body).toContain('tagcloud_votes_pending 5');
  });

  it('incWsConnected/decWsConnected ведёт счётчик подключений', async () => {
    incWsConnected();
    incWsConnected();
    incWsConnected();
    decWsConnected();
    const { body } = await renderMetrics();
    expect(body).toContain('tagcloud_ws_connected 2');
  });

  it('observeRenderDuration пишет в histogram', async () => {
    observeRenderDuration(0.25);
    observeRenderDuration(1.5);
    const { body } = await renderMetrics();
    // Histogram создаёт серию tagcloud_render_duration_seconds_bucket{le="..."}.
    expect(body).toContain('tagcloud_render_duration_seconds_bucket');
    expect(body).toContain('tagcloud_render_duration_seconds_count 2');
  });

  it('http_request_duration учитывает labels method/route/status', async () => {
    observeHttpRequest({ method: 'POST', route: '/api/login', status: 401, durationSec: 0.05 });
    observeHttpRequest({ method: 'POST', route: '/api/login', status: 200, durationSec: 0.05 });
    const { body } = await renderMetrics();
    expect(body).toContain('method="POST"');
    expect(body).toContain('route="/api/login"');
    expect(body).toContain('status="200"');
    expect(body).toContain('status="401"');
  });
});
