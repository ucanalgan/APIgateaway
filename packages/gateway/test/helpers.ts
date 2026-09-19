import { randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import pg from 'pg';
import { gatewayConfigSchema } from '../src/config/schema.js';
import { createDbPool, runMigrations, type DbPool } from '../src/db/client.js';
import { buildServer } from '../src/server.js';

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
