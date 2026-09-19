import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { gatewayConfigSchema } from '../src/config/schema.js';
import { buildTestApp, startUpstream, type TestUpstream } from './helpers.js';

let app: FastifyInstance | undefined;
let upstream: TestUpstream | undefined;

afterEach(async () => {
  await app?.close();
  await upstream?.close();
  app = undefined;
  upstream = undefined;
});

async function gateway(rateLimit: Record<string, unknown>): Promise<FastifyInstance> {
  upstream = await startUpstream();
  app = await buildTestApp([{ id: 'r', match: { path: '/api/*' }, upstream: { targets: [upstream.url] }, rateLimit }]);
  return app;
}

const configWith = (rateLimit: Record<string, unknown>) =>
  gatewayConfigSchema.safeParse({
    routes: [{ id: 'r', match: { path: '/*' }, upstream: { targets: ['http://upstream'] }, rateLimit }],
  });

describe('config: rateLimit.global', () => {
  it('rejects a route with keyBy: [global] and no global policy', () => {
    expect(configWith({ keyBy: ['global'], limit: 100, windowSec: 60 }).success).toBe(false);
  });

  it('accepts keyBy: [global] once a global policy is set', () => {
    const result = configWith({ keyBy: ['global'], limit: 100, windowSec: 60, global: { limit: 5, windowSec: 60 } });

    expect(result.success).toBe(true);
  });
});

describe('global rate-limit key — real request pipeline', () => {
  it('caps total traffic across the route regardless of which client is asking', async () => {
    const gw = await gateway({
      algorithm: 'slidingWindowLog',
      keyBy: ['ip', 'global'],
      limit: 100, // per-IP: generous, never the bottleneck in this test
      windowSec: 60,
      global: { limit: 2, windowSec: 60 }, // shared cap: only 2 requests total, from anyone
    });

    // Three different "clients" (distinct source IPs) hit the same route.
    // A per-IP-only limiter would let all three through (each is its own
    // bucket) — the global key is what caps the *route's* total traffic.
    const first = await gw.inject({ method: 'GET', url: '/api/hello', remoteAddress: '10.0.0.1' });
    const second = await gw.inject({ method: 'GET', url: '/api/hello', remoteAddress: '10.0.0.2' });
    const third = await gw.inject({ method: 'GET', url: '/api/hello', remoteAddress: '10.0.0.3' });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);
    expect(third.json()).toMatchObject({ error: 'rate_limit_exceeded' });
  });

  it('keeps a per-IP limit working normally when global is not in keyBy', async () => {
    const gw = await gateway({ algorithm: 'slidingWindowLog', keyBy: ['ip'], limit: 1, windowSec: 60 });

    const allowed = await gw.inject({ method: 'GET', url: '/api/hello', remoteAddress: '10.0.0.1' });
    const blocked = await gw.inject({ method: 'GET', url: '/api/hello', remoteAddress: '10.0.0.1' });
    const otherIp = await gw.inject({ method: 'GET', url: '/api/hello', remoteAddress: '10.0.0.2' });

    expect(allowed.statusCode).toBe(200);
    expect(blocked.statusCode).toBe(429);
    expect(otherIp.statusCode).toBe(200); // untouched — no global key, so IPs are fully independent
  });
});
