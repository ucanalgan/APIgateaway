import type { Redis } from 'ioredis';
import type { CachedResponse, CacheStore } from './store.js';

interface SerializedResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string | string[]>;
  /** base64 — Redis string değerleri JSON'a gömülecekse metin olmalı. */
  readonly body: string;
}

/** Instance'lar arasında paylaşılan response cache — atomiklik gerekmez (idempotent overwrite). */
export function createRedisCacheStore(redis: Redis): CacheStore {
  return {
    async get(key: string): Promise<CachedResponse | null> {
      const raw = await redis.get(key);
      if (!raw) return null;

      const parsed = JSON.parse(raw) as SerializedResponse;
      return {
        statusCode: parsed.statusCode,
        headers: parsed.headers,
        body: Buffer.from(parsed.body, 'base64'),
      };
    },

    async set(key: string, response: CachedResponse, ttlSec: number): Promise<void> {
      const serialized: SerializedResponse = {
        statusCode: response.statusCode,
        headers: response.headers,
        body: response.body.toString('base64'),
      };
      await redis.set(key, JSON.stringify(serialized), 'EX', ttlSec);
    },

    async deleteByPrefix(prefix: string): Promise<number> {
      // SCAN, never KEYS: KEYS blocks the whole Redis server while it walks the
      // keyspace, which on a shared instance is an outage of its own.
      let removed = 0;

      for await (const keys of redis.scanStream({ match: `${escapeGlob(prefix)}*`, count: 200 }) as AsyncIterable<string[]>) {
        if (keys.length === 0) continue;
        // SCAN may return the same key twice; DEL only counts keys it really removed.
        removed += await redis.del(...keys);
      }

      return removed;
    },

    async close(): Promise<void> {
      await redis.quit();
    },
  };
}

/** Redis MATCH patterns are globs — a key prefix containing `*?[]\` must match literally. */
function escapeGlob(literal: string): string {
  return literal.replace(/[\\*?[\]]/g, '\\$&');
}
