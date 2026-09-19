import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, startUpstream, type TestUpstream } from './helpers.js';

let app: FastifyInstance | undefined;
const upstreams: TestUpstream[] = [];

async function upstream(name: string): Promise<TestUpstream> {
  const u = await startUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(name);
  });
  upstreams.push(u);
  return u;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
  await Promise.all(upstreams.splice(0).map((u) => u.close()));
});

const get = (gw: FastifyInstance, host: string | undefined, extra: Record<string, string> = {}, url = '/x') =>
  gw.inject({ method: 'GET', url, headers: { ...(host !== undefined ? { host } : {}), ...extra } });

describe('host-based routing', () => {
  it('sends each host to its own upstream — the port in the Host header does not matter', async () => {
    const a = await upstream('from-a');
    const b = await upstream('from-b');
    app = await buildTestApp([
      { id: 'a', match: { host: 'a.test', path: '/*' }, upstream: { targets: [a.url] } },
      { id: 'b', match: { host: 'b.test', path: '/*' }, upstream: { targets: [b.url] } },
    ]);

    expect((await get(app, 'a.test')).body).toBe('from-a');
    expect((await get(app, 'B.TEST:8080')).body).toBe('from-b');
    expect(a.requests).toHaveLength(1);
    expect(b.requests).toHaveLength(1);
  });

  it('answers 404 for a host no route claims', async () => {
    const a = await upstream('from-a');
    app = await buildTestApp([{ id: 'a', match: { host: 'a.test', path: '/*' }, upstream: { targets: [a.url] } }]);

    const res = await get(app, 'stranger.test');

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_found' });
    expect(a.requests).toHaveLength(0);
  });

  it('a wildcard route serves every subdomain but not the apex domain', async () => {
    const wild = await upstream('from-wild');
    app = await buildTestApp([{ id: 'wild', match: { host: '*.sites.test', path: '/*' }, upstream: { targets: [wild.url] } }]);

    expect((await get(app, 'acme.sites.test')).body).toBe('from-wild');
    expect((await get(app, 'a.b.sites.test')).body).toBe('from-wild');
    expect((await get(app, 'sites.test')).statusCode).toBe(404);
  });

  it('falls through, in route order, to a host-less catch-all', async () => {
    const special = await upstream('special');
    const fallback = await upstream('fallback');
    app = await buildTestApp([
      { id: 'special', match: { host: 'vip.test', path: '/*' }, upstream: { targets: [special.url] } },
      { id: 'fallback', match: { path: '/*' }, upstream: { targets: [fallback.url] } },
    ]);

    expect((await get(app, 'vip.test')).body).toBe('special');
    expect((await get(app, 'anyone.test')).body).toBe('fallback');
  });

  it('one path, two hosts, two different rate limits — buckets are per route', async () => {
    const a = await upstream('a');
    const b = await upstream('b');
    app = await buildTestApp([
      {
        id: 'tight',
        match: { host: 'tight.test', path: '/*' },
        upstream: { targets: [a.url] },
        rateLimit: { algorithm: 'slidingWindowLog', keyBy: ['ip'], limit: 1, windowSec: 60 },
      },
      { id: 'open', match: { host: 'open.test', path: '/*' }, upstream: { targets: [b.url] } },
    ]);

    const tight = [(await get(app, 'tight.test')).statusCode, (await get(app, 'tight.test')).statusCode];
    const open = [(await get(app, 'open.test')).statusCode, (await get(app, 'open.test')).statusCode];

    expect(tight).toEqual([200, 429]);
    expect(open).toEqual([200, 200]);
  });
});

describe('X-Forwarded-Host — only trusted when a trusted proxy sent it', () => {
  it('is IGNORED when trustProxyHops is 0: a client cannot route itself onto another host\'s route', async () => {
    const a = await upstream('from-a');
    const b = await upstream('from-b');
    app = await buildTestApp([
      { id: 'a', match: { host: 'a.test', path: '/*' }, upstream: { targets: [a.url] } },
      { id: 'b', match: { host: 'b.test', path: '/*' }, upstream: { targets: [b.url] } },
    ]);

    const res = await get(app, 'b.test', { 'x-forwarded-host': 'a.test' });

    expect(res.body).toBe('from-b'); // the real Host header wins
    expect(a.requests).toHaveLength(0);
  });

  it('is honored when the peer is a trusted proxy hop', async () => {
    const a = await upstream('from-a');
    const b = await upstream('from-b');
    app = await buildTestApp(
      [
        { id: 'a', match: { host: 'a.test', path: '/*' }, upstream: { targets: [a.url] } },
        { id: 'b', match: { host: 'b.test', path: '/*' }, upstream: { targets: [b.url] } },
      ],
      { server: { trustProxyHops: 1 } },
    );

    const res = await get(app, 'gateway.internal', { 'x-forwarded-host': 'a.test' });

    expect(res.body).toBe('from-a');
  });
});

describe('CORS preflight respects the host', () => {
  it('answers a preflight with the policy of the route that owns that host', async () => {
    const a = await upstream('a');
    const b = await upstream('b');
    app = await buildTestApp([
      {
        id: 'a',
        match: { host: 'a.test', path: '/api/*' },
        upstream: { targets: [a.url] },
        cors: { enabled: true, origins: ['https://app-a.example'] },
      },
      {
        id: 'b',
        match: { host: 'b.test', path: '/api/*' },
        upstream: { targets: [b.url] },
        cors: { enabled: true, origins: ['https://app-b.example'] },
      },
    ]);
    const preflight = (host: string, origin: string) =>
      app!.inject({
        method: 'OPTIONS',
        url: '/api/x',
        headers: { host, origin, 'access-control-request-method': 'GET' },
      });

    const okA = await preflight('a.test', 'https://app-a.example');
    const crossed = await preflight('a.test', 'https://app-b.example'); // b's origin, but a's host

    expect(okA.statusCode).toBe(204);
    expect(okA.headers['access-control-allow-origin']).toBe('https://app-a.example');
    expect(crossed.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('response cache on a wildcard-host route', () => {
  it('never serves one subdomain\'s cached page to another — the host is part of the cache key', async () => {
    const up = await startUpstream((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`dashboard for ${req.headers['x-forwarded-host']}`);
    });
    upstreams.push(up);
    app = await buildTestApp([
      {
        id: 'sites',
        match: { host: '*.sites.test', path: '/*' },
        upstream: { targets: [up.url] },
        cache: { enabled: true, ttlSec: 60 },
      },
    ]);

    const acme1 = await get(app, 'acme.sites.test', {}, '/dashboard');
    const globex = await get(app, 'globex.sites.test', {}, '/dashboard');
    const acme2 = await get(app, 'acme.sites.test', {}, '/dashboard');

    expect(acme1.body).toBe('dashboard for acme.sites.test');
    expect(globex.body).toBe('dashboard for globex.sites.test'); // NOT acme's page
    expect(globex.headers['x-cache']).toBe('MISS');
    expect(acme2.headers['x-cache']).toBe('HIT');
    expect(up.requests).toHaveLength(2);
  });
});
