import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { hashApiKey } from '@apigate/core/auth';
import { apiKeyCacheKey } from '../src/auth/index.js';
import { createPlan } from '../src/db/repositories/plans.js';
import { createTenant, setTenantStatus } from '../src/db/repositories/tenants.js';
import { createApiKey, revokeApiKey } from '../src/db/repositories/apiKeys.js';
import {
  REDIS_URL,
  buildTestApp,
  createTestDatabase,
  redisReachable,
  sleep,
  startUpstream,
  waitFor,
  type TestUpstream,
} from './helpers.js';

// Real Postgres (throwaway database) and — where noted — real Redis. The
// gateway runs its own migrations against the database, exactly as in prod.
const db = await createTestDatabase();
const redisAvailable = await redisReachable();

let app: FastifyInstance | undefined;
let up: TestUpstream | undefined;

afterEach(async () => {
  await app?.close();
  await up?.close();
  app = undefined;
  up = undefined;
});

afterAll(async () => {
  await db?.drop();
});

async function seed(plan: { rateLimit: number; burst?: number } = { rateLimit: 1000 }, keyOpts: { expiresAt?: Date } = {}) {
  const p = await createPlan(db!.pool, {
    name: `plan-${randomUUID()}`,
    rateLimit: plan.rateLimit,
    windowSec: 60,
    burst: plan.burst ?? plan.rateLimit,
  });
  const tenant = await createTenant(db!.pool, { name: `tenant-${randomUUID()}`, planId: p.id });
  const key = await createApiKey(db!.pool, { tenantId: tenant.id, ...keyOpts });
  return { tenant, key };
}

async function gateway(extra: Record<string, unknown> = {}): Promise<FastifyInstance> {
  up = await startUpstream();
  app = await buildTestApp(
    [
      {
        id: 'api',
        match: { path: '/api/*' },
        upstream: { targets: [up.url] },
        auth: { type: 'apiKey' },
        // Static route limit is deliberately huge: the plan's limit must be what applies.
        rateLimit: { algorithm: 'fixedWindow', keyBy: ['tenant'], limit: 1000, windowSec: 60 },
      },
    ],
    { db: { url: db!.url }, ...extra },
  );
  return app;
}

const bearer = (raw: string) => ({ authorization: `Bearer ${raw}` });

describe.skipIf(!db)('API key auth (real Postgres)', () => {
  it('accepts a valid key and proxies the request', async () => {
    const { key } = await seed();
    const gw = await gateway();

    const res = await gw.inject({ method: 'GET', url: '/api/x', headers: bearer(key.raw) });

    expect(res.statusCode).toBe(200);
    expect(up!.requests).toHaveLength(1);
  });

  it('answers 401 for a missing header, a non-Bearer scheme, and an unknown key', async () => {
    await seed();
    const gw = await gateway();

    for (const headers of [{}, { authorization: 'Basic abc' }, bearer('ag_live_' + 'x'.repeat(32))]) {
      const res = await gw.inject({ method: 'GET', url: '/api/x', headers });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: 'unauthorized' });
    }
    expect(up!.requests).toHaveLength(0);
  });

  it('applies the tenant\'s PLAN limit, not the route\'s static one', async () => {
    const { key } = await seed({ rateLimit: 2 });
    const gw = await gateway();

    const first = await gw.inject({ method: 'GET', url: '/api/x', headers: bearer(key.raw) });
    await gw.inject({ method: 'GET', url: '/api/x', headers: bearer(key.raw) });
    const third = await gw.inject({ method: 'GET', url: '/api/x', headers: bearer(key.raw) });

    expect(first.headers['ratelimit-limit']).toBe('2');
    expect(third.statusCode).toBe(429);
  });

  it('gives two tenants on different plans different quotas on the same route', async () => {
    const free = await seed({ rateLimit: 1 });
    const pro = await seed({ rateLimit: 3 });
    const gw = await gateway();

    const freeStatuses = [];
    const proStatuses = [];
    for (let i = 0; i < 3; i++) {
      freeStatuses.push((await gw.inject({ method: 'GET', url: '/api/x', headers: bearer(free.key.raw) })).statusCode);
      proStatuses.push((await gw.inject({ method: 'GET', url: '/api/x', headers: bearer(pro.key.raw) })).statusCode);
    }

    expect(freeStatuses).toEqual([200, 429, 429]);
    expect(proStatuses).toEqual([200, 200, 200]);
  });

  it('rejects a revoked key', async () => {
    const { key } = await seed();
    const gw = await gateway();
    expect((await gw.inject({ method: 'GET', url: '/api/x', headers: bearer(key.raw) })).statusCode).toBe(200);

    await revokeApiKey(db!.pool, key.id);

    expect((await gw.inject({ method: 'GET', url: '/api/x', headers: bearer(key.raw) })).statusCode).toBe(401);
  });

  it('rejects an expired key', async () => {
    const { key } = await seed({ rateLimit: 1000 }, { expiresAt: new Date(Date.now() - 60_000) });
    const gw = await gateway();

    expect((await gw.inject({ method: 'GET', url: '/api/x', headers: bearer(key.raw) })).statusCode).toBe(401);
  });

  it('rejects every key of a suspended tenant', async () => {
    const { tenant, key } = await seed();
    await setTenantStatus(db!.pool, tenant.id, 'suspended');
    const gw = await gateway();

    expect((await gw.inject({ method: 'GET', url: '/api/x', headers: bearer(key.raw) })).statusCode).toBe(401);
  });

  it('records last_used_at in the background after a successful auth', async () => {
    const { key } = await seed();
    const gw = await gateway();

    await gw.inject({ method: 'GET', url: '/api/x', headers: bearer(key.raw) });

    await waitFor(async () => {
      const { rows } = await db!.pool.query<{ last_used_at: Date | null }>(
        'SELECT last_used_at FROM api_keys WHERE id = $1',
        [key.id],
      );
      return rows[0]?.last_used_at !== null;
    });
  });

  it('buffers usage records and flushes them to Postgres on shutdown', async () => {
    const { tenant, key } = await seed();
    const gw = await gateway();

    await gw.inject({ method: 'GET', url: '/api/a', headers: bearer(key.raw) });
    await gw.inject({ method: 'GET', url: '/api/b', headers: bearer(key.raw) });
    await sleep(50); // onResponse (where usage is pushed) runs just after the reply is sent
    await gw.close();
    app = undefined;

    const { rows } = await db!.pool.query<{ n: number; route_id: string }>(
      'SELECT count(*)::int AS n, min(route_id) AS route_id FROM usage_records WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(rows[0]).toMatchObject({ n: 2, route_id: 'api' });
  });

  it('degrades to Postgres when the Redis auth cache is unreachable — auth keeps working', async () => {
    const { key } = await seed();
    const gw = await gateway({ redis: { url: 'redis://127.0.0.1:1', failOpen: true } });

    const res = await gw.inject({ method: 'GET', url: '/api/x', headers: bearer(key.raw) });

    expect(res.statusCode).toBe(200);
  });
});

describe.skipIf(!db || !redisAvailable)('API key auth cache (real Postgres + real Redis)', () => {
  it('caches a verified key in Redis, so a DB-side revoke stays invisible until the entry is invalidated', async () => {
    const { key } = await seed();
    const gw = await gateway({ redis: { url: REDIS_URL } });
    const cacheKey = apiKeyCacheKey(hashApiKey(key.raw));
    const redis = new Redis(REDIS_URL);

    try {
      expect((await gw.inject({ method: 'GET', url: '/api/x', headers: bearer(key.raw) })).statusCode).toBe(200);
      expect(await redis.get(cacheKey)).not.toBeNull();

      // Revoke behind the gateway's back (no cache invalidation) — the cache still vouches for the key…
      await revokeApiKey(db!.pool, key.id);
      expect((await gw.inject({ method: 'GET', url: '/api/x', headers: bearer(key.raw) })).statusCode).toBe(200);

      // …until the entry is dropped, which is exactly what the admin revoke endpoint does.
      await redis.del(cacheKey);
      expect((await gw.inject({ method: 'GET', url: '/api/x', headers: bearer(key.raw) })).statusCode).toBe(401);
    } finally {
      await redis.quit();
    }
  });

  it('negative-caches an unknown key so repeated bad guesses do not hammer Postgres', async () => {
    const gw = await gateway({ redis: { url: REDIS_URL } });
    const bogus = 'ag_live_' + randomUUID().replace(/-/g, '');
    const redis = new Redis(REDIS_URL);

    try {
      expect((await gw.inject({ method: 'GET', url: '/api/x', headers: bearer(bogus) })).statusCode).toBe(401);
      expect(await redis.get(apiKeyCacheKey(hashApiKey(bogus)))).toBe('__invalid__');
      expect((await gw.inject({ method: 'GET', url: '/api/x', headers: bearer(bogus) })).statusCode).toBe(401);
    } finally {
      await redis.quit();
    }
  });
});
