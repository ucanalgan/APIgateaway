import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createPlan } from '../src/db/repositories/plans.js';
import { createTenant } from '../src/db/repositories/tenants.js';
import { insertUsageBatch } from '../src/db/repositories/usage.js';
import {
  REDIS_URL,
  buildTestApp,
  createTestDatabase,
  redisReachable,
  startUpstream,
  type TestUpstream,
} from './helpers.js';

const TOKEN = 'admin-secret-for-tests';
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

async function gateway(extra: Record<string, unknown> = {}): Promise<FastifyInstance> {
  up = await startUpstream();
  app = await buildTestApp(
    [
      {
        id: 'api',
        match: { path: '/api/*' },
        upstream: { targets: [up.url] },
        auth: { type: 'apiKey' },
      },
    ],
    { db: { url: db!.url }, admin: { token: TOKEN }, ...extra },
  );
  return app;
}

const admin = { authorization: `Bearer ${TOKEN}` };
const json = { ...admin, 'content-type': 'application/json' };

async function makePlan(gw: FastifyInstance): Promise<{ id: string; name: string }> {
  const res = await gw.inject({
    method: 'POST',
    url: '/admin/plans',
    headers: json,
    payload: { name: `plan-${randomUUID()}`, rateLimit: 100, windowSec: 60, burst: 20 },
  });
  return res.json();
}

async function makeTenant(gw: FastifyInstance, planId: string): Promise<{ id: string; status: string }> {
  const res = await gw.inject({
    method: 'POST',
    url: '/admin/tenants',
    headers: json,
    payload: { name: `tenant-${randomUUID()}`, planId },
  });
  return res.json();
}

describe.skipIf(!db)('admin API (real Postgres)', () => {
  describe('authentication', () => {
    it('answers 401 without a token, with a wrong token, and with a non-Bearer scheme', async () => {
      const gw = await gateway();

      for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: `Basic ${TOKEN}` }]) {
        const res = await gw.inject({ method: 'GET', url: '/admin/plans', headers });
        expect(res.statusCode).toBe(401);
        expect(res.json()).toMatchObject({ error: 'unauthorized' });
      }
    });

    it('is not reachable with a tenant API key — admin auth is separate from tenant auth', async () => {
      const gw = await gateway();
      const plan = await makePlan(gw);
      const tenant = await makeTenant(gw, plan.id);
      const key = (
        await gw.inject({ method: 'POST', url: `/admin/tenants/${tenant.id}/keys`, headers: json, payload: {} })
      ).json<{ raw: string }>();

      const res = await gw.inject({ method: 'GET', url: '/admin/plans', headers: { authorization: `Bearer ${key.raw}` } });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('plans', () => {
    it('creates and lists plans', async () => {
      const gw = await gateway();

      const created = await gw.inject({
        method: 'POST',
        url: '/admin/plans',
        headers: json,
        payload: { name: `pro-${randomUUID()}`, rateLimit: 1000, windowSec: 60, burst: 200, quotaMonthly: 5_000_000 },
      });
      const listed = await gw.inject({ method: 'GET', url: '/admin/plans', headers: admin });

      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ rateLimit: 1000, windowSec: 60, burst: 200 });
      expect(listed.json<Array<{ id: string }>>().map((p) => p.id)).toContain(created.json<{ id: string }>().id);
    });

    it('rejects an invalid plan with a 400 that names the offending field', async () => {
      const gw = await gateway();

      const res = await gw.inject({ method: 'POST', url: '/admin/plans', headers: json, payload: { name: 'x', rateLimit: -5 } });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid_request' });
      expect(res.json<{ message: string }>().message).toContain('rateLimit');
    });

    it('answers 400 in the standard error shape for a malformed JSON body', async () => {
      const gw = await gateway();

      const res = await gw.inject({ method: 'POST', url: '/admin/plans', headers: json, payload: '{ not json' });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid_request', requestId: res.headers['x-request-id'] });
    });

    it('never leaks a raw database error — an unexpected failure is a generic 500', async () => {
      const gw = await gateway();

      // Well-formed uuid, but no such plan: Postgres rejects the insert (foreign key violation).
      const res = await gw.inject({
        method: 'POST',
        url: '/admin/tenants',
        headers: json,
        payload: { name: 'orphan', planId: randomUUID() },
      });

      expect(res.statusCode).toBe(500);
      expect(res.json()).toMatchObject({ error: 'internal_error', message: 'Internal server error.' });
      expect(res.body).not.toMatch(/foreign key|violates|constraint|plan_id/i);
    });
  });

  describe('tenants', () => {
    it('creates, lists, suspends and re-activates a tenant', async () => {
      const gw = await gateway();
      const plan = await makePlan(gw);
      const tenant = await makeTenant(gw, plan.id);
      expect(tenant.status).toBe('active');

      const listed = await gw.inject({ method: 'GET', url: '/admin/tenants', headers: admin });
      const suspended = await gw.inject({ method: 'POST', url: `/admin/tenants/${tenant.id}/suspend`, headers: json, payload: '' });
      const activated = await gw.inject({ method: 'POST', url: `/admin/tenants/${tenant.id}/activate`, headers: json, payload: '' });

      expect(listed.json<Array<{ id: string }>>().map((t) => t.id)).toContain(tenant.id);
      expect(suspended.json()).toMatchObject({ id: tenant.id, status: 'suspended' });
      expect(activated.json()).toMatchObject({ id: tenant.id, status: 'active' });
    });

    it('rejects a tenant with a non-uuid planId (400)', async () => {
      const gw = await gateway();

      const res = await gw.inject({
        method: 'POST',
        url: '/admin/tenants',
        headers: json,
        payload: { name: 'x', planId: 'not-a-uuid' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('answers 404 when suspending or activating a tenant that does not exist', async () => {
      const gw = await gateway();

      for (const action of ['suspend', 'activate']) {
        const res = await gw.inject({
          method: 'POST',
          url: `/admin/tenants/${randomUUID()}/${action}`,
          headers: json,
          payload: '',
        });
        expect(res.statusCode).toBe(404);
        expect(res.json()).toMatchObject({ error: 'not_found' });
      }
    });
  });

  describe('keys', () => {
    it('returns the raw key exactly once, and listing never exposes it or its hash', async () => {
      const gw = await gateway();
      const tenant = await makeTenant(gw, (await makePlan(gw)).id);

      const created = await gw.inject({
        method: 'POST',
        url: `/admin/tenants/${tenant.id}/keys`,
        headers: json,
        payload: { name: 'ci', scopes: ['read'] },
      });
      const key = created.json<{ raw: string; id: string; prefix: string }>();
      const listed = await gw.inject({ method: 'GET', url: `/admin/tenants/${tenant.id}/keys`, headers: admin });

      expect(created.statusCode).toBe(201);
      expect(key.raw).toMatch(/^ag_live_/);
      expect(listed.json<Array<{ id: string; prefix: string }>>()).toMatchObject([{ id: key.id, prefix: key.prefix }]);
      expect(listed.body).not.toContain(key.raw);
      expect(listed.body).not.toMatch(/hash/i);
    });

    it('answers 404 for keys of an unknown tenant, and 400 for an invalid expiresAt', async () => {
      const gw = await gateway();
      const tenant = await makeTenant(gw, (await makePlan(gw)).id);

      const list = await gw.inject({ method: 'GET', url: `/admin/tenants/${randomUUID()}/keys`, headers: admin });
      const create = await gw.inject({ method: 'POST', url: `/admin/tenants/${randomUUID()}/keys`, headers: json, payload: {} });
      const badExpiry = await gw.inject({
        method: 'POST',
        url: `/admin/tenants/${tenant.id}/keys`,
        headers: json,
        payload: { expiresAt: 'tomorrow-ish' },
      });

      expect(list.statusCode).toBe(404);
      expect(create.statusCode).toBe(404);
      expect(badExpiry.statusCode).toBe(400);
    });

    it('honors expiresAt — a key created already-expired is unusable', async () => {
      const gw = await gateway();
      const tenant = await makeTenant(gw, (await makePlan(gw)).id);

      const { raw } = (
        await gw.inject({
          method: 'POST',
          url: `/admin/tenants/${tenant.id}/keys`,
          headers: json,
          payload: { expiresAt: new Date(Date.now() - 60_000).toISOString() },
        })
      ).json<{ raw: string }>();

      const res = await gw.inject({ method: 'GET', url: '/api/x', headers: { authorization: `Bearer ${raw}` } });
      expect(res.statusCode).toBe(401);
    });

    it('full lifecycle: create a key via the admin API, use it, revoke it, and it stops working', async () => {
      const gw = await gateway();
      const tenant = await makeTenant(gw, (await makePlan(gw)).id);
      const key = (
        await gw.inject({ method: 'POST', url: `/admin/tenants/${tenant.id}/keys`, headers: json, payload: {} })
      ).json<{ raw: string; id: string }>();
      const useKey = () => gw.inject({ method: 'GET', url: '/api/x', headers: { authorization: `Bearer ${key.raw}` } });

      expect((await useKey()).statusCode).toBe(200);

      const revoked = await gw.inject({ method: 'DELETE', url: `/admin/keys/${key.id}`, headers: admin });
      const revokedAgain = await gw.inject({ method: 'DELETE', url: `/admin/keys/${key.id}`, headers: admin });
      const unknown = await gw.inject({ method: 'DELETE', url: `/admin/keys/${randomUUID()}`, headers: admin });

      expect(revoked.statusCode).toBe(204);
      expect(revokedAgain.statusCode).toBe(404); // already revoked
      expect(unknown.statusCode).toBe(404);
      expect((await useKey()).statusCode).toBe(401);
    });
  });

  describe('usage', () => {
    it('summarizes usage, optionally narrowed to a tenant and a time window', async () => {
      const gw = await gateway();
      const plan = await createPlan(db!.pool, { name: `p-${randomUUID()}`, rateLimit: 10, windowSec: 60, burst: 5 });
      const tenant = await createTenant(db!.pool, { name: `t-${randomUUID()}`, planId: plan.id });
      await insertUsageBatch(db!.pool, [
        { tenantId: tenant.id, routeId: 'api', statusCode: 200, latencyMs: 10 },
        { tenantId: tenant.id, routeId: 'api', statusCode: 200, latencyMs: 30 },
        { tenantId: tenant.id, routeId: 'api', statusCode: 429, latencyMs: 2 },
      ]);

      const scoped = await gw.inject({
        method: 'GET',
        url: `/admin/usage?tenantId=${tenant.id}&sinceHours=1`,
        headers: admin,
      });
      const other = await gw.inject({ method: 'GET', url: `/admin/usage?tenantId=${randomUUID()}`, headers: admin });
      const everyone = await gw.inject({ method: 'GET', url: '/admin/usage', headers: admin });

      expect(scoped.json()).toMatchObject({ totalRequests: 3, successCount: 2, errorCount: 1 });
      expect(other.json()).toMatchObject({ totalRequests: 0, avgLatencyMs: null });
      expect(everyone.json<{ totalRequests: number }>().totalRequests).toBeGreaterThanOrEqual(3);
    });
  });
});

describe.skipIf(!db || !redisAvailable)('admin revoke + Redis auth cache (real Postgres + real Redis)', () => {
  it('revoking through the admin API takes effect INSTANTLY, even though the key is cached', async () => {
    const gw = await gateway({ redis: { url: REDIS_URL } });
    const tenant = await makeTenant(gw, (await makePlan(gw)).id);
    const key = (
      await gw.inject({ method: 'POST', url: `/admin/tenants/${tenant.id}/keys`, headers: json, payload: {} })
    ).json<{ raw: string; id: string }>();
    const useKey = () => gw.inject({ method: 'GET', url: '/api/x', headers: { authorization: `Bearer ${key.raw}` } });

    expect((await useKey()).statusCode).toBe(200); // now cached in Redis
    expect((await useKey()).statusCode).toBe(200);

    await gw.inject({ method: 'DELETE', url: `/admin/keys/${key.id}`, headers: admin });

    expect((await useKey()).statusCode).toBe(401); // no waiting for the 60s TTL
  });
});
