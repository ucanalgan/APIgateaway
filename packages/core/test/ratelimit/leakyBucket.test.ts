import { describe, expect, it } from 'vitest';
import { leakyBucket } from '../../src/ratelimit/algorithms/leakyBucket.js';
import type { Policy } from '../../src/ratelimit/stores/Store.js';

// leaks 10 units/sec, queue capacity 20.
const policy: Policy = { limit: 10, windowMs: 1000, burst: 20 };

describe('leakyBucket', () => {
  it('allows requests until the queue is full', () => {
    let state;
    for (let i = 0; i < 20; i++) {
      const out = leakyBucket(state, policy, 0, 1);
      expect(out.result.allowed).toBe(true);
      state = out.state;
    }

    const overCapacity = leakyBucket(state, policy, 0, 1);
    expect(overCapacity.result.allowed).toBe(false);
  });

  it('drains over time at the configured rate', () => {
    const full = leakyBucket(undefined, policy, 0, 20);
    expect(full.result.remaining).toBe(0);

    // 500ms later, 5 units should have leaked out.
    const drained = leakyBucket(full.state, policy, 500, 1);
    expect(drained.result.allowed).toBe(true);
    expect(drained.result.remaining).toBe(4);
  });

  it('reports how long until there is room', () => {
    const full = leakyBucket(undefined, policy, 0, 20);
    const rejected = leakyBucket(full.state, policy, 0, 5);

    expect(rejected.result.allowed).toBe(false);
    // Need 5 units of headroom at 10/sec = 500ms.
    expect(rejected.result.retryAfterMs).toBe(500);
  });
});
