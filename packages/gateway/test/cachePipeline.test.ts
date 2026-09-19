import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { REDIS_URL, buildTestApp, redisReachable, startUpstream, type TestUpstream } from './helpers.js';

let app: FastifyInstance | undefined;
const upstreams: TestUpstream[] = [];

async function upstream(handler?: Parameters<typeof startUpstream>[0]): Promise<TestUpstream> {
  const u = await startUpstream(handler);
  upstreams.push(u);
  return u;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
  await Promise.all(upstreams.splice(0).map((u) => u.close()));
});

const cachedRoute = (target: string, cache: Record<string, unknown> = {}) => ({
  id: 'cached',
  match: { path: '/*' },
  upstream: { targets: [target] },
  cache: { enabled: true, ttlSec: 60, ...cache },
});

describe('response cache (in-process store)', () => {
  it('serves the second GET from cache without touching the upstream', async () => {
    const up = await upstream();
    app = await buildTestApp([cachedRoute(up.url)]);

    const first = await app.inject({ method: 'GET', url: '/thing' });
    const second = await app.inject({ method: 'GET', url: '/thing' });

    expect(first.headers['x-cache']).toBe('MISS');
    expect(second.headers['x-cache']).toBe('HIT');
    expect(second.body).toBe(first.body);
    expect(up.requests).toHaveLength(1);
  });

  it('strips Set-Cookie from what it stores — a hit never replays one user\'s session cookie', async () => {
    const up = await upstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'session=secret' });
      res.end('body');
    });
    app = await buildTestApp([cachedRoute(up.url)]);

    const miss = await app.inject({ method: 'GET', url: '/x' });
    const hit = await app.inject({ method: 'GET', url: '/x' });

    expect(miss.headers['set-cookie']).toBe('session=secret'); // the original caller still gets their own
    expect(hit.headers['x-cache']).toBe('HIT');
    expect(hit.headers['set-cookie']).toBeUndefined();
  });

  it('never caches a response the upstream marked no-store', async () => {
    const up = await upstream((_req, res) => {
      res.writeHead(200, { 'cache-control': 'no-store' });
      res.end('fresh');
    });
    app = await buildTestApp([cachedRoute(up.url)]);

    const first = await app.inject({ method: 'GET', url: '/x' });
    const second = await app.inject({ method: 'GET', url: '/x' });

    expect(first.headers['x-cache']).toBe('MISS');
    expect(second.headers['x-cache']).toBe('MISS');
    expect(up.requests).toHaveLength(2);
  });

  it('keeps separate entries per varyBy header value', async () => {
    const up = await upstream();
    app = await buildTestApp([cachedRoute(up.url, { varyBy: ['Accept-Language'] })]);

    await app.inject({ method: 'GET', url: '/x', headers: { 'accept-language': 'en' } });
    await app.inject({ method: 'GET', url: '/x', headers: { 'accept-language': 'tr' } });
    const enAgain = await app.inject({ method: 'GET', url: '/x', headers: { 'accept-language': 'en' } });

    expect(enAgain.headers['x-cache']).toBe('HIT');
    expect(up.requests).toHaveLength(2);
  });

  it('keeps a separate entry per query string — /items?page=1 must never be served for /items?page=2', async () => {
    const up = await upstream((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`you asked for ${req.url}`);
    });
    app = await buildTestApp([cachedRoute(up.url)]);

    const page1 = await app.inject({ method: 'GET', url: '/items?page=1' });
    const page2 = await app.inject({ method: 'GET', url: '/items?page=2' });
    const page1Again = await app.inject({ method: 'GET', url: '/items?page=1' });

    expect(page1.body).toBe('you asked for /items?page=1');
    expect(page2.body).toBe('you asked for /items?page=2');
    expect(page2.headers['x-cache']).toBe('MISS');
    expect(page1Again.headers['x-cache']).toBe('HIT');
    expect(up.requests).toHaveLength(2);
  });

  it('does not cache non-GET methods', async () => {
    const up = await upstream();
    app = await buildTestApp([cachedRoute(up.url)]);

    const first = await app.inject({ method: 'POST', url: '/x', headers: { 'content-type': 'text/plain' }, payload: 'a' });
    const second = await app.inject({ method: 'POST', url: '/x', headers: { 'content-type': 'text/plain' }, payload: 'a' });

    expect(first.headers['x-cache']).toBeUndefined();
    expect(second.headers['x-cache']).toBeUndefined();
    expect(up.requests).toHaveLength(2);
  });

  it('serves — but does not cache — a response larger than server.maxBodyBytes', async () => {
    const up = await upstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('y'.repeat(200));
    });
    app = await buildTestApp([cachedRoute(up.url)], { server: { maxBodyBytes: 16 } });

    const first = await app.inject({ method: 'GET', url: '/x' });
    const second = await app.inject({ method: 'GET', url: '/x' });

    expect(first.body).toHaveLength(200);
    expect(second.headers['x-cache']).toBe('MISS');
    expect(up.requests).toHaveLength(2);
  });
});

const redisAvailable = await redisReachable();

describe.skipIf(!redisAvailable)('response cache (real Redis store)', () => {
  it('shares entries through Redis — MISS then HIT, and the entry is really in Redis', async () => {
    const up = await upstream();
    const routeId = `cached-${randomUUID()}`;
    app = await buildTestApp([{ ...cachedRoute(up.url), id: routeId }], { redis: { url: REDIS_URL } });

    const first = await app.inject({ method: 'GET', url: '/thing' });
    await new Promise((resolve) => setTimeout(resolve, 100)); // the cache write is fire-and-forget
    const second = await app.inject({ method: 'GET', url: '/thing' });

    expect(first.headers['x-cache']).toBe('MISS');
    expect(second.headers['x-cache']).toBe('HIT');
    expect(up.requests).toHaveLength(1);

    const redis = new Redis(REDIS_URL);
    try {
      expect(await redis.keys(`cache:${routeId}:*`)).toHaveLength(1);
    } finally {
      await redis.quit();
    }
  });
});
