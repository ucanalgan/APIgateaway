import { randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import pg from 'pg';
import WsClient, { WebSocketServer, type ClientOptions as WsClientOptions } from 'ws';
import { gatewayConfigSchema } from '../src/config/schema.js';
import { createDbPool, runMigrations, type DbPool } from '../src/db/client.js';
import { buildServer } from '../src/server.js';

// Rate-limit tests that send a fixed number of requests and expect a 429 must NOT use
// the `fixedWindow` algorithm: its windows are aligned to the wall clock, so a
// test that happens to straddle a minute boundary gets a fresh counter and
// flakes. `slidingWindowLog` counts the trailing window from the request
// itself, so the outcome is deterministic for any test that finishes within it.

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export interface TestUpstream {
  readonly url: string;
  readonly requests: RecordedRequest[];
  close(): Promise<void>;
}

export type UpstreamHandler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

/** A real HTTP server on an ephemeral port that records every request it receives. */
export async function startUpstream(handler?: UpstreamHandler): Promise<TestUpstream> {
  const requests: RecordedRequest[] = [];

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });

      if (handler) {
        handler(req, res, body);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A URL nothing is listening on — grab a free port from a real server, then close it. */
export async function deadUrl(): Promise<string> {
  const upstream = await startUpstream();
  const { url } = upstream;
  await upstream.close();
  return url;
}

export async function buildTestApp(routes: unknown[], extra: Record<string, unknown> = {}): Promise<FastifyInstance> {
  const config = gatewayConfigSchema.parse({ routes, ...extra });
  return buildServer(config, 'unused.yaml');
}

/** Starts the app on a real ephemeral port (for tests that need real sockets, not app.inject). */
export async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(25);
  }
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}

export const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

export async function redisReachable(): Promise<boolean> {
  const probe = new Redis(REDIS_URL, { lazyConnect: true, retryStrategy: () => null, connectTimeout: 1000 });
  probe.on('error', () => {});
  try {
    await probe.connect();
    return true;
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

const POSTGRES_ADMIN_URL = process.env['POSTGRES_URL'] ?? 'postgres://postgres:postgres@localhost:5432/postgres';

export interface TestDatabase {
  readonly pool: DbPool;
  readonly url: string;
  drop(): Promise<void>;
}

/** A throwaway, fully-migrated database on a real Postgres — `undefined` if none is reachable. */
export async function createTestDatabase(): Promise<TestDatabase | undefined> {
  const name = `apigate_test_${randomUUID().replace(/-/g, '')}`;

  try {
    const admin = new pg.Client({ connectionString: POSTGRES_ADMIN_URL, connectionTimeoutMillis: 1000 });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
    await admin.end();

    const dbUrl = new URL(POSTGRES_ADMIN_URL);
    dbUrl.pathname = `/${name}`;
    const pool = createDbPool(dbUrl.toString());
    await runMigrations(pool);

    return {
      pool,
      url: dbUrl.toString(),
      async drop() {
        await pool.end();
        const cleanup = new pg.Client({ connectionString: POSTGRES_ADMIN_URL });
        await cleanup.connect();
        await cleanup.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
        await cleanup.end();
      },
    };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// WebSocket helpers — a real `ws` server as the upstream, real `ws` clients.
// ---------------------------------------------------------------------------

export interface WsUpstreamOptions {
  /** Picks the sub-protocol (or `false` for none) from what the client offered. */
  readonly protocols?: (offered: Set<string>) => string | false;
  /** Answer the handshake with a plain HTTP response instead of upgrading. */
  readonly reject?: { readonly status: number; readonly body?: string };
  /** Accept the TCP connection but never answer the handshake. */
  readonly hangHandshake?: boolean;
  /** Plain HTTP requests (non-upgrade) to the same server; without it they hang. */
  readonly http?: (req: IncomingMessage, res: ServerResponse) => void;
  /** Called for each accepted connection; the default echoes every message back unchanged. */
  readonly onConnection?: (ws: WsClient, request: IncomingMessage) => void;
}

export interface WsUpstreamMessage {
  readonly data: Buffer;
  readonly isBinary: boolean;
}

export interface TestWsUpstream {
  /** http:// URL — what a route's `upstream.targets` takes. */
  readonly url: string;
  readonly handshakes: IncomingMessage[];
  readonly sockets: WsClient[];
  readonly received: WsUpstreamMessage[];
  close(): Promise<void>;
}

export async function startWsUpstream(options: WsUpstreamOptions = {}): Promise<TestWsUpstream> {
  const handshakes: IncomingMessage[] = [];
  const sockets: WsClient[] = [];
  const received: WsUpstreamMessage[] = [];
  // Sockets that emitted 'upgrade' are detached from the http server, so
  // `closeAllConnections()` no longer reaches them — track them to clean up.
  const rawSockets = new Set<Duplex>();

  const wss = new WebSocketServer({
    noServer: true,
    ...(options.protocols ? { handleProtocols: options.protocols } : {}),
  });
  const server = options.http ? createServer(options.http) : createServer();

  server.on('upgrade', (req, socket, head) => {
    handshakes.push(req);
    rawSockets.add(socket);
    socket.once('close', () => rawSockets.delete(socket));

    if (options.hangHandshake) {
      // Never answer, but do notice when the peer gives up.
      socket.on('end', () => socket.destroy());
      socket.resume();
      return;
    }
    if (options.reject) {
      const body = options.reject.body ?? '';
      socket.end(
        `HTTP/1.1 ${options.reject.status} Rejected\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
      );
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.push(ws);
      if (options.onConnection) {
        options.onConnection(ws, req);
        return;
      }
      ws.on('message', (data, isBinary) => {
        received.push({ data: data as Buffer, isBinary });
        ws.send(data as Buffer, { binary: isBinary });
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    handshakes,
    sockets,
    received,
    close: async () => {
      for (const ws of sockets) ws.terminate();
      for (const socket of rawSockets) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      wss.close();
    },
  };
}

/** `http://host:port` (what `listen(app)` returns) → `ws://host:port/path`. */
export const wsUrl = (base: string, path: string): string => base.replace(/^http/, 'ws') + path;

export function connectWs(url: string, protocols?: string[], options: WsClientOptions = {}): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WsClient(url, protocols ?? [], options);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/** Attempts a handshake that must be refused; resolves with the HTTP response the gateway sent. */
export function rejectedHandshake(
  url: string,
  options: WsClientOptions = {},
): Promise<{ statusCode: number; body: string; headers: IncomingMessage['headers'] }> {
  return new Promise((resolve, reject) => {
    const ws = new WsClient(url, [], options);
    ws.on('error', reject); // a refused/reset connection must fail the test, not hang it
    ws.once('open', () => {
      ws.terminate();
      reject(new Error('handshake unexpectedly succeeded'));
    });
    ws.once('unexpected-response', (_req, res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers });
        ws.terminate();
      });
    });
  });
}

export const nextMessage = (ws: WsClient): Promise<{ data: Buffer; isBinary: boolean }> =>
  new Promise((resolve) => ws.once('message', (data, isBinary) => resolve({ data: data as Buffer, isBinary })));

export const nextClose = (ws: WsClient): Promise<{ code: number; reason: string }> =>
  new Promise((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString('utf8') })));
