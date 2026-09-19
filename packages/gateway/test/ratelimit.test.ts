import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { gatewayConfigSchema } from '../src/config/schema.js';

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

describe('config: rateLimit.global', () => {
  it('rejects a route with keyBy: [global] and no global policy', () => {
    const result = gatewayConfigSchema.safeParse({
      routes: [
        {
          id: 'r',
          match: { path: '/*' },
          upstream: { targets: ['http://upstream'] },
          rateLimit: { keyBy: ['global'], limit: 100, windowSec: 60 },
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('accepts keyBy: [global] once a global policy is set', () => {
    const result = gatewayConfigSchema.safeParse({
      routes: [
        {
          id: 'r',
          match: { path: '/*' },
          upstream: { targets: ['http://upstream'] },
          rateLimit: { keyBy: ['global'], limit: 100, windowSec: 60, global: { limit: 5, windowSec: 60 } },
        },
      ],
    });

    expect(result.success).toBe(true);
  });
});

describe('global rate-limit key — real request pipeline', () => {
  it('caps total traffic across the route regardless of which client is asking', async () => {
    upstream = await startUpstream();
    const config = gatewayConfigSchema.parse({
      routes: [
        {
          id: 'r',
          match: { path: '/api/*' },
          upstream: { targets: [upstream.url] },
          rateLimit: {
            algorithm: 'slidingWindowLog',
            keyBy: ['ip', 'global'],
            limit: 100, // per-IP: generous, never the bottleneck in this test
            windowSec: 60,
            global: { limit: 2, windowSec: 60 }, // shared cap: only 2 requests total, from anyone
          },
        },
      ],
    });
    app = await buildServer(config, 'unused.yaml');

    // Three different "clients" (distinct source IPs) hit the same route.
    // A per-IP-only limiter would let all three through (each is its own
    // bucket) — the global key is what caps the *route's* total traffic.
    const first = await app.inject({ method: 'GET', url: '/api/hello', remoteAddress: '10.0.0.1' });
    const second = await app.inject({ method: 'GET', url: '/api/hello', remoteAddress: '10.0.0.2' });
    const third = await app.inject({ method: 'GET', url: '/api/hello', remoteAddress: '10.0.0.3' });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);
    expect(third.json()).toMatchObject({ error: 'rate_limit_exceeded' });
  });

  it('keeps a per-tenant/IP limit working normally when global is not in keyBy', async () => {
    upstream = await startUpstream();
    const config = gatewayConfigSchema.parse({
      routes: [
        {
          id: 'r',
          match: { path: '/api/*' },
          upstream: { targets: [upstream.url] },
          rateLimit: { algorithm: 'slidingWindowLog', keyBy: ['ip'], limit: 1, windowSec: 60 },
        },
      ],
    });
    app = await buildServer(config, 'unused.yaml');

    const allowed = await app.inject({ method: 'GET', url: '/api/hello', remoteAddress: '10.0.0.1' });
    const blocked = await app.inject({ method: 'GET', url: '/api/hello', remoteAddress: '10.0.0.1' });
    const otherIp = await app.inject({ method: 'GET', url: '/api/hello', remoteAddress: '10.0.0.2' });

    expect(allowed.statusCode).toBe(200);
    expect(blocked.statusCode).toBe(429);
    expect(otherIp.statusCode).toBe(200); // untouched — no global key, so IPs are fully independent
  });
});
