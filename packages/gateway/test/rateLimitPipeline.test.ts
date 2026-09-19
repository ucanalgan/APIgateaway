import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { REDIS_URL, buildTestApp, deadUrl, redisReachable, startUpstream, type TestUpstream } from './helpers.js';

const apps: FastifyInstance[] = [];
const upstreams: TestUpstream[] = [];

async function upstream(): Promise<TestUpstream> {
  const u = await startUpstream();
  upstreams.push(u);
  return u;
}

async function app(routes: unknown[], extra: Record<string, unknown> = {}): Promise<FastifyInstance> {
  const a = await buildTestApp(routes, extra);
  apps.push(a);
  return a;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
  await Promise.all(upstreams.splice(0).map((u) => u.close()));
});

const limited = (target: string, rateLimit: Record<string, unknown>, id = 'r') => ({
  id,
  match: { path: '/*' },
  upstream: { targets: [target] },
  rateLimit,
});

describe('rate-limit response contract', () => {
  it('sets RateLimit-* on allowed requests, and Retry-After + the 429 body once exceeded', async () => {
    const up = await upstream();
    const gw = await app([limited(up.url, { algorithm: 'slidingWindowLog', keyBy: ['ip'], limit: 2, windowSec: 60 })]);

    const first = await gw.inject({ method: 'GET', url: '/x' });
    await gw.inject({ method: 'GET', url: '/x' });
    const blocked = await gw.inject({ method: 'GET', url: '/x' });

    expect(first.headers['ratelimit-limit']).toBe('2');
    expect(first.headers['ratelimit-remaining']).toBe('1');
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.json()).toMatchObject({
      error: 'rate_limit_exceeded',
      retryAfter: Number(blocked.headers['retry-after']),
      requestId: blocked.headers['x-request-id'],
    });
    expect(up.requests).toHaveLength(2); // the blocked one never reached the upstream
  });

  it('skips a tenant key on an anonymous route instead of failing closed', async () => {
    const up = await upstream();
    const gw = await app([limited(up.url, { algorithm: 'slidingWindowLog', keyBy: ['tenant'], limit: 1, windowSec: 60 })]);

    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await gw.inject({ method: 'GET', url: '/x' })).statusCode);

    expect(statuses).toEqual([200, 200, 200]);
  });
});

describe('Redis unreachable (real dead port, not a mock)', () => {
  const DEAD_REDIS = 'redis://127.0.0.1:1';

  it('failOpen: true — the request goes through instead of the limiter causing an outage', async () => {
    const up = await upstream();
    const gw = await app(
      [limited(up.url, { algorithm: 'slidingWindowLog', keyBy: ['ip'], limit: 1, windowSec: 60 })],
      { redis: { url: DEAD_REDIS, failOpen: true } },
    );

    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await gw.inject({ method: 'GET', url: '/x' })).statusCode);

    expect(statuses).toEqual([200, 200, 200]); // limit is 1, yet nothing is enforced while the store is down
    expect(up.requests).toHaveLength(3);
  });

  it('failOpen: false — answers 503 rate_limit_unavailable and never reaches the upstream', async () => {
    const up = await upstream();
    const gw = await app(
      [limited(up.url, { algorithm: 'slidingWindowLog', keyBy: ['ip'], limit: 1, windowSec: 60 })],
      { redis: { url: DEAD_REDIS, failOpen: false } },
    );

    const res = await gw.inject({ method: 'GET', url: '/x' });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'rate_limit_unavailable' });
    expect(up.requests).toHaveLength(0);
  });

  it('still shuts down cleanly with Redis down (no hang, no throw)', async () => {
    const up = await upstream();
    const gw = await buildTestApp(
      [limited(up.url, { algorithm: 'slidingWindowLog', keyBy: ['ip'], limit: 1, windowSec: 60 })],
      { redis: { url: DEAD_REDIS } },
    );

    await expect(gw.close()).resolves.toBeUndefined();
  });

  it('an unreachable target still fails fast when the limiter is healthy', async () => {
    const gw = await app([limited(await deadUrl(), { algorithm: 'slidingWindowLog', keyBy: ['ip'], limit: 5, windowSec: 60 })]);

    expect((await gw.inject({ method: 'GET', url: '/x' })).statusCode).toBe(502);
  });
});

const redisAvailable = await redisReachable();

describe.skipIf(!redisAvailable)('distributed limits through real Redis', () => {
  it('two gateway instances share ONE quota — 10 concurrent requests, limit 3, exactly 3 pass', async () => {
    const up = await upstream();
    const route = limited(up.url, { algorithm: 'tokenBucket', keyBy: ['ip'], limit: 3, windowSec: 60 }, `shared-${randomUUID()}`);
    const gatewayA = await app([route], { redis: { url: REDIS_URL } });
    const gatewayB = await app([route], { redis: { url: REDIS_URL } });

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? gatewayA : gatewayB).inject({ method: 'GET', url: '/x' })),
    );

    const allowed = responses.filter((r) => r.statusCode === 200).length;
    const blocked = responses.filter((r) => r.statusCode === 429).length;
    expect(allowed).toBe(3);
    expect(blocked).toBe(7);
    expect(up.requests).toHaveLength(3);
  });

  it('a global key is shared across instances too — capped regardless of caller', async () => {
    const up = await upstream();
    const route = limited(
      up.url,
      { algorithm: 'slidingWindowLog', keyBy: ['ip', 'global'], limit: 100, windowSec: 60, global: { limit: 2, windowSec: 60 } },
      `global-${randomUUID()}`,
    );
    const gatewayA = await app([route], { redis: { url: REDIS_URL } });
    const gatewayB = await app([route], { redis: { url: REDIS_URL } });

    const a = await gatewayA.inject({ method: 'GET', url: '/x', remoteAddress: '10.1.0.1' });
    const b = await gatewayB.inject({ method: 'GET', url: '/x', remoteAddress: '10.1.0.2' });
    const c = await gatewayA.inject({ method: 'GET', url: '/x', remoteAddress: '10.1.0.3' });

    expect([a.statusCode, b.statusCode, c.statusCode]).toEqual([200, 200, 429]);
  });
});
