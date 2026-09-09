import type { Policy } from '../stores/Store.js';
import type { AlgorithmOutput } from './types.js';

export interface SlidingWindowLogState {
  readonly entries: ReadonlyArray<readonly [timestampMs: number, cost: number]>;
}

/**
 * Her isteğin timestamp'i tutulur → tam doğru, ama bellek maliyeti yüksek
 * (bkz. PLAN.md §4). Fixed window'un "pencere sınırında 2x" sorununu çözer.
 */
export function slidingWindowLog(
  state: SlidingWindowLogState | undefined,
  policy: Policy,
  now: number,
  cost: number,
): AlgorithmOutput<SlidingWindowLogState> {
  const windowStart = now - policy.windowMs;
  const alive = (state?.entries ?? []).filter(([ts]) => ts > windowStart);
  const currentCount = alive.reduce((sum, [, c]) => sum + c, 0);

  const allowed = currentCount + cost <= policy.limit;
  const entries = allowed ? [...alive, [now, cost] as const] : alive;
  const finalCount = allowed ? currentCount + cost : currentCount;

  return {
    state: { entries },
    result: {
      allowed,
      limit: policy.limit,
      remaining: Math.max(0, policy.limit - finalCount),
      retryAfterMs: allowed ? 0 : (alive[0]?.[0] ?? now) + policy.windowMs - now,
    },
  };
}
