import { describe, expect, it } from 'vitest';
import { tokenBucket } from '../../src/ratelimit/algorithms/tokenBucket.js';
import type { Policy } from '../../src/ratelimit/stores/Store.js';

// 10 tokens/sec, burst capacity 20.
const policy: Policy = { limit: 10, windowMs: 1000, burst: 20 };

describe('tokenBucket', () => {
  it('starts full and allows a burst up to capacity', () => {
    let state;
    for (let i = 0; i < 20; i++) {
      const out = tokenBucket(state, policy, 0, 1);
      expect(out.result.allowed).toBe(true);
      state = out.state;
    }

    const overBurst = tokenBucket(state, policy, 0, 1);
    expect(overBurst.result.allowed).toBe(false);
  });

  it('refills over time at the configured rate', () => {
    const drained = tokenBucket(undefined, policy, 0, 20);
    expect(drained.result.remaining).toBe(0);

    // 500ms later, at 10 tokens/sec, 5 tokens should be back.
    const refilled = tokenBucket(drained.state, policy, 500, 1);
    expect(refilled.result.allowed).toBe(true);
    expect(refilled.result.remaining).toBe(4);
  });

  it('never refills past capacity', () => {
    const full = tokenBucket(undefined, policy, 0, 1);
    const muchLater = tokenBucket(full.state, policy, 1_000_000, 0);
    expect(muchLater.result.remaining).toBe(20);
  });

  it('reports how long until enough tokens are available', () => {
    const drained = tokenBucket(undefined, policy, 0, 20);
    const rejected = tokenBucket(drained.state, policy, 0, 5);

    expect(rejected.result.allowed).toBe(false);
    // Need 5 tokens at 10/sec = 500ms.
    expect(rejected.result.retryAfterMs).toBe(500);
  });
});
