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

    async close(): Promise<void> {
      await redis.quit();
    },
  };
}
