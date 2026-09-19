import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import WsClient, { type ClientOptions } from 'ws';
import type { FastifyInstance } from 'fastify';
import {
  buildTestApp,
  connectWs,
  deadUrl,
  listen,
  nextClose,
  nextMessage,
  rejectedHandshake,
  sleep,
  startWsUpstream,
  waitFor,
  wsUrl,
  type TestWsUpstream,
  type WsUpstreamOptions,
} from './helpers.js';

// A real `ws` server as the upstream, real `ws` clients, real sockets through
// the gateway — including the parts a mock could never get right: the HTTP
// upgrade going through the normal pipeline, close-code propagation, dead-peer
// detection, and shutdown with connections still open.
let app: FastifyInstance | undefined;
let base = '';
const upstreams: TestWsUpstream[] = [];
const clients: WsClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.terminate();
  await app?.close();
  app = undefined;
  await Promise.all(upstreams.splice(0).map((u) => u.close()));
});

async function upstream(options?: WsUpstreamOptions): Promise<TestWsUpstream> {
  const u = await startWsUpstream(options);
  upstreams.push(u);
  return u;
}

interface GatewayOptions {
  readonly route?: Record<string, unknown>;
  readonly websocket?: Record<string, unknown> | false;
  readonly config?: Record<string, unknown>;
}

/** A gateway with one route, `/*`, in front of `targets`, with WebSocket enabled unless `websocket: false`. */
async function gateway(targets: string[], options: GatewayOptions = {}): Promise<string> {
  app = await buildTestApp(
    [
      {
        id: 'ws',
        match: { path: '/*' },
        upstream: { targets },
        ...(options.websocket === false ? {} : { websocket: { enabled: true, ...(options.websocket ?? {}) } }),
        ...options.route,
      },
    ],
    options.config ?? {},
  );
  base = await listen(app);
  return base;
}

async function open(path = '/chat', protocols?: string[], options?: ClientOptions): Promise<WsClient> {
  const ws = await connectWs(wsUrl(base, path), protocols, options);
  clients.push(ws);
  return ws;
}

const metricsText = async (): Promise<string> => (await fetch(`${base}/metrics`)).text();

describe('proxying messages', () => {
  it('relays text and binary messages both ways, preserving the frame type', async () => {
    const up = await upstream();
    await gateway([up.url]);
    const ws = await open();

    ws.send('héllo wörld');
    const text = await nextMessage(ws);
    ws.send(Buffer.from([0, 1, 2, 255, 254]));
    const binary = await nextMessage(ws);

    expect(text).toEqual({ data: Buffer.from('héllo wörld'), isBinary: false });
    expect(binary).toEqual({ data: Buffer.from([0, 1, 2, 255, 254]), isBinary: true });
    expect(up.received.map((m) => m.isBinary)).toEqual([false, true]);
  });

  it('keeps message order across a burst', async () => {
    const up = await upstream();
    await gateway([up.url]);
    const ws = await open();
    const echoed: string[] = [];
    ws.on('message', (d) => echoed.push(d.toString()));

    for (let i = 0; i < 50; i++) ws.send(`m${i}`);
    await waitFor(() => echoed.length === 50);

    expect(echoed).toEqual(Array.from({ length: 50 }, (_, i) => `m${i}`));
  });

  it('relays messages the upstream sends on its own initiative (no request needed)', async () => {
    const up = await upstream({ onConnection: (ws) => ws.send('welcome') });
    await gateway([up.url]);
    const received: string[] = [];
    const ws = new WsClient(wsUrl(base, '/feed'));
    clients.push(ws);
    ws.on('message', (d) => received.push(d.toString()));

    await waitFor(() => received.length === 1);

    expect(received).toEqual(['welcome']);
  });
});

describe('handshake', () => {
  it('negotiates the sub-protocol the UPSTREAM picked, and tells the upstream what was offered', async () => {
    const up = await upstream({ protocols: (offered) => (offered.has('json') ? 'json' : false) });
    await gateway([up.url]);

    const ws = await open('/chat', ['chat', 'json']);

    expect(ws.protocol).toBe('json');
    expect(up.handshakes[0]?.headers['sec-websocket-protocol']).toBe('chat, json');
  });

  it('connects without a sub-protocol when the upstream selects none', async () => {
    const up = await upstream({ protocols: () => false });
    await gateway([up.url]);

    // Offered via the raw header: the `ws` client itself refuses a server that answers with no sub-protocol
    // ("Server sent no subprotocol"), which browsers accept — and which the gateway must, too.
    const ws = await open('/chat', undefined, { headers: { 'sec-websocket-protocol': 'chat' } });

    expect(ws.protocol).toBe('');
    expect(up.handshakes[0]?.headers['sec-websocket-protocol']).toBe('chat');
  });

  it('applies path rewrite and the request transform, adds X-Forwarded-*, and echoes the request id back', async () => {
    const up = await upstream();
    await gateway([up.url], {
      route: {
        match: { path: '/ws/*' },
        rewrite: { stripPrefix: '/ws' },
        transform: { request: { setHeaders: { 'X-Gateway': 'apigate' }, removeHeaders: ['X-Secret'] } },
      },
    });
    let responseId: string | undefined;
    const ws = new WsClient(wsUrl(base, '/ws/chat?room=7'), { headers: { 'x-secret': 'hunter2', 'x-keep': 'me' } });
    clients.push(ws);
    ws.once('upgrade', (res) => {
      responseId = String(res.headers['x-request-id']);
    });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    const seen = up.handshakes[0]!;
    expect(seen.url).toBe('/chat?room=7');
    expect(seen.headers['x-gateway']).toBe('apigate');
    expect(seen.headers['x-secret']).toBeUndefined();
    expect(seen.headers['x-keep']).toBe('me');
    expect(seen.headers['x-forwarded-for']).toMatch(/127\.0\.0\.1/);
    expect(seen.headers['x-request-id']).toBe(responseId);
  });

  it('forwards the client Origin to the upstream', async () => {
    const up = await upstream();
    await gateway([up.url]);

    await open('/chat', undefined, { origin: 'https://app.example.com' });

    expect(up.handshakes[0]?.headers.origin).toBe('https://app.example.com');
  });

  it('routes by Host like any other request', async () => {
    const a = await upstream();
    const b = await upstream();
    app = await buildTestApp([
      { id: 'a', match: { host: 'a.test', path: '/*' }, upstream: { targets: [a.url] }, websocket: { enabled: true } },
      { id: 'b', match: { host: 'b.test', path: '/*' }, upstream: { targets: [b.url] }, websocket: { enabled: true } },
    ]);
    base = await listen(app);

    await open('/x', undefined, { headers: { host: 'b.test' } });

    expect(a.handshakes).toHaveLength(0);
    expect(b.handshakes).toHaveLength(1);
  });
});

describe('what the gateway refuses', () => {
  it('answers 404 when no route matches', async () => {
    const up = await upstream();
    app = await buildTestApp([{ id: 'r', match: { path: '/only/*' }, upstream: { targets: [up.url] }, websocket: { enabled: true } }]);
    base = await listen(app);

    const res = await rejectedHandshake(wsUrl(base, '/elsewhere'));

    expect(res.statusCode).toBe(404);
    expect(up.handshakes).toHaveLength(0);
  });

  it('answers 400 on a route that has not opted in to WebSocket — and never touches the upstream', async () => {
    const up = await upstream();
    await gateway([up.url], { websocket: false });

    const res = await rejectedHandshake(wsUrl(base, '/chat'));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'websocket_not_enabled' });
    expect(up.handshakes).toHaveLength(0);
  });

  it('answers 400 to an Upgrade that is not WebSocket', async () => {
    const up = await upstream();
    await gateway([up.url]);

    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${base}/chat`, { headers: { connection: 'Upgrade', upgrade: 'h2c' } });
      req.on('response', (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });

    expect(status).toBe(400);
    expect(up.handshakes).toHaveLength(0);
  });

  it('answers 400 to a malformed handshake before it ever contacts the upstream', async () => {
    const up = await upstream();
    await gateway([up.url]);

    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(`${base}/chat`, {
        headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13' }, // no Sec-WebSocket-Key
      });
      req.on('response', (r) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => resolve({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject);
      req.end();
    });

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'bad_handshake' });
    expect(up.handshakes).toHaveLength(0);
  });

  it('enforces websocket.origins for browsers, but lets an origin-less (server-side) client through', async () => {
    const up = await upstream();
    await gateway([up.url], { websocket: { origins: ['https://app.example.com'] } });

    const evil = await rejectedHandshake(wsUrl(base, '/chat'), { origin: 'https://evil.example.com' });
    const good = await open('/chat', undefined, { origin: 'https://app.example.com' });
    const noOrigin = await open('/chat');

    expect(evil.statusCode).toBe(403);
    expect(JSON.parse(evil.body)).toMatchObject({ error: 'origin_not_allowed' });
    expect(good.readyState).toBe(WsClient.OPEN);
    expect(noOrigin.readyState).toBe(WsClient.OPEN);
  });
});

describe('upstream failures during the handshake', () => {
  it('relays the upstream\'s own refusal — a real 401 with its body, not an open-then-close', async () => {
    const up = await upstream({ reject: { status: 401, body: 'nope' } });
    await gateway([up.url]);

    const res = await rejectedHandshake(wsUrl(base, '/chat'));

    expect(res.statusCode).toBe(401);
    expect(res.body).toBe('nope');
  });

  it('answers 502 when the upstream refuses the connection', async () => {
    await gateway([await deadUrl()]);

    const res = await rejectedHandshake(wsUrl(base, '/chat'));

    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'bad_gateway' });
  });

  it('answers 504 when the upstream never completes the handshake within timeoutMs', async () => {
    const up = await upstream({ hangHandshake: true });
    await gateway([up.url], { route: { upstream: { targets: [up.url], timeoutMs: 300 } } });

    const res = await rejectedHandshake(wsUrl(base, '/chat'));

    expect(res.statusCode).toBe(504);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'upstream_timeout' });
  });

  it('a refusing (5xx) upstream trips the circuit breaker just as it does for plain HTTP', async () => {
    const up = await upstream({ reject: { status: 503 } });
    await gateway([up.url], { route: { circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 60_000 } } });

    const first = await rejectedHandshake(wsUrl(base, '/chat'));
    const second = await rejectedHandshake(wsUrl(base, '/chat'));

    expect(first.statusCode).toBe(503); // the upstream's own answer
    expect(JSON.parse(second.body)).toMatchObject({ error: 'service_unavailable' }); // the gateway, breaker open
    expect(up.handshakes).toHaveLength(1);
  });

  it('spreads handshakes across targets round-robin', async () => {
    const a = await upstream();
    const b = await upstream();
    await gateway([a.url, b.url]);

    for (let i = 0; i < 4; i++) await open();

    expect(a.handshakes).toHaveLength(2);
    expect(b.handshakes).toHaveLength(2);
  });

  it('releases the upstream connection when the client gives up mid-handshake', async () => {
    const up = await upstream({ hangHandshake: true });
    await gateway([up.url], { route: { upstream: { targets: [up.url], timeoutMs: 10_000 } } });

    const ws = new WsClient(wsUrl(base, '/chat'));
    ws.on('error', () => {});
    await waitFor(() => up.handshakes.length === 1);
    ws.terminate();

    await waitFor(() => up.handshakes[0]!.socket.destroyed);
  });
});

describe('closing', () => {
  it('passes a close code and reason from the upstream through to the client', async () => {
    const up = await upstream({ onConnection: (ws) => setTimeout(() => ws.close(4001, 'bye'), 20) });
    await gateway([up.url]);
    const ws = await open();

    expect(await nextClose(ws)).toEqual({ code: 4001, reason: 'bye' });
  });

  it('passes a close code and reason from the client through to the upstream', async () => {
    const up = await upstream();
    await gateway([up.url]);
    const ws = await open();
    const upstreamClosed = nextClose(up.sockets[0]!);

    ws.close(4002, 'done');

    expect(await upstreamClosed).toEqual({ code: 4002, reason: 'done' });
  });

  it('maps a close with no code to a code-less close on the other side', async () => {
    const up = await upstream();
    await gateway([up.url]);
    const ws = await open();
    const upstreamClosed = nextClose(up.sockets[0]!);

    ws.close();

    expect((await upstreamClosed).code).toBe(1005);
  });

  it('an abrupt upstream drop closes the client too', async () => {
    const up = await upstream();
    await gateway([up.url]);
    const ws = await open();
    const closed = nextClose(ws);

    up.sockets[0]!.terminate();

    expect((await closed).code).toBe(1006);
  });

  it('closes every open connection with 1001 on shutdown and shuts down promptly', async () => {
    const up = await upstream();
    await gateway([up.url]);
    const a = await open();
    const b = await open();
    const closedA = nextClose(a);
    const closedB = nextClose(b);

    const started = Date.now();
    await app!.close();
    app = undefined;

    expect(await closedA).toEqual({ code: 1001, reason: 'Going Away' });
    expect(await closedB).toEqual({ code: 1001, reason: 'Going Away' });
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it('refuses new handshakes with 503 while shutdown is in progress', async () => {
    const up = await upstream();
    await gateway([up.url]);
    const stubborn = await open();
    // A client that stops reading never acknowledges the close, so shutdown waits
    // out its grace period — a deterministic window in which the gateway is closing.
    (stubborn as unknown as { _socket: { pause(): void } })._socket.pause();

    const closing = app!.close();
    await sleep(100);
    const res = await rejectedHandshake(wsUrl(base, '/chat'));
    await closing;
    app = undefined;

    // Fastify itself answers 503 to anything arriving once close() has begun.
    expect(res.statusCode).toBe(503);
  }, 10_000);
});

describe('limits', () => {
  it('applies the route rateLimit to the handshake', async () => {
    const up = await upstream();
    await gateway([up.url], { route: { rateLimit: { algorithm: 'slidingWindowLog', keyBy: ['ip'], limit: 1, windowSec: 60 } } });

    await open();
    const second = await rejectedHandshake(wsUrl(base, '/chat'));

    expect(second.statusCode).toBe(429);
    expect(second.headers['retry-after']).toBeDefined();
    expect(JSON.parse(second.body)).toMatchObject({ error: 'rate_limit_exceeded' });
  });

  it('caps concurrent connections per route, and frees a slot when one closes', async () => {
    const up = await upstream();
    await gateway([up.url], { websocket: { maxConnections: 1 } });
    const first = await open();

    const refused = await rejectedHandshake(wsUrl(base, '/chat'));
    expect(refused.statusCode).toBe(503);
    expect(JSON.parse(refused.body)).toMatchObject({ error: 'websocket_capacity' });

    first.close();
    await waitFor(async () => {
      try {
        await open();
        return true;
      } catch {
        return false;
      }
    });
  });

  it('closes a connection with 1008 when it exceeds the per-connection message rate limit', async () => {
    const up = await upstream();
    await gateway([up.url], {
      websocket: { messageRateLimit: { algorithm: 'slidingWindowLog', limit: 3, windowSec: 60 } },
    });
    const ws = await open();
    const closed = nextClose(ws);

    for (let i = 0; i < 6; i++) ws.send(`m${i}`);

    expect((await closed).code).toBe(1008);
    // Only the three within budget were relayed. (Replies to them may be cut off: the gateway closes
    // the whole connection the moment the limit is crossed.)
    expect(up.received.map((m) => m.data.toString())).toEqual(['m0', 'm1', 'm2']); // the 4th never reached the upstream
  });

  it('counts messages per connection, not per client — a second connection gets its own budget', async () => {
    const up = await upstream();
    await gateway([up.url], {
      websocket: { messageRateLimit: { algorithm: 'slidingWindowLog', limit: 2, windowSec: 60 } },
    });
    const a = await open();
    const b = await open();
    const echoedB: string[] = [];
    b.on('message', (d) => echoedB.push(d.toString()));

    a.send('1');
    a.send('2');
    a.send('3'); // a is over budget
    b.send('x');
    b.send('y');
    await waitFor(() => echoedB.length === 2);

    expect(echoedB).toEqual(['x', 'y']);
  });

  it('closes with 1009 when a client message exceeds maxMessageBytes, and nothing reaches the upstream', async () => {
    const up = await upstream();
    await gateway([up.url], { websocket: { maxMessageBytes: 1024 } });
    const ws = await open();
    ws.on('error', () => {});
    const closed = nextClose(ws);

    ws.send(Buffer.alloc(4096, 1));

    expect((await closed).code).toBe(1009);
    expect(up.received).toHaveLength(0);
  });

  it('closes when the UPSTREAM sends a message over maxMessageBytes', async () => {
    const up = await upstream({ onConnection: (ws) => ws.send(Buffer.alloc(4096, 2)) });
    await gateway([up.url], { websocket: { maxMessageBytes: 1024 } });
    const ws = new WsClient(wsUrl(base, '/chat'));
    clients.push(ws);
    ws.on('error', () => {});
    const messages: unknown[] = [];
    ws.on('message', (d) => messages.push(d));

    await nextClose(ws);

    expect(messages).toHaveLength(0);
  });

  it('is not subject to server.requestTimeoutMs — a long-lived connection outlives it', async () => {
    const up = await upstream();
    await gateway([up.url], { config: { server: { requestTimeoutMs: 300 } } });
    const ws = await open();

    await sleep(900);
    ws.send('still here?');

    expect((await nextMessage(ws)).data.toString()).toBe('still here?');
  });
});

describe('keeping connections honest', () => {
  it('pings both sides; a well-behaved connection survives many intervals', async () => {
    const up = await upstream();
    await gateway([up.url], { websocket: { pingIntervalMs: 40 } });
    const ws = await open();
    let pings = 0;
    ws.on('ping', () => pings++);

    await sleep(400);
    ws.send('alive');

    expect((await nextMessage(ws)).data.toString()).toBe('alive');
    expect(pings).toBeGreaterThanOrEqual(3);
  });

  it('cuts a peer that stops answering pings (a dead client does not hold its slot forever)', async () => {
    const up = await upstream();
    await gateway([up.url], { websocket: { pingIntervalMs: 60 } });
    const ws = await open('/chat', undefined, { autoPong: false });
    const closed = nextClose(ws);
    const upstreamClosed = nextClose(up.sockets[0]!);

    expect((await closed).code).toBe(1006);
    await upstreamClosed;
    await waitFor(async () => (await metricsText()).includes('apigate_websocket_closed_total{route="ws",reason="dead_peer"} 1'));
  });

  it('closes an idle connection with 1001, but activity in either direction resets the clock', async () => {
    const up = await upstream();
    await gateway([up.url], { websocket: { idleTimeoutMs: 250, pingIntervalMs: 0 } });
    const ws = await open();
    const closed = nextClose(ws);

    for (let i = 0; i < 5; i++) {
      await sleep(100);
      ws.send('keepalive');
    }
    expect(ws.readyState).toBe(WsClient.OPEN); // 500ms passed, yet still open

    expect(await closed).toEqual({ code: 1001, reason: 'Idle timeout' });
  });

  it('closes with 1013 rather than buffering without bound for a client that will not read', async () => {
    const up = await upstream({
      onConnection: (ws) => {
        for (let i = 0; i < 300; i++) ws.send(Buffer.alloc(64 * 1024, 7));
      },
    });
    await gateway([up.url], { websocket: { maxBufferedBytes: 256 * 1024, maxMessageBytes: 1024 * 1024, pingIntervalMs: 0 } });
    const ws = new WsClient(wsUrl(base, '/flood'));
    clients.push(ws);
    ws.on('error', () => {});
    await new Promise((resolve) => ws.once('open', resolve));
    (ws as unknown as { _socket: { pause(): void } })._socket.pause(); // stop reading: the gateway's send buffer must grow

    const closed = await Promise.race([nextClose(up.sockets[0]!), sleep(8000).then(() => undefined)]);

    expect(closed?.code).toBe(1013);
  });
});

// --- auth ------------------------------------------------------------------

let jwksServer: Server;
let jwksUrl: string;
let privateKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  jwksServer = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [{ ...jwk, kid: 'ws-test', alg: 'RS256', use: 'sig' }] }));
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
  jwksUrl = `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}/jwks.json`;
});

afterAll(() => {
  jwksServer.close();
});

const token = (tenant = 't1'): Promise<string> =>
  new SignJWT({ tenant_id: tenant })
    .setProtectedHeader({ alg: 'RS256', kid: 'ws-test' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);

describe('authentication on the handshake', () => {
  it('refuses a handshake with no token (401) — and never contacts the upstream', async () => {
    const up = await upstream();
    await gateway([up.url], { route: { auth: { type: 'jwt', jwksUrl } } });

    const res = await rejectedHandshake(wsUrl(base, '/chat'));

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'unauthorized' });
    expect(up.handshakes).toHaveLength(0);
  });

  it('accepts an Authorization header, and forwards it to the upstream', async () => {
    const up = await upstream();
    await gateway([up.url], { route: { auth: { type: 'jwt', jwksUrl } } });
    const jwt = await token();

    await open('/chat', undefined, { headers: { authorization: `Bearer ${jwt}` } });

    expect(up.handshakes[0]?.headers.authorization).toBe(`Bearer ${jwt}`);
  });

  it('accepts ?access_token= when websocket.queryToken is on — stripping it from the URL the upstream sees', async () => {
    const up = await upstream();
    await gateway([up.url], { route: { auth: { type: 'jwt', jwksUrl } }, websocket: { queryToken: true } });
    const jwt = await token();

    await open(`/chat?room=1&access_token=${jwt}&lang=tr`);

    const seen = up.handshakes[0]!;
    expect(seen.url).toBe('/chat?room=1&lang=tr'); // token gone, other params untouched
    expect(seen.headers.authorization).toBe(`Bearer ${jwt}`); // handed over as a header instead
  });

  it('ignores ?access_token= when queryToken is off (the default)', async () => {
    const up = await upstream();
    await gateway([up.url], { route: { auth: { type: 'jwt', jwksUrl } } });

    const res = await rejectedHandshake(wsUrl(base, `/chat?access_token=${await token()}`));

    expect(res.statusCode).toBe(401);
    expect(up.handshakes).toHaveLength(0);
  });

  it('prefers the Authorization header over ?access_token=, but still strips the query token', async () => {
    const up = await upstream();
    await gateway([up.url], { route: { auth: { type: 'jwt', jwksUrl } }, websocket: { queryToken: true } });
    const good = await token();

    await open(`/chat?access_token=garbage`, undefined, { headers: { authorization: `Bearer ${good}` } });

    expect(up.handshakes[0]?.url).toBe('/chat');
    expect(up.handshakes[0]?.headers.authorization).toBe(`Bearer ${good}`);
  });

  it('refuses an invalid ?access_token=', async () => {
    const up = await upstream();
    await gateway([up.url], { route: { auth: { type: 'jwt', jwksUrl } }, websocket: { queryToken: true } });

    const res = await rejectedHandshake(wsUrl(base, '/chat?access_token=not.a.jwt'));

    expect(res.statusCode).toBe(401);
  });

  it('feeds the token\'s tenant into the handshake rate limit', async () => {
    const up = await upstream();
    await gateway([up.url], {
      route: {
        auth: { type: 'jwt', jwksUrl },
        rateLimit: { algorithm: 'slidingWindowLog', keyBy: ['tenant'], limit: 1, windowSec: 60 },
      },
    });
    const a = { headers: { authorization: `Bearer ${await token('tenant-a')}` } };
    const b = { headers: { authorization: `Bearer ${await token('tenant-b')}` } };

    await open('/chat', undefined, a);
    const blocked = await rejectedHandshake(wsUrl(base, '/chat'), a);
    await open('/chat', undefined, b); // a different tenant has its own bucket

    expect(blocked.statusCode).toBe(429);
  });
});

describe('observability', () => {
  it('reports open connections, relayed messages, the 101 handshake, and how each connection ended', async () => {
    const up = await upstream();
    await gateway([up.url]);
    const ws = await open();

    ws.send('a');
    await nextMessage(ws);
    ws.send('b');
    await nextMessage(ws);
    const during = await metricsText();

    ws.close();
    await waitFor(async () => (await metricsText()).includes('apigate_websocket_connections{route="ws"} 0'));
    const after = await metricsText();

    expect(during).toContain('apigate_websocket_connections{route="ws"} 1');
    expect(during).toContain('apigate_websocket_messages_total{route="ws",direction="client_to_upstream"} 2');
    expect(during).toContain('apigate_websocket_messages_total{route="ws",direction="upstream_to_client"} 2');
    expect(during).toMatch(/apigate_requests_total\{[^}]*route="ws"[^}]*status="101"/);
    expect(after).toContain('apigate_websocket_closed_total{route="ws",reason="client"} 1');
  });

  it('records which side ended it when the upstream hangs up', async () => {
    const up = await upstream();
    await gateway([up.url]);
    const ws = await open();

    up.sockets[0]!.close(1000, 'done');
    await nextClose(ws);

    await waitFor(async () => (await metricsText()).includes('apigate_websocket_closed_total{route="ws",reason="upstream"} 1'));
  });
});

describe('plain HTTP on a WebSocket-enabled route', () => {
  it('is proxied as usual — one route can serve both HTTP and WebSocket', async () => {
    const up = await upstream({
      http: (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('plain http');
      },
    });
    await gateway([up.url]);

    const http = await fetch(`${base}/thing`);
    const ws = await open('/thing');
    ws.send('over ws');

    expect(await http.text()).toBe('plain http');
    expect((await nextMessage(ws)).data.toString()).toBe('over ws');
  });
});
