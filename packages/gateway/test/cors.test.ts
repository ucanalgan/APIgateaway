import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { gatewayConfigSchema } from '../src/config/schema.js';

// Real Fastify server (buildServer + app.inject) against a real ephemeral
// upstream — proves CORS behaves correctly through the actual request
// pipeline, not just at the header-building-function level.
async function startUpstream(): Promise<{ url: string; server: Server }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, server };
}

let app: FastifyInstance | undefined;
let upstream: { url: string; server: Server } | undefined;

afterEach(async () => {
  await app?.close();
  if (upstream) {
    await new Promise<void>((resolve) => upstream!.server.close(() => resolve()));
  }
  app = undefined;
  upstream = undefined;
});

describe('CORS', () => {
  it('answers a preflight request directly — 204, no upstream call, no auth/rate-limit', async () => {
    upstream = await startUpstream();
    const config = gatewayConfigSchema.parse({
      routes: [
        {
          id: 'r',
          match: { path: '/api/*', methods: ['GET'] }, // OPTIONS isn't even a listed method
          upstream: { targets: [upstream.url] },
          // would 401 without a valid token (and jwksUrl is never even
          // reachable here) — preflight must skip auth entirely, never get this far
          auth: { type: 'jwt', jwksUrl: 'https://jwks.invalid/.well-known/jwks.json' },
          cors: { enabled: true, origins: ['https://app.example.com'] },
        },
      ],
    });
    app = await buildServer(config, 'unused.yaml');

    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/hello',
      headers: { origin: 'https://app.example.com', 'access-control-request-method': 'POST' },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    expect(res.headers['access-control-allow-headers']).toContain('Content-Type');
    expect(res.headers['access-control-max-age']).toBe('600');
  });

  it('adds Access-Control-Allow-Origin to a real (non-preflight) response', async () => {
    upstream = await startUpstream();
    const config = gatewayConfigSchema.parse({
      routes: [
        {
          id: 'r',
          match: { path: '/api/*' },
          upstream: { targets: [upstream.url] },
          cors: { enabled: true, origins: ['https://app.example.com'] },
        },
      ],
    });
    app = await buildServer(config, 'unused.yaml');

    const res = await app.inject({
      method: 'GET',
      url: '/api/hello',
      headers: { origin: 'https://app.example.com' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');
    expect(res.headers['vary']).toBe('Origin');
  });

  it('omits CORS headers entirely for a disallowed origin', async () => {
    upstream = await startUpstream();
    const config = gatewayConfigSchema.parse({
      routes: [
        {
          id: 'r',
          match: { path: '/api/*' },
          upstream: { targets: [upstream.url] },
          cors: { enabled: true, origins: ['https://app.example.com'] },
        },
      ],
    });
    app = await buildServer(config, 'unused.yaml');

    const res = await app.inject({
      method: 'GET',
      url: '/api/hello',
      headers: { origin: 'https://evil.example.com' },
    });

    expect(res.statusCode).toBe(200); // the gateway still serves it — the *browser* is what enforces CORS
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('reflects the exact origin instead of "*" when credentials is enabled', async () => {
    upstream = await startUpstream();
    const config = gatewayConfigSchema.parse({
      routes: [
        {
          id: 'r',
          match: { path: '/api/*' },
          upstream: { targets: [upstream.url] },
          cors: { enabled: true, origins: ['*'], credentials: true },
        },
      ],
    });
    app = await buildServer(config, 'unused.yaml');

    const res = await app.inject({
      method: 'GET',
      url: '/api/hello',
      headers: { origin: 'https://app.example.com' },
    });

    expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('still adds CORS headers on a rejected (429) response — the browser needs to read the error body too', async () => {
    upstream = await startUpstream();
    const config = gatewayConfigSchema.parse({
      routes: [
        {
          id: 'r',
          match: { path: '/api/*' },
          upstream: { targets: [upstream.url] },
          cors: { enabled: true, origins: ['https://app.example.com'] },
          rateLimit: { algorithm: 'fixedWindow', keyBy: ['ip'], limit: 1, windowSec: 60 },
        },
      ],
    });
    app = await buildServer(config, 'unused.yaml');

    await app.inject({ method: 'GET', url: '/api/hello', headers: { origin: 'https://app.example.com' } });
    const blocked = await app.inject({
      method: 'GET',
      url: '/api/hello',
      headers: { origin: 'https://app.example.com' },
    });

    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['access-control-allow-origin']).toBe('https://app.example.com');
  });

  it('leaves a route with no cors config untouched', async () => {
    upstream = await startUpstream();
    const config = gatewayConfigSchema.parse({
      routes: [{ id: 'r', match: { path: '/api/*' }, upstream: { targets: [upstream.url] } }],
    });
    app = await buildServer(config, 'unused.yaml');

    const res = await app.inject({
      method: 'GET',
      url: '/api/hello',
      headers: { origin: 'https://app.example.com' },
    });

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
