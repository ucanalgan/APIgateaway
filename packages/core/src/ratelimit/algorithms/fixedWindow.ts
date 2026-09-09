import type { Policy } from '../stores/Store.js';
import type { AlgorithmOutput } from './types.js';

export interface FixedWindowState {
  readonly windowStart: number;
  readonly count: number;
}

/**
 * Sabit aralıkta sayaç. Pencere sınırında burst'e izin verir (bkz. PLAN.md §4)
 * ama en basit ve en ucuz algoritma.
 */
export function fixedWindow(
  state: FixedWindowState | undefined,
  policy: Policy,
  now: number,
  cost: number,
): AlgorithmOutput<FixedWindowState> {
  const windowStart = Math.floor(now / policy.windowMs) * policy.windowMs;
  const currentCount = state && state.windowStart === windowStart ? state.count : 0;
  const projected = currentCount + cost;
  const allowed = projected <= policy.limit;
  const count = allowed ? projected : currentCount;

  return {
    state: { windowStart, count },
    result: {
      allowed,
      limit: policy.limit,
      remaining: Math.max(0, policy.limit - count),
      retryAfterMs: allowed ? 0 : windowStart + policy.windowMs - now,
    },
  };
}
