import type { Policy } from '../stores/Store.js';
import type { AlgorithmOutput } from './types.js';

export interface LeakyBucketState {
  readonly level: number;
  readonly lastLeakMs: number;
}

/**
 * Sabit hızda boşalan kuyruk. Çıkışı düzleştirir ama burst'ü emmez
 * (bkz. PLAN.md §4).
 */
export function leakyBucket(
  state: LeakyBucketState | undefined,
  policy: Policy,
  now: number,
  cost: number,
): AlgorithmOutput<LeakyBucketState> {
  const capacity = policy.burst ?? policy.limit;
  const leakPerMs = policy.limit / policy.windowMs;
  const lastLeakMs = state?.lastLeakMs ?? now;
  const elapsed = Math.max(0, now - lastLeakMs);
  const level = Math.max(0, (state?.level ?? 0) - elapsed * leakPerMs);

  const allowed = level + cost <= capacity;
  const nextLevel = allowed ? level + cost : level;

  return {
    state: { level: nextLevel, lastLeakMs: now },
    result: {
      allowed,
      limit: policy.limit,
      remaining: Math.max(0, Math.floor(capacity - nextLevel)),
      retryAfterMs: allowed ? 0 : Math.ceil((level + cost - capacity) / leakPerMs),
    },
  };
}
