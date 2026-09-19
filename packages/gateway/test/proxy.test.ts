import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, deadUrl, listen, startUpstream, waitFor, type TestUpstream } from './helpers.js';

// The proxy pipeline end-to-end: real Fastify server (app.inject) in front of
// real HTTP upstreams on ephemeral ports. No mocks anywhere.
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

describe('routing', () => {
  it('serves /health without touching any route', async () => {
    app = await buildTestApp([]);

    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('answers 404 with the standard error shape when no route matches', async () => {
    app = await buildTestApp([]);

    const res = await app.inject({ method: 'GET', url: '/nope' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_found', requestId: res.headers['x-request-id'] });
  });

  it('honors a route\'s method restriction', async () => {
    const up = await upstream();
    app = await buildTestApp([
      { id: 'r', match: { path: '/api/*', methods: ['GET'] }, upstream: { targets: [up.url] } },
    ]);

    expect((await app.inject({ method: 'GET', url: '/api/x' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: '/api/x' })).statusCode).toBe(404);
  });
});

describe('forwarding', () => {
  it('strips the configured prefix, keeps the query string, and relays status/headers/body', async () => {
    const up = await upstream((_req, res) => {
      res.writeHead(201, { 'content-type': 'text/plain', 'x-from-upstream': 'yes' });
      res.end('created');
    });
    app = await buildTestApp([
      {
        id: 'r',
        match: { path: '/api/v1/*' },
        rewrite: { stripPrefix: '/api/v1' },
        upstream: { targets: [up.url] },
      },
    ]);

    const res = await app.inject({ method: 'GET', url: '/api/v1/users?page=2' });

    expect(up.requests[0]?.url).toBe('/users?page=2');
    expect(res.statusCode).toBe(201);
    expect(res.headers['x-from-upstream']).toBe('yes');
    expect(res.body).toBe('created');
  });

  it('streams a request body through to the upstream unchanged', async () => {
    const up = await upstream();
    app = await buildTestApp([{ id: 'r', match: { path: '/*' }, upstream: { targets: [up.url] } }]);

    const payload = JSON.stringify({ hello: 'world', n: [1, 2, 3] });
    const res = await app.inject({
      method: 'POST',
      url: '/things',
      headers: { 'content-type': 'application/json' },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(up.requests[0]).toMatchObject({ method: 'POST', body: payload });
    expect(up.requests[0]?.headers['content-type']).toBe('application/json');
  });

  it('appends (never trusts) X-Forwarded-For, propagates the request id, and drops hop-by-hop headers', async () => {
    const up = await upstream();
    app = await buildTestApp([{ id: 'r', match: { path: '/*' }, upstream: { targets: [up.url] } }]);

    const res = await app.inject({
      method: 'GET',
      url: '/x',
      remoteAddress: '203.0.113.9',
      headers: {
        'x-forwarded-for': '6.6.6.6',
        'x-request-id': 'client-supplied-id',
        'proxy-authorization': 'Basic c2VjcmV0',
        host: 'gateway.example.com',
      },
    });

    const seen = up.requests[0]!.headers;
    expect(seen['x-forwarded-for']).toBe('6.6.6.6, 203.0.113.9');
    expect(seen['x-request-id']).toBe('client-supplied-id');
    expect(res.headers['x-request-id']).toBe('client-supplied-id');
    expect(seen['x-forwarded-host']).toBe('gateway.example.com');
    expect(seen['proxy-authorization']).toBeUndefined();
  });

  it('applies transform.request — sets and removes headers on the outbound request only', async () => {
    const up = await upstream();
    app = await buildTestApp([
      {
        id: 'r',
        match: { path: '/*' },
        upstream: { targets: [up.url] },
        transform: { request: { setHeaders: { 'X-Gateway': 'apigate' }, removeHeaders: ['X-Internal-Token'] } },
      },
    ]);

    await app.inject({ method: 'GET', url: '/x', headers: { 'x-internal-token': 'secret', 'x-keep': 'me' } });

    const seen = up.requests[0]!.headers;
    expect(seen['x-gateway']).toBe('apigate');
    expect(seen['x-internal-token']).toBeUndefined();
    expect(seen['x-keep']).toBe('me');
  });

  it('passes an upstream 5xx straight through', async () => {
    const up = await upstream((_req, res) => {
      res.writeHead(500);
      res.end('boom');
    });
    app = await buildTestApp([{ id: 'r', match: { path: '/*' }, upstream: { targets: [up.url] } }]);

    const res = await app.inject({ method: 'GET', url: '/x' });

    expect(res.statusCode).toBe(500);
    expect(res.body).toBe('boom');
  });
});

describe('upstream failures', () => {
  it('answers 502 when the upstream refuses the connection', async () => {
    app = await buildTestApp([{ id: 'r', match: { path: '/*' }, upstream: { targets: [await deadUrl()] } }]);

    const res = await app.inject({ method: 'GET', url: '/x' });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: 'bad_gateway' });
  });

  it('answers 504 when the upstream does not respond within timeoutMs', async () => {
    const hung = await upstream(() => {
      /* never responds */
    });
    app = await buildTestApp([
      { id: 'r', match: { path: '/*' }, upstream: { targets: [hung.url], timeoutMs: 100 } },
    ]);

    const res = await app.inject({ method: 'GET', url: '/x' });

    expect(res.statusCode).toBe(504);
    expect(res.json()).toMatchObject({ error: 'upstream_timeout' });
  });
});

describe('retry', () => {
  it('retries an idempotent request on a connection failure, landing on the next target', async () => {
    const live = await upstream();
    app = await buildTestApp([
      {
        id: 'r',
        match: { path: '/*' },
        upstream: { targets: [await deadUrl(), live.url] },
        retry: { attempts: 1, backoffMs: 1 },
      },
    ]);

    const res = await app.inject({ method: 'GET', url: '/x' });

    expect(res.statusCode).toBe(200);
    expect(live.requests).toHaveLength(1);
  });

  it('re-sends a buffered PUT body on the retry attempt', async () => {
    const live = await upstream();
    app = await buildTestApp([
      {
        id: 'r',
        match: { path: '/*' },
        upstream: { targets: [await deadUrl(), live.url] },
        retry: { attempts: 1, backoffMs: 1 },
      },
    ]);

    const res = await app.inject({ method: 'PUT', url: '/x', headers: { 'content-type': 'text/plain' }, payload: 'hello' });

    expect(res.statusCode).toBe(200);
    expect(live.requests[0]?.body).toBe('hello');
  });

  it('never retries a POST — a failed first attempt is final', async () => {
    const live = await upstream();
    app = await buildTestApp([
      {
        id: 'r',
        match: { path: '/*' },
        upstream: { targets: [await deadUrl(), live.url] },
        retry: { attempts: 1, backoffMs: 1 },
      },
    ]);
    // Real socket: app.inject's fake request stream rejects when undici destroys it on failure.
    const base = await listen(app);

    const res = await fetch(`${base}/x`, { method: 'POST', body: 'x' });

    expect(res.status).toBe(502);
    expect(live.requests).toHaveLength(0);
  });

  it('does not retry an upstream 5xx (only connection failures/timeouts)', async () => {
    const flaky = await upstream((_req, res) => {
      res.writeHead(503);
      res.end();
    });
    app = await buildTestApp([
      {
        id: 'r',
        match: { path: '/*' },
        upstream: { targets: [flaky.url] },
        retry: { attempts: 3, backoffMs: 1 },
      },
    ]);

    const res = await app.inject({ method: 'GET', url: '/x' });

    expect(res.statusCode).toBe(503);
    expect(flaky.requests).toHaveLength(1);
  });
});

describe('circuit breaker', () => {
  it('opens after the failure threshold and stops sending traffic to the target', async () => {
    app = await buildTestApp([
      {
        id: 'r',
        match: { path: '/*' },
        upstream: { targets: [await deadUrl()] },
        circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 60_000 },
      },
    ]);

    const first = await app.inject({ method: 'GET', url: '/x' });
    const second = await app.inject({ method: 'GET', url: '/x' });

    expect(first.statusCode).toBe(502);
    expect(second.statusCode).toBe(503);
    expect(second.json()).toMatchObject({ error: 'service_unavailable' });
  });

  it('counts an upstream 5xx against the breaker even though it is not retried', async () => {
    const broken = await upstream((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    app = await buildTestApp([
      {
        id: 'r',
        match: { path: '/*' },
        upstream: { targets: [broken.url] },
        circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 60_000 },
      },
    ]);

    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await app.inject({ method: 'GET', url: '/x' })).statusCode);

    expect(statuses).toEqual([500, 500, 503]);
    expect(broken.requests).toHaveLength(2);
  });
});

describe('health checks', () => {
  it('pulls a dead target out of rotation so requests stop failing', async () => {
    const live = await upstream();
    const dead = await deadUrl();
    app = await buildTestApp([
      {
        id: 'r',
        match: { path: '/*' },
        upstream: { targets: [dead, live.url], healthCheck: { path: '/health', intervalMs: 50 } },
      },
    ]);

    // /metrics refreshes the gauge from the balancer's real state at scrape time.
    await waitFor(async () => {
      const metrics = (await app!.inject({ method: 'GET', url: '/metrics' })).body;
      return metrics.includes(`apigate_upstream_healthy{route="r",target="${dead}"} 0`);
    });

    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await app.inject({ method: 'GET', url: '/x' })).statusCode);

    expect(statuses).toEqual([200, 200, 200, 200, 200, 200]);
  });

  it('answers 503 once every target is unhealthy', async () => {
    app = await buildTestApp([
      {
        id: 'r',
        match: { path: '/*' },
        upstream: { targets: [await deadUrl()], healthCheck: { path: '/health', intervalMs: 50 } },
      },
    ]);

    await waitFor(async () => (await app!.inject({ method: 'GET', url: '/x' })).statusCode === 503);
  });
});

describe('security limits', () => {
  it('rejects a request with more headers than server.maxHeaderCount', async () => {
    const up = await upstream();
    app = await buildTestApp([{ id: 'r', match: { path: '/*' }, upstream: { targets: [up.url] } }], {
      server: { maxHeaderCount: 3 },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/x',
      headers: { 'x-a': '1', 'x-b': '2', 'x-c': '3', 'x-d': '4' },
    });

    expect(res.statusCode).toBe(431);
    expect(res.json()).toMatchObject({ error: 'too_many_headers' });
    expect(up.requests).toHaveLength(0);
  });

  it('rejects a declared Content-Length over server.maxBodyBytes before reading any of it', async () => {
    const up = await upstream();
    app = await buildTestApp([{ id: 'r', match: { path: '/*' }, upstream: { targets: [up.url] } }], {
      server: { maxBodyBytes: 8 },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/x',
      headers: { 'content-type': 'text/plain' },
      payload: 'this body is definitely longer than eight bytes',
    });

    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ error: 'payload_too_large' });
    expect(up.requests).toHaveLength(0);
  });

  it('lets a body exactly at the limit through', async () => {
    const up = await upstream();
    app = await buildTestApp([{ id: 'r', match: { path: '/*' }, upstream: { targets: [up.url] } }], {
      server: { maxBodyBytes: 8 },
    });

    const res = await app.inject({ method: 'POST', url: '/x', headers: { 'content-type': 'text/plain' }, payload: '12345678' });

    expect(res.statusCode).toBe(200);
    expect(up.requests[0]?.body).toBe('12345678');
  });

  it('cuts off a chunked body (no Content-Length) once it exceeds the limit — the upstream never gets a complete request', async () => {
    const up = await upstream();
    app = await buildTestApp([{ id: 'r', match: { path: '/*' }, upstream: { targets: [up.url] } }], {
      server: { maxBodyBytes: 1024 },
    });
    const base = await listen(app);

    const chunk = new TextEncoder().encode('x'.repeat(512));
    const body = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 8; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    const res = await fetch(`${base}/x`, { method: 'POST', body, duplex: 'half' } as RequestInit);

    expect(res.status).toBe(413);
    expect(up.requests).toHaveLength(0);
  });

  it('does not blame the upstream for an oversized client body — the circuit breaker stays closed', async () => {
    const up = await upstream();
    app = await buildTestApp(
      [
        {
          id: 'r',
          match: { path: '/*' },
          upstream: { targets: [up.url] },
          circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 60_000 },
          retry: { attempts: 1, backoffMs: 1 },
        },
      ],
      { server: { maxBodyBytes: 1024 } },
    );
    const base = await listen(app);

    const chunk = new TextEncoder().encode('x'.repeat(512));
    const tooBig = () =>
      new ReadableStream({
        start(controller) {
          for (let i = 0; i < 8; i++) controller.enqueue(chunk);
          controller.close();
        },
      });
    // PUT is retry-eligible (buffered path); POST is not (streamed path) — cover both.
    const put = await fetch(`${base}/x`, { method: 'PUT', body: tooBig(), duplex: 'half' } as RequestInit);
    const post = await fetch(`${base}/x`, { method: 'POST', body: tooBig(), duplex: 'half' } as RequestInit);
    const after = await fetch(`${base}/x`);

    expect(put.status).toBe(413);
    expect(post.status).toBe(413);
    expect(after.status).toBe(200); // a threshold-1 breaker would be open by now if 413s counted as failures
  });
});
