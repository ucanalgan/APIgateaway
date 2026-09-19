import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDbPool } from '../src/db/client.js';
import { createPlan } from '../src/db/repositories/plans.js';
import { createTenant } from '../src/db/repositories/tenants.js';
import { createUsageBuffer } from '../src/usage/buffer.js';
import { createTestDatabase, waitFor } from './helpers.js';

const db = await createTestDatabase();

afterAll(async () => {
  await db?.drop();
});

async function newTenant(): Promise<string> {
  const plan = await createPlan(db!.pool, { name: `p-${randomUUID()}`, rateLimit: 10, windowSec: 60, burst: 5 });
  return (await createTenant(db!.pool, { name: `t-${randomUUID()}`, planId: plan.id })).id;
}

async function countUsage(tenantId: string): Promise<number> {
  const { rows } = await db!.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM usage_records WHERE tenant_id = $1', [
    tenantId,
  ]);
  return rows[0]?.n ?? 0;
}

const record = (tenantId: string) => ({ tenantId, routeId: 'r', statusCode: 200, latencyMs: 5 });

describe.skipIf(!db)('usage buffer (real Postgres)', () => {
  it('holds records in memory until flushed', async () => {
    const tenantId = await newTenant();
    const buffer = createUsageBuffer(db!.pool, { flushIntervalMs: 60_000 });

    buffer.push(record(tenantId));
    buffer.push(record(tenantId));
    expect(await countUsage(tenantId)).toBe(0);

    await buffer.flush();
    expect(await countUsage(tenantId)).toBe(2);
    await buffer.close();
  });

  it('flushes on its own once maxBatchSize is reached', async () => {
    const tenantId = await newTenant();
    const buffer = createUsageBuffer(db!.pool, { flushIntervalMs: 60_000, maxBatchSize: 3 });

    for (let i = 0; i < 3; i++) buffer.push(record(tenantId));

    await waitFor(async () => (await countUsage(tenantId)) === 3);
    await buffer.close();
  });

  it('flushes on the interval', async () => {
    const tenantId = await newTenant();
    const buffer = createUsageBuffer(db!.pool, { flushIntervalMs: 30 });

    buffer.push(record(tenantId));

    await waitFor(async () => (await countUsage(tenantId)) === 1);
    await buffer.close();
  });

  it('writes whatever is left when closed', async () => {
    const tenantId = await newTenant();
    const buffer = createUsageBuffer(db!.pool, { flushIntervalMs: 60_000 });

    buffer.push(record(tenantId));
    await buffer.close();

    expect(await countUsage(tenantId)).toBe(1);
  });

  it('reports a failed write via onError without throwing into the request path', async () => {
    const tenantId = await newTenant();
    const brokenPool = createDbPool(db!.url);
    await brokenPool.end(); // every query against it now fails
    const errors: unknown[] = [];
    const buffer = createUsageBuffer(brokenPool, { flushIntervalMs: 60_000, onError: (err) => errors.push(err) });

    buffer.push(record(tenantId));
    await expect(buffer.flush()).resolves.toBeUndefined();

    expect(errors).toHaveLength(1);
    await buffer.close();
  });

  it('flushing an empty buffer is a no-op', async () => {
    const buffer = createUsageBuffer(db!.pool, { flushIntervalMs: 60_000 });
    await expect(buffer.flush()).resolves.toBeUndefined();
    await buffer.close();
  });
});
