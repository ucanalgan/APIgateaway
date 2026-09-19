import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { gatewayConfigSchema } from '../src/config/schema.js';
import { buildTestApp, listen, startUpstream, waitFor, type TestUpstream } from './helpers.js';

// Server-Sent Events: a response that stays open and can go quiet for a long
// time between events. Real sockets throughout — `app.inject` cannot model a
// client that reads slowly or hangs up mid-stream.
let app: FastifyInstance | undefined;
let up: TestUpstream | undefined;

afterEach(async () => {
  await app?.close();
  await up?.close();
  app = undefined;
  up = undefined;
});

/** One event now, a second one after `silenceMs` of complete silence, then the stream ends. */
function sseUpstream(silenceMs: number) {
  return startUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write('data: one\n\n');
    setTimeout(() => {
      res.write('data: two\n\n');
      res.end();
    }, silenceMs);
  });
}

async function readAll(url: string): Promise<{ events: string[]; error?: string }> {
  const events: string[] = [];
  try {
    const res = await fetch(url);
    const reader = res.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      events.push(new TextDecoder().decode(value).trim());
    }
    return { events };
  } catch (err) {
    return { events, error: (err as Error).message };
  }
}

describe('config: upstream.bodyTimeoutMs', () => {
  const parse = (bodyTimeoutMs: unknown) =>
    gatewayConfigSchema.safeParse({
      routes: [{ id: 'r', match: { path: '/*' }, upstream: { targets: ['http://u'], bodyTimeoutMs } }],
    });

  it('accepts 0 (no limit) and positive values, rejects negatives', () => {
    expect(parse(0).success).toBe(true);
    expect(parse(30_000).success).toBe(true);
    expect(parse(-1).success).toBe(false);
  });
});

describe('SSE through the gateway', () => {
  it('a stream that goes quiet for longer than timeoutMs is cut mid-way by default', async () => {
    up = await sseUpstream(3500);
    app = await buildTestApp([{ id: 'r', match: { path: '/*' }, upstream: { targets: [up.url], timeoutMs: 1000 } }]);
    const base = await listen(app);

    const result = await readAll(`${base}/events`);

    expect(result.events).toEqual(['data: one']);
    expect(result.error).toBeDefined();
  });

  it('bodyTimeoutMs: 0 lets the same stream stay quiet as long as it likes', async () => {
    up = await sseUpstream(3500);
    app = await buildTestApp([
      { id: 'r', match: { path: '/*' }, upstream: { targets: [up.url], timeoutMs: 1000, bodyTimeoutMs: 0 } },
    ]);
    const base = await listen(app);

    const result = await readAll(`${base}/events`);

    expect(result.error).toBeUndefined();
    expect(result.events.join('')).toBe('data: one' + 'data: two');
  });

  it('bodyTimeoutMs does not loosen the response-header timeout — a hung upstream is still a 504', async () => {
    up = await startUpstream(() => {
      /* never answers */
    });
    app = await buildTestApp([
      { id: 'r', match: { path: '/*' }, upstream: { targets: [up.url], timeoutMs: 300, bodyTimeoutMs: 0 } },
    ]);

    const res = await app.inject({ method: 'GET', url: '/x' });

    expect(res.statusCode).toBe(504);
  });

  it('stops pulling from the upstream when the client hangs up (no leaked upstream connection)', async () => {
    let upstreamSawClose = false;
    up = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const timer = setInterval(() => res.write('data: tick\n\n'), 50);
      res.on('close', () => {
        upstreamSawClose = true;
        clearInterval(timer);
      });
    });
    app = await buildTestApp([
      { id: 'r', match: { path: '/*' }, upstream: { targets: [up.url], bodyTimeoutMs: 0 } },
    ]);
    const base = await listen(app);

    const controller = new AbortController();
    const res = await fetch(`${base}/events`, { signal: controller.signal });
    await res.body!.getReader().read(); // got the first event
    controller.abort();

    await waitFor(() => upstreamSawClose);
  });
});
