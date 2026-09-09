import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { createRedisStore, type AlgorithmName } from '../../src/ratelimit/stores/redisStore.js';
import type { Policy } from '../../src/ratelimit/stores/Store.js';

// Integration tests against a real Redis — PLAN.md §11 is explicit that this
// layer must be proven against the real thing, not mocked. Needs a reachable
// Redis at REDIS_URL (defaults to localhost:6379); skips itself otherwise so
// `npm test` still works on a machine without Redis running.
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

const probe = new Redis(REDIS_URL, { lazyConnect: true, retryStrategy: () => null, connectTimeout: 1000 });
let redisAvailable = false;
try {
  await probe.connect();
  redisAvailable = true;
} catch {
  redisAvailable = false;
} finally {
  probe.disconnect();
}

const ALGORITHMS: readonly AlgorithmName[] = [
  'fixedWindow',
  'tokenBucket',
  'leakyBucket',
  'slidingWindowLog',
  'slidingWindowCounter',
];

describe.skipIf(!redisAvailable)('createRedisStore (integration)', () => {
  const redis = new Redis(REDIS_URL);

  afterAll(async () => {
    await redis.quit();
  });

  it.each(ALGORITHMS)('%s: allows exactly `limit` requests, then rejects', async (algorithm) => {
    const store = createRedisStore(algorithm, redis);
    const policy: Policy = { limit: 5, windowMs: 60_000 };
    const key = `test:${algorithm}:${randomUUID()}`;

    for (let i = 0; i < 5; i++) {
      const result = await store.consume(key, policy);
      expect(result.allowed).toBe(true);
    }

    const sixth = await store.consume(key, policy);
    expect(sixth.allowed).toBe(false);
    expect(sixth.retryAfterMs).toBeGreaterThan(0);
  });

  it('is atomic under real concurrency — 100 parallel requests, limit 10, exactly 10 allowed', async () => {
    // This is the proof PLAN.md §5/§11 asks for: the Lua script runs
    // server-side as a single atomic op, so no interleaving is possible even
    // with genuinely concurrent callers.
    const store = createRedisStore('tokenBucket', redis);
    const policy: Policy = { limit: 10, windowMs: 60_000 };
    const key = `test:concurrency:${randomUUID()}`;

    const results = await Promise.all(Array.from({ length: 100 }, () => store.consume(key, policy)));

    expect(results.filter((r) => r.allowed)).toHaveLength(10);
  });

  it('shares state across independent connections — the multi-instance demo', async () => {
    // Two separate ioredis connections standing in for two gateway
    // processes. Both must see the same, shared quota.
    const redisA = new Redis(REDIS_URL);
    const redisB = new Redis(REDIS_URL);
    const key = `test:distributed:${randomUUID()}`;
    const policy: Policy = { limit: 10, windowMs: 60_000 };

    try {
      const storeA = createRedisStore('fixedWindow', redisA);
      const storeB = createRedisStore('fixedWindow', redisB);

      const fromA = await Promise.all(Array.from({ length: 10 }, () => storeA.consume(key, policy)));
      const fromB = await Promise.all(Array.from({ length: 10 }, () => storeB.consume(key, policy)));

      const totalAllowed = [...fromA, ...fromB].filter((r) => r.allowed).length;
      expect(totalAllowed).toBe(10);
    } finally {
      await redisA.quit();
      await redisB.quit();
    }
  });

  it('reset clears state for a key', async () => {
    const store = createRedisStore('tokenBucket', redis);
    const policy: Policy = { limit: 1, windowMs: 60_000 };
    const key = `test:reset:${randomUUID()}`;

    await store.consume(key, policy);
    const blocked = await store.consume(key, policy);
    expect(blocked.allowed).toBe(false);

    await store.reset(key);
    const afterReset = await store.consume(key, policy);
    expect(afterReset.allowed).toBe(true);
  });
});
