import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { gatewayConfigSchema } from '../src/config/schema.js';
import { serializeRequest } from '../src/observability/logger.js';
import { createWebSocketRegistry, type TrackedConnection } from '../src/websocket/registry.js';
import { extractQueryToken, redactUrl, stripQueryParam } from '../src/websocket/url.js';

describe('extractQueryToken', () => {
  it('reads access_token from the query string', () => {
    expect(extractQueryToken('/chat?access_token=abc.def')).toBe('abc.def');
    expect(extractQueryToken('/chat?room=1&access_token=abc&lang=tr')).toBe('abc');
  });

  it('decodes a percent-encoded value', () => {
    expect(extractQueryToken('/chat?access_token=a%2Fb%3D')).toBe('a/b=');
  });

  it('returns undefined when absent, empty, or when only a differently-named parameter matches', () => {
    expect(extractQueryToken('/chat')).toBeUndefined();
    expect(extractQueryToken('/chat?room=1')).toBeUndefined();
    expect(extractQueryToken('/chat?access_token=')).toBeUndefined();
    expect(extractQueryToken('/chat?access_token')).toBeUndefined();
    expect(extractQueryToken('/chat?access_token_extra=nope&xaccess_token=nope')).toBeUndefined();
  });

  it('matches a percent-encoded parameter NAME too (no bypass by encoding the key)', () => {
    expect(extractQueryToken('/chat?access%5Ftoken=abc')).toBe('abc');
  });
});

describe('stripQueryParam', () => {
  it('removes the parameter wherever it sits, leaving the others byte-for-byte alone', () => {
    expect(stripQueryParam('/chat?access_token=X&room=1')).toBe('/chat?room=1');
    expect(stripQueryParam('/chat?room=1&access_token=X&lang=tr')).toBe('/chat?room=1&lang=tr');
    expect(stripQueryParam('/chat?room=1&access_token=X')).toBe('/chat?room=1');
    expect(stripQueryParam('/chat?q=a%20b+c&access_token=X')).toBe('/chat?q=a%20b+c'); // no re-encoding
  });

  it('drops the "?" entirely when it was the only parameter', () => {
    expect(stripQueryParam('/chat?access_token=X')).toBe('/chat');
  });

  it('removes every occurrence, and is a no-op without the parameter', () => {
    expect(stripQueryParam('/chat?access_token=A&x=1&access_token=B')).toBe('/chat?x=1');
    expect(stripQueryParam('/chat?x=1')).toBe('/chat?x=1');
    expect(stripQueryParam('/chat')).toBe('/chat');
  });

  it('removes a valueless or percent-encoded-name occurrence as well', () => {
    expect(stripQueryParam('/chat?access_token&x=1')).toBe('/chat?x=1');
    expect(stripQueryParam('/chat?access%5Ftoken=X&x=1')).toBe('/chat?x=1');
  });
});

describe('redactUrl', () => {
  it('masks the token value and nothing else', () => {
    expect(redactUrl('/chat?room=1&access_token=SECRET&lang=tr')).toBe('/chat?room=1&access_token=[redacted]&lang=tr');
  });

  it('leaves a URL with no token untouched', () => {
    expect(redactUrl('/chat')).toBe('/chat');
    expect(redactUrl('/chat?room=1')).toBe('/chat?room=1');
  });

  it('masks every occurrence', () => {
    expect(redactUrl('/c?access_token=A&access_token=B')).toBe('/c?access_token=[redacted]&access_token=[redacted]');
  });
});

describe('log request serializer', () => {
  it('logs the same fields as Fastify\'s default, with the token masked', () => {
    const request = {
      method: 'GET',
      url: '/chat?access_token=SECRET-TOKEN&room=1',
      host: 'gw.example.com',
      ip: '203.0.113.9',
      socket: { remotePort: 4242 },
    } as unknown as FastifyRequest;

    const logged = serializeRequest(request);

    expect(logged).toEqual({
      method: 'GET',
      url: '/chat?access_token=[redacted]&room=1',
      host: 'gw.example.com',
      remoteAddress: '203.0.113.9',
      remotePort: 4242,
    });
    expect(JSON.stringify(logged)).not.toContain('SECRET-TOKEN');
  });
});

describe('websocket registry', () => {
  function tracked(routeId: string, onShutdown: (self: TrackedConnection) => void = () => {}) {
    const state = { shutdownCalls: 0, terminateCalls: 0 };
    const connection: TrackedConnection = {
      routeId,
      shutdown: () => {
        state.shutdownCalls++;
        onShutdown(connection);
      },
      terminate: () => {
        state.terminateCalls++;
      },
    };
    return { connection, state };
  }

  it('counts connections per route', () => {
    const registry = createWebSocketRegistry();
    const a1 = tracked('a').connection;
    const a2 = tracked('a').connection;
    const b1 = tracked('b').connection;
    [a1, a2, b1].forEach((c) => registry.add(c));

    expect(registry.countFor('a')).toBe(2);
    expect(registry.countFor('b')).toBe(1);
    expect(registry.countFor('none')).toBe(0);
    expect(registry.size()).toBe(3);

    registry.remove(a1);
    expect(registry.countFor('a')).toBe(1);
  });

  it('closeAll asks everyone to shut down and returns as soon as they have left', async () => {
    const registry = createWebSocketRegistry();
    const polite = tracked('a', (self) => registry.remove(self));
    registry.add(polite.connection);

    const started = Date.now();
    await registry.closeAll(5_000);

    expect(polite.state.shutdownCalls).toBe(1);
    expect(polite.state.terminateCalls).toBe(0);
    expect(Date.now() - started).toBeLessThan(1_000); // did not wait out the grace period
  });

  it('closeAll cuts anything still open once the grace period is up', async () => {
    const registry = createWebSocketRegistry();
    const stubborn = tracked('a'); // never removes itself
    registry.add(stubborn.connection);

    await registry.closeAll(60);

    expect(stubborn.state.shutdownCalls).toBe(1);
    expect(stubborn.state.terminateCalls).toBe(1);
  });
});

describe('route websocket config', () => {
  const parse = (websocket: unknown) =>
    gatewayConfigSchema.safeParse({
      routes: [{ id: 'r', match: { path: '/*' }, upstream: { targets: ['http://u'] }, websocket }],
    });

  it('is opt-in, with safe defaults for everything else', () => {
    const result = parse({ enabled: true });
    expect(result.success).toBe(true);
    expect(result.data?.routes[0]?.websocket).toEqual({
      enabled: true,
      queryToken: false,
      maxConnections: 1000,
      maxMessageBytes: 1_048_576,
      maxBufferedBytes: 4_194_304,
      pingIntervalMs: 30_000,
      idleTimeoutMs: 0,
    });
  });

  it('a route with no websocket block has none', () => {
    const result = gatewayConfigSchema.parse({ routes: [{ id: 'r', match: { path: '/*' }, upstream: { targets: ['http://u'] } }] });
    expect(result.routes[0]?.websocket).toBeUndefined();
  });

  it('accepts a full configuration, including a message rate limit', () => {
    expect(
      parse({
        enabled: true,
        origins: ['https://app.example.com'],
        queryToken: true,
        maxConnections: 50,
        pingIntervalMs: 0,
        idleTimeoutMs: 60_000,
        messageRateLimit: { algorithm: 'slidingWindowLog', limit: 100, windowSec: 10, burst: 20 },
      }).success,
    ).toBe(true);
  });

  it.each([
    ['a non-positive maxConnections', { enabled: true, maxConnections: 0 }],
    ['a negative pingIntervalMs', { enabled: true, pingIntervalMs: -1 }],
    ['an empty origins list', { enabled: true, origins: [] }],
    ['a message rate limit with no limit', { enabled: true, messageRateLimit: { windowSec: 10 } }],
    ['an unknown message-limit algorithm', { enabled: true, messageRateLimit: { algorithm: 'nope', limit: 1, windowSec: 1 } }],
  ])('rejects %s', (_label, websocket) => {
    expect(parse(websocket).success).toBe(false);
  });
});
