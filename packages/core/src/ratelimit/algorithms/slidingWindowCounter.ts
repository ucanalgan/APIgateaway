import type { Policy } from '../stores/Store.js';
import type { AlgorithmOutput } from './types.js';

export interface SlidingWindowCounterState {
  readonly windowStart: number;
  readonly previousCount: number;
  readonly currentCount: number;
}

/**
 * İki sabit pencerenin ağırlıklı ortalaması — doğruluk/maliyet dengesi,
 * yaklaşık sonuç verir (bkz. PLAN.md §4).
 */
export function slidingWindowCounter(
  state: SlidingWindowCounterState | undefined,
  policy: Policy,
  now: number,
  cost: number,
): AlgorithmOutput<SlidingWindowCounterState> {
  const windowStart = Math.floor(now / policy.windowMs) * policy.windowMs;
  const { previousCount, currentCount } = carryForward(state, windowStart, policy.windowMs);

  const elapsedInWindow = now - windowStart;
  const overlap = Math.max(0, (policy.windowMs - elapsedInWindow) / policy.windowMs);
  const estimate = previousCount * overlap + currentCount;

  const allowed = estimate + cost <= policy.limit;
  const ratePerMs = policy.limit / policy.windowMs;

  return {
    state: { windowStart, previousCount, currentCount: allowed ? currentCount + cost : currentCount },
    result: {
      allowed,
      limit: policy.limit,
      remaining: Math.max(0, Math.floor(policy.limit - (allowed ? estimate + cost : estimate))),
      retryAfterMs: allowed ? 0 : Math.ceil((estimate + cost - policy.limit) / ratePerMs),
    },
  };
}

function carryForward(
  state: SlidingWindowCounterState | undefined,
  windowStart: number,
  windowMs: number,
): { previousCount: number; currentCount: number } {
  if (!state) return { previousCount: 0, currentCount: 0 };
  if (state.windowStart === windowStart) return state;
  if (state.windowStart === windowStart - windowMs) {
    return { previousCount: state.currentCount, currentCount: 0 };
  }
  return { previousCount: 0, currentCount: 0 };
}
