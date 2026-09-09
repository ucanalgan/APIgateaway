import { describe, expect, it } from 'vitest';
import { fixedWindow } from '../../src/ratelimit/algorithms/fixedWindow.js';
import type { Policy } from '../../src/ratelimit/stores/Store.js';

const policy: Policy = { limit: 3, windowMs: 1000 };

describe('fixedWindow', () => {
  it('allows requests up to the limit within a window', () => {
    let state;
    for (let i = 0; i < 3; i++) {
      const out = fixedWindow(state, policy, 0, 1);
      expect(out.result.allowed).toBe(true);
      state = out.state;
    }

    const fourth = fixedWindow(state, policy, 0, 1);
    expect(fourth.result.allowed).toBe(false);
    expect(fourth.result.remaining).toBe(0);
  });

  it('does not charge the counter for a rejected request', () => {
    const first = fixedWindow(undefined, policy, 0, 3);
    expect(first.result.allowed).toBe(true);

    const rejected = fixedWindow(first.state, policy, 0, 1);
    expect(rejected.result.allowed).toBe(false);

    // Same window, quota still exhausted at exactly 3 — the rejection above
    // must not have silently consumed anything.
    expect(rejected.state.count).toBe(3);
  });

  it('resets once the window rolls over', () => {
    const exhausted = fixedWindow(undefined, policy, 0, 3);
    expect(exhausted.result.allowed).toBe(true);

    const nextWindow = fixedWindow(exhausted.state, policy, 1000, 1);
    expect(nextWindow.result.allowed).toBe(true);
    expect(nextWindow.result.remaining).toBe(2);
  });

  it('reports retryAfterMs as time left in the current window', () => {
    const exhausted = fixedWindow(undefined, policy, 100, 3);
    const rejected = fixedWindow(exhausted.state, policy, 400, 1);

    expect(rejected.result.retryAfterMs).toBe(600);
  });
});
