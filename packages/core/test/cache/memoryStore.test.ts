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

  it('close clears everything', async () => {
    const store = createMemoryCacheStore();
    await store.set('k', sample, 60);
    await store.close();
    expect(await store.get('k')).toBeNull();
  });
});
