import { describe, expect, it } from 'vitest';
import { slidingWindowCounter } from '../../src/ratelimit/algorithms/slidingWindowCounter.js';
import type { Policy } from '../../src/ratelimit/stores/Store.js';

const policy: Policy = { limit: 10, windowMs: 1000 };

describe('slidingWindowCounter', () => {
  it('allows up to the limit within a single window', () => {
    let state;
    for (let i = 0; i < 10; i++) {
      const out = slidingWindowCounter(state, policy, 100, 1);
      expect(out.result.allowed).toBe(true);
      state = out.state;
    }

    const eleventh = slidingWindowCounter(state, policy, 100, 1);
    expect(eleventh.result.allowed).toBe(false);
  });

  it('weighs the previous window down as the current window progresses', () => {
    // Fill the first window completely at t=900 (near its end).
    const full = slidingWindowCounter(undefined, policy, 900, 10);
    expect(full.result.allowed).toBe(true);

    // t=1050: 5% into the new window, ~95% of the previous window's count
    // still counts against the estimate → still effectively full.
    const justAfterRollover = slidingWindowCounter(full.state, policy, 1050, 1);
    expect(justAfterRollover.result.allowed).toBe(false);

    // t=1950: 95% into the new window, only ~5% of the previous count
    // remains in the estimate → there's room again.
    const laterInNewWindow = slidingWindowCounter(full.state, policy, 1950, 1);
    expect(laterInNewWindow.result.allowed).toBe(true);
  });

  it('does not charge a rejected request', () => {
    const full = slidingWindowCounter(undefined, policy, 0, 10);
    const rejected = slidingWindowCounter(full.state, policy, 0, 1);

    expect(rejected.result.allowed).toBe(false);
    expect(rejected.state.currentCount).toBe(10);
  });
});
