import { describe, expect, it } from 'vitest';
import { slidingWindowLog } from '../../src/ratelimit/algorithms/slidingWindowLog.js';
import type { Policy } from '../../src/ratelimit/stores/Store.js';

const policy: Policy = { limit: 3, windowMs: 1000 };

describe('slidingWindowLog', () => {
  it('allows up to the limit inside the window', () => {
    let state;
    for (let i = 0; i < 3; i++) {
      const out = slidingWindowLog(state, policy, i * 100, 1);
      expect(out.result.allowed).toBe(true);
      state = out.state;
    }

    const fourth = slidingWindowLog(state, policy, 300, 1);
    expect(fourth.result.allowed).toBe(false);
  });

  it('does not exhibit the fixed-window boundary burst problem', () => {
    // 3 requests just before t=1000, then check that the window "slides"
    // rather than resetting outright at t=1000 like fixedWindow would.
    let state;
    for (const ts of [700, 800, 900]) {
      state = slidingWindowLog(state, policy, ts, 1).state;
    }

    // t=1000: all three entries (700, 800, 900) are still within [0, 1000).
    const atBoundary = slidingWindowLog(state, policy, 1000, 1);
    expect(atBoundary.result.allowed).toBe(false);

    // t=1701: the 700ms entry has fallen out of the trailing 1000ms window.
    const afterOldestExpires = slidingWindowLog(state, policy, 1701, 1);
    expect(afterOldestExpires.result.allowed).toBe(true);
  });

  it('does not charge a rejected request', () => {
    let state;
    for (let i = 0; i < 3; i++) {
      state = slidingWindowLog(state, policy, 0, 1).state;
    }

    const rejected = slidingWindowLog(state, policy, 0, 1);
    expect(rejected.result.allowed).toBe(false);
    expect(rejected.state.entries).toHaveLength(3);
  });
});
