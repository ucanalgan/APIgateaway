import type { CachedResponse, CacheStore } from './store.js';

interface Entry {
  readonly response: CachedResponse;
  readonly expiresAt: number;
}

/** Tek instance için yeterli — dağıtık kullanım için redisStore.ts. */
export function createMemoryCacheStore(): CacheStore {
  const entries = new Map<string, Entry>();

  return {
    get(key: string): Promise<CachedResponse | null> {
      const entry = entries.get(key);
      if (!entry) return Promise.resolve(null);

      if (Date.now() >= entry.expiresAt) {
        entries.delete(key);
        return Promise.resolve(null);
      }

      return Promise.resolve(entry.response);
    },

    set(key: string, response: CachedResponse, ttlSec: number): Promise<void> {
      entries.set(key, { response, expiresAt: Date.now() + ttlSec * 1000 });
      return Promise.resolve();
    },

    deleteByPrefix(prefix: string): Promise<number> {
      const now = Date.now();
      let removed = 0;

      for (const [key, entry] of entries) {
        if (!key.startsWith(prefix)) continue;
        entries.delete(key);
        if (now < entry.expiresAt) removed++; // an already-expired entry was effectively gone
      }

      return Promise.resolve(removed);
    },

    close(): Promise<void> {
      entries.clear();
      return Promise.resolve();
    },
  };
}
