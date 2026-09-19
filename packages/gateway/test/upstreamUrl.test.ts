import { createConnection } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WsClient from 'ws';
import { joinUpstreamUrl } from '../src/proxy/upstreamUrl.js';
import { buildTestApp, listen, startUpstream, startWsUpstream, wsUrl, type TestUpstream, type TestWsUpstream } from './helpers.js';

describe('joinUpstreamUrl', () => {
  it('appends the path (and query) to the target', () => {
    expect(joinUpstreamUrl('http://svc:3000', '/users/42?page=2').href).toBe('http://svc:3000/users/42?page=2');
  });

  it('adds the leading slash a path is missing', () => {
    expect(joinUpstreamUrl('http://svc:3000', 'users').href).toBe('http://svc:3000/users');
  });

  it('keeps only the target origin — a base path in the target is not used (as before)', () => {
    expect(joinUpstreamUrl('http://svc:3000/base/', '/users').href).toBe('http://svc:3000/users');
  });

  // The SSRF: with `new URL(path, target)` every one of these changes the HOST.
  it.each([
    ['a scheme-relative //host', '//evil.example.com/x'],
    ['a scheme-relative //host:port', '//169.254.169.254:80/latest/meta-data'],
    ['a triple slash', '///evil.example.com/x'],
    ['a backslash (WHATWG treats it as a slash)', '/\\evil.example.com/x'],
    ['userinfo-looking text', '//user:pass@evil.example.com/x'],
    ['an @ right after the slash', '/@evil.example.com/x'],
    ['an absolute URL', 'http://evil.example.com/x'],
  ])('never lets %s change the host', (_label, path) => {
    const url = joinUpstreamUrl('http://svc:3000', path);

    expect(url.host).toBe('svc:3000');
    expect(url.protocol).toBe('http:');
    expect(url.username).toBe('');
  });

  it('keeps the target scheme (https stays https)', () => {
    expect(joinUpstreamUrl('https://svc', '//evil/x').origin).toBe('https://svc');
  });
});

// The same attack end to end, on real sockets: a raw request line that no HTTP
// client would produce, aimed at a second server the route never pointed at.
let app: FastifyInstance | undefined;
let target: TestUpstream | undefined;
let secret: TestUpstream | undefined;
let wsTarget: TestWsUpstream | undefined;
let wsSecret: TestWsUpstream | undefined;

afterEach(async () => {
  await app?.close();
  await Promise.all([target, secret, wsTarget, wsSecret].map((u) => u?.close()));
  app = target = secret = wsTarget = wsSecret = undefined;
});

function rawGet(port: number, requestTarget: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(port, '127.0.0.1', () => {
      socket.write(`GET ${requestTarget} HTTP/1.1\r\nHost: gw\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    socket.on('data', (chunk) => (data += chunk));
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}

describe('SSRF through the request path (regression)', () => {
  it('a //host/path request line reaches the CONFIGURED upstream as a path — never another host', async () => {
    target = await startUpstream((_req, res) => res.end('configured-upstream'));
    secret = await startUpstream((_req, res) => res.end('internal-secret'));
    app = await buildTestApp([{ id: 'r', match: { path: '/*' }, upstream: { targets: [target.url] } }]);
    const base = await listen(app);

    const response = await rawGet(Number(new URL(base).port), `//${new URL(secret.url).host}/steal`);

    expect(secret.requests).toHaveLength(0); // the internal service was never contacted
    expect(target.requests).toHaveLength(1);
    expect(target.requests[0]?.url).toBe(`//${new URL(secret.url).host}/steal`); // just a strange path, to the right host
    expect(response).toContain('configured-upstream');
    expect(response).not.toContain('internal-secret');
  });

  it('the same holds after stripPrefix (/api//host/x → //host/x)', async () => {
    target = await startUpstream((_req, res) => res.end('configured-upstream'));
    secret = await startUpstream((_req, res) => res.end('internal-secret'));
    app = await buildTestApp([
      { id: 'r', match: { path: '/api/*' }, rewrite: { stripPrefix: '/api' }, upstream: { targets: [target.url] } },
    ]);
    const base = await listen(app);

    await rawGet(Number(new URL(base).port), `/api//${new URL(secret.url).host}/steal`);

    expect(secret.requests).toHaveLength(0);
    expect(target.requests).toHaveLength(1);
  });

  it('a WebSocket handshake cannot be steered to another host either', async () => {
    wsTarget = await startWsUpstream();
    wsSecret = await startWsUpstream();
    app = await buildTestApp([
      { id: 'r', match: { path: '/*' }, upstream: { targets: [wsTarget.url] }, websocket: { enabled: true } },
    ]);
    const base = await listen(app);

    const ws = new WsClient(wsUrl(base, `//${new URL(wsSecret.url).host}/steal`));
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.terminate();

    expect(wsSecret.handshakes).toHaveLength(0);
    expect(wsTarget.handshakes).toHaveLength(1);
  });
});
