import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { hashApiKey, verifyApiKeyHash } from '@apigate/core/auth';
import { createDbPool, runMigrations, type DbPool } from '../src/db/client.js';
import { createPlan, findPlanByName } from '../src/db/repositories/plans.js';
import { createTenant } from '../src/db/repositories/tenants.js';
import { createApiKey, findActiveApiKeyWithPlan, revokeApiKey } from '../src/db/repositories/apiKeys.js';
import { insertUsageBatch } from '../src/db/repositories/usage.js';

// Integration tests against a real Postgres, in a throwaway database created
// just for this run (PLAN.md §11: real Redis + Postgres, not mocks). Skips
// itself if POSTGRES_URL (default postgres://postgres:postgres@localhost:5432/postgres)
// isn't reachable, so `npm test` still works without Docker.
const ADMIN_URL = process.env['POSTGRES_URL'] ?? 'postgres://postgres:postgres@localhost:5432/postgres';
const TEST_DB_NAME = `apigate_test_${randomUUID().replace(/-/g, '')}`;

let pgAvailable = false;
let pool: DbPool | undefined;

try {
  const admin = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 1000 });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${TEST_DB_NAME}"`);
  await admin.end();

  const dbUrl = new URL(ADMIN_URL);
  dbUrl.pathname = `/${TEST_DB_NAME}`;
  pool = createDbPool(dbUrl.toString());
  await runMigrations(pool);
  pgAvailable = true;
} catch {
  pgAvailable = false;
}

describe.skipIf(!pgAvailable)('db repositories (integration)', () => {
  afterAll(async () => {
    await pool?.end();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB_NAME}"`);
    await admin.end();
  });

  it('creates a plan and finds it by name', async () => {
    const name = `test-plan-${randomUUID()}`;
    const plan = await createPlan(pool!, { name, rateLimit: 10, windowSec: 60, burst: 5 });
    expect(await findPlanByName(pool!, name)).toEqual(plan);
  });

  it('creates a tenant + api key, and finds the active key with its plan', async () => {
    const plan = await createPlan(pool!, { name: `plan-${randomUUID()}`, rateLimit: 100, windowSec: 60, burst: 20 });
    const tenant = await createTenant(pool!, { name: 'acme', planId: plan.id });
    const key = await createApiKey(pool!, { tenantId: tenant.id, scopes: ['read'] });

    const record = await findActiveApiKeyWithPlan(pool!, hashApiKey(key.raw));

    expect(record?.tenantId).toBe(tenant.id);
    expect(record?.scopes).toEqual(['read']);
    expect(record?.plan).toEqual({ limit: 100, windowSec: 60, burst: 20 });
    expect(verifyApiKeyHash(key.raw, record!.keyHash)).toBe(true);
  });

  it('excludes revoked keys, and revoking twice is a harmless no-op', async () => {
    const plan = await createPlan(pool!, { name: `plan-${randomUUID()}`, rateLimit: 10, windowSec: 60, burst: 5 });
    const tenant = await createTenant(pool!, { name: 'acme2', planId: plan.id });
    const key = await createApiKey(pool!, { tenantId: tenant.id });
    const hash = hashApiKey(key.raw);

    expect(await findActiveApiKeyWithPlan(pool!, hash)).not.toBeNull();

    const revoked = await revokeApiKey(pool!, key.id);
    expect(revoked?.hash).toBe(hash);
    expect(await findActiveApiKeyWithPlan(pool!, hash)).toBeNull();
    expect(await revokeApiKey(pool!, key.id)).toBeNull();
  });

  it('excludes keys belonging to a suspended tenant', async () => {
    const plan = await createPlan(pool!, { name: `plan-${randomUUID()}`, rateLimit: 10, windowSec: 60, burst: 5 });
    const tenant = await createTenant(pool!, { name: 'acme3', planId: plan.id });
    const key = await createApiKey(pool!, { tenantId: tenant.id });

    await pool!.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [tenant.id]);

    expect(await findActiveApiKeyWithPlan(pool!, hashApiKey(key.raw))).toBeNull();
  });

  it('batches usage records in one insert', async () => {
    const plan = await createPlan(pool!, { name: `plan-${randomUUID()}`, rateLimit: 10, windowSec: 60, burst: 5 });
    const tenant = await createTenant(pool!, { name: 'acme4', planId: plan.id });

    await insertUsageBatch(pool!, [
      { tenantId: tenant.id, routeId: 'r1', statusCode: 200, latencyMs: 12 },
      { tenantId: tenant.id, routeId: 'r1', statusCode: 404, latencyMs: 3 },
    ]);

    const { rows } = await pool!.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM usage_records WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(rows[0]?.n).toBe(2);
  });
});
