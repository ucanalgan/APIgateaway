import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { createRedisCacheStore } from '../../src/cache/redisStore.js';
import type { CachedResponse } from '../../src/cache/store.js';

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

describe.skipIf(!redisAvailable)('createRedisCacheStore (integration)', () => {
  const redis = new Redis(REDIS_URL);

  afterAll(async () => {
    await redis.quit();
  });

  it('round-trips a cached response, including binary body content', async () => {
    const store = createRedisCacheStore(redis);
    const key = `test:cache:${randomUUID()}`;
    const response: CachedResponse = {
      statusCode: 200,
      headers: { 'content-type': 'application/octet-stream', 'x-multi': ['a', 'b'] },
      body: Buffer.from([0, 1, 2, 255, 254, 253]),
    };

    await store.set(key, response, 60);
    const found = await store.get(key);

    expect(found).toEqual(response);
  });

  describe('deleteByPrefix', () => {
    const entry: CachedResponse = { statusCode: 200, headers: {}, body: Buffer.from('x') };

    it('removes only the entries under the prefix, and reports how many', async () => {
      const store = createRedisCacheStore(redis);
      const ns = `test:purge:${randomUUID()}`;
      await store.set(`${ns}:a:1`, entry, 60);
      await store.set(`${ns}:a:2`, entry, 60);
      await store.set(`${ns}:b:1`, entry, 60);

      expect(await store.deleteByPrefix(`${ns}:a:`)).toBe(2);

      expect(await store.get(`${ns}:a:1`)).toBeNull();
      expect(await store.get(`${ns}:a:2`)).toBeNull();
      expect(await store.get(`${ns}:b:1`)).toEqual(entry);
    });

    it('handles more keys than one SCAN page returns', async () => {
      const store = createRedisCacheStore(redis);
      const ns = `test:purge:${randomUUID()}`;
      await Promise.all(Array.from({ length: 450 }, (_, i) => store.set(`${ns}:k${i}`, entry, 60)));

      expect(await store.deleteByPrefix(`${ns}:`)).toBe(450);
      expect(await redis.keys(`${ns}:*`)).toHaveLength(0);
    });

    it('treats glob characters in the prefix literally — a `*` must not widen the purge', async () => {
      const store = createRedisCacheStore(redis);
      const ns = `test:purge:${randomUUID()}`;
      await store.set(`${ns}:we*rd:1`, entry, 60);
      await store.set(`${ns}:weXrd:1`, entry, 60);

      expect(await store.deleteByPrefix(`${ns}:we*rd:`)).toBe(1);

      expect(await store.get(`${ns}:weXrd:1`)).toEqual(entry); // untouched
    });

    it('resolves with 0 when nothing matches', async () => {
      const store = createRedisCacheStore(redis);
      expect(await store.deleteByPrefix(`test:purge:${randomUUID()}:`)).toBe(0);
    });
  });

  it('returns null once the ttl expires', async () => {
    const store = createRedisCacheStore(redis);
    const key = `test:cache:${randomUUID()}`;

    await store.set(key, { statusCode: 200, headers: {}, body: Buffer.from('x') }, 1);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    expect(await store.get(key)).toBeNull();
  });
});
