import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, startUpstream, type TestUpstream } from './helpers.js';

// Real Fastify server (buildServer + app.inject) against a real ephemeral
// upstream — proves CORS behaves correctly through the actual request
// pipeline, not just at the header-building-function level.
let app: FastifyInstance | undefined;
let upstream: TestUpstream | undefined;

afterEach(async () => {
  await app?.close();
  await upstream?.close();
  app = undefined;
  upstream = undefined;
});

const ORIGIN = 'https://app.example.com';

async function gateway(route: Record<string, unknown>): Promise<FastifyInstance> {
  upstream = await startUpstream();
  app = await buildTestApp([{ id: 'r', match: { path: '/api/*' }, upstream: { targets: [upstream.url] }, ...route }]);
  return app;
}

describe('CORS', () => {
  it('answers a preflight request directly — 204, no upstream call, no auth/rate-limit', async () => {
    const gw = await gateway({
      match: { path: '/api/*', methods: ['GET'] }, // OPTIONS is not even a listed method
      // would 401 without a valid token (and jwksUrl is never even
      // reachable here) — preflight must skip auth entirely, never get this far
      auth: { type: 'jwt', jwksUrl: 'https://jwks.invalid/.well-known/jwks.json' },
      cors: { enabled: true, origins: [ORIGIN] },
    });

    const res = await gw.inject({
      method: 'OPTIONS',
      url: '/api/hello',
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST' },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    expect(res.headers['access-control-allow-headers']).toContain('Content-Type');
    expect(res.headers['access-control-max-age']).toBe('600');
    expect(upstream!.requests).toHaveLength(0);
  });

  it('adds Access-Control-Allow-Origin to a real (non-preflight) response', async () => {
    const gw = await gateway({ cors: { enabled: true, origins: [ORIGIN] } });

    const res = await gw.inject({ method: 'GET', url: '/api/hello', headers: { origin: ORIGIN } });

    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.headers['vary']).toBe('Origin');
  });

  it('omits CORS headers entirely for a disallowed origin', async () => {
    const gw = await gateway({ cors: { enabled: true, origins: [ORIGIN] } });

    const res = await gw.inject({ method: 'GET', url: '/api/hello', headers: { origin: 'https://evil.example.com' } });

    expect(res.statusCode).toBe(200); // the gateway still serves it — the *browser* is what enforces CORS
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('reflects the exact origin instead of "*" when credentials is enabled', async () => {
    const gw = await gateway({ cors: { enabled: true, origins: ['*'], credentials: true } });

    const res = await gw.inject({ method: 'GET', url: '/api/hello', headers: { origin: ORIGIN } });

    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('still adds CORS headers on a rejected (429) response — the browser needs to read the error body too', async () => {
    const gw = await gateway({
      cors: { enabled: true, origins: [ORIGIN] },
      rateLimit: { algorithm: 'slidingWindowLog', keyBy: ['ip'], limit: 1, windowSec: 60 },
    });

    await gw.inject({ method: 'GET', url: '/api/hello', headers: { origin: ORIGIN } });
    const blocked = await gw.inject({ method: 'GET', url: '/api/hello', headers: { origin: ORIGIN } });

    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['access-control-allow-origin']).toBe(ORIGIN);
  });

  it('leaves a route with no cors config untouched', async () => {
    const gw = await gateway({});

    const res = await gw.inject({ method: 'GET', url: '/api/hello', headers: { origin: ORIGIN } });

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
