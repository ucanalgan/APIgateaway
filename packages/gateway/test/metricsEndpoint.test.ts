import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, deadUrl, startUpstream, type TestUpstream } from './helpers.js';

let app: FastifyInstance | undefined;
let up: TestUpstream | undefined;

afterEach(async () => {
  await app?.close();
  await up?.close();
  app = undefined;
  up = undefined;
});

describe('GET /metrics', () => {
  it('exposes every documented metric, labelled by route, after real traffic', async () => {
    up = await startUpstream();
    app = await buildTestApp([
      {
        id: 'shop',
        match: { path: '/shop/*' },
        upstream: { targets: [up.url, await deadUrl()] },
        rateLimit: { algorithm: 'fixedWindow', keyBy: ['ip'], limit: 2, windowSec: 60 },
        cache: { enabled: true, ttlSec: 60 },
        circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 60_000 },
      },
    ]);

    await app.inject({ method: 'GET', url: '/shop/a' }); // allowed, cache MISS
    await app.inject({ method: 'GET', url: '/shop/a' }); // allowed, cache HIT
    await app.inject({ method: 'GET', url: '/shop/a' }); // blocked (limit 2)
    await app.inject({ method: 'GET', url: '/nowhere' }); // no route

    const res = await app.inject({ method: 'GET', url: '/metrics' });
    const body = res.body;

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(body).toMatch(/apigate_requests_total\{[^}]*route="shop"[^}]*status="200"/);
    expect(body).toMatch(/apigate_requests_total\{[^}]*route="shop"[^}]*status="429"/);
    expect(body).toMatch(/apigate_requests_total\{[^}]*route="unmatched"[^}]*status="404"/);
    expect(body).toContain('apigate_request_duration_seconds_bucket');
    expect(body).toContain('apigate_ratelimit_decisions_total{route="shop",decision="allowed"} 2');
    expect(body).toContain('apigate_ratelimit_decisions_total{route="shop",decision="blocked"} 1');
    expect(body).toContain('apigate_cache_total{route="shop",result="miss"} 1');
    expect(body).toContain('apigate_cache_total{route="shop",result="hit"} 1');
    expect(body).toContain('apigate_circuit_state{route="shop"} 0');
    expect(body).toContain(`apigate_upstream_healthy{route="shop",target="${up.url}"} 1`);
    expect(body).toContain('apigate_redis_latency_seconds');
  });

  it('counts upstream failures by type', async () => {
    app = await buildTestApp([{ id: 'r', match: { path: '/*' }, upstream: { targets: [await deadUrl()] } }]);

    await app.inject({ method: 'GET', url: '/x' });
    const body = (await app.inject({ method: 'GET', url: '/metrics' })).body;

    expect(body).toContain('apigate_upstream_errors_total{route="r",type="connection"} 1');
  });

  it('reports a tripped circuit as state 1', async () => {
    app = await buildTestApp([
      {
        id: 'r',
        match: { path: '/*' },
        upstream: { targets: [await deadUrl()] },
        circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 60_000 },
      },
    ]);

    await app.inject({ method: 'GET', url: '/x' });
    await app.inject({ method: 'GET', url: '/x' }); // 503 — no healthy target
    const body = (await app.inject({ method: 'GET', url: '/metrics' })).body;

    expect(body).toContain('apigate_upstream_errors_total{route="r",type="no_healthy_target"} 1');
    expect(body).toContain('apigate_circuit_state{route="r"} 1');
  });

  it('counts a timed-out upstream separately', async () => {
    up = await startUpstream(() => {
      /* never responds */
    });
    app = await buildTestApp([{ id: 'r', match: { path: '/*' }, upstream: { targets: [up.url], timeoutMs: 100 } }]);

    await app.inject({ method: 'GET', url: '/x' });
    const body = (await app.inject({ method: 'GET', url: '/metrics' })).body;

    expect(body).toContain('apigate_upstream_errors_total{route="r",type="timeout"} 1');
  });
});
