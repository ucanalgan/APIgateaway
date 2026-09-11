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

  it('returns null once the ttl expires', async () => {
    const store = createRedisCacheStore(redis);
    const key = `test:cache:${randomUUID()}`;

    await store.set(key, { statusCode: 200, headers: {}, body: Buffer.from('x') }, 1);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    expect(await store.get(key)).toBeNull();
  });
});
