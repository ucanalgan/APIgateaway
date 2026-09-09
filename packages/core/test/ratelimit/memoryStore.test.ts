import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../src/ratelimit/stores/memoryStore.js';
import type { Policy } from '../../src/ratelimit/stores/Store.js';

const policy: Policy = { limit: 10, windowMs: 60_000 };

describe('createMemoryStore', () => {
  it('lets exactly `limit` requests through under real concurrency', async () => {
    // JS is single-threaded and `consume` has no `await` in its critical
    // section, so this is the atomicity guarantee the whole project hinges
    // on (PLAN.md §5/§11) — this test is the proof for the memory backend.
    const store = createMemoryStore('tokenBucket');

    const results = await Promise.all(
      Array.from({ length: 100 }, () => store.consume('shared-key', policy)),
    );

    const allowedCount = results.filter((r) => r.allowed).length;
    expect(allowedCount).toBe(10);
  });

  it('keeps separate keys independent', async () => {
    const store = createMemoryStore('fixedWindow');

    const a = await store.consume('a', { limit: 1, windowMs: 1000 });
    const b = await store.consume('b', { limit: 1, windowMs: 1000 });

    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
  });

  it('reset clears state for a key', async () => {
    const store = createMemoryStore('fixedWindow');
    const tight: Policy = { limit: 1, windowMs: 60_000 };

    await store.consume('key', tight);
    const blocked = await store.consume('key', tight);
    expect(blocked.allowed).toBe(false);

    await store.reset('key');
    const afterReset = await store.consume('key', tight);
    expect(afterReset.allowed).toBe(true);
  });

  it('supports all five algorithms', async () => {
    const algorithms = [
      'fixedWindow',
      'tokenBucket',
      'leakyBucket',
      'slidingWindowLog',
      'slidingWindowCounter',
    ] as const;

    for (const algorithm of algorithms) {
      const store = createMemoryStore(algorithm);
      const result = await store.consume('k', policy);
      expect(result.allowed).toBe(true);
    }
  });
});
