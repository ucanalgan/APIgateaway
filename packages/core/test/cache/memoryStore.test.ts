import { describe, expect, it } from 'vitest';
import { createMemoryCacheStore } from '../../src/cache/memoryStore.js';
import type { CachedResponse } from '../../src/cache/store.js';

const sample: CachedResponse = {
  statusCode: 200,
  headers: { 'content-type': 'application/json' },
  body: Buffer.from('{"hello":"world"}'),
};

describe('createMemoryCacheStore', () => {
  it('returns null for a missing key', async () => {
    const store = createMemoryCacheStore();
    expect(await store.get('missing')).toBeNull();
  });

  it('returns what was set, byte for byte', async () => {
    const store = createMemoryCacheStore();
    await store.set('k', sample, 60);
    const found = await store.get('k');
    expect(found).toEqual(sample);
  });

  it('expires an entry after its ttl', async () => {
    const store = createMemoryCacheStore();
    await store.set('k', sample, -1); // already expired
    expect(await store.get('k')).toBeNull();
  });

  describe('deleteByPrefix', () => {
    it('removes only the entries under the prefix, and reports how many', async () => {
      const store = createMemoryCacheStore();
      await store.set('cache:a:1', sample, 60);
      await store.set('cache:a:2', sample, 60);
      await store.set('cache:b:1', sample, 60);

      expect(await store.deleteByPrefix('cache:a:')).toBe(2);

      expect(await store.get('cache:a:1')).toBeNull();
      expect(await store.get('cache:a:2')).toBeNull();
      expect(await store.get('cache:b:1')).toEqual(sample);
    });

    it('resolves with 0 when nothing matches', async () => {
      const store = createMemoryCacheStore();
      await store.set('cache:a:1', sample, 60);

      expect(await store.deleteByPrefix('cache:zzz:')).toBe(0);
      expect(await store.get('cache:a:1')).toEqual(sample);
    });

    it('does not count an entry that had already expired', async () => {
      const store = createMemoryCacheStore();
      await store.set('cache:a:live', sample, 60);
      await store.set('cache:a:stale', sample, -1);

      expect(await store.deleteByPrefix('cache:a:')).toBe(1);
    });
  });

  it('close clears everything', async () => {
    const store = createMemoryCacheStore();
    await store.set('k', sample, 60);
    await store.close();
    expect(await store.get('k')).toBeNull();
  });
});
