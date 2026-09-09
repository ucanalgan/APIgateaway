import type { Policy } from '../stores/Store.js';
import type { AlgorithmOutput } from './types.js';

export interface TokenBucketState {
  readonly tokens: number;
  readonly lastRefillMs: number;
}

/**
 * Sabit hızda dolan kova. Kısa burst'lere izin verirken ortalama hızı korur —
 * gerçek trafik için varsayılan algoritma (bkz. PLAN.md §4).
 */
export function tokenBucket(
  state: TokenBucketState | undefined,
  policy: Policy,
  now: number,
  cost: number,
): AlgorithmOutput<TokenBucketState> {
  const capacity = policy.burst ?? policy.limit;
  const refillPerMs = policy.limit / policy.windowMs;
  const lastRefillMs = state?.lastRefillMs ?? now;
  const elapsed = Math.max(0, now - lastRefillMs);
  const available = Math.min(capacity, (state?.tokens ?? capacity) + elapsed * refillPerMs);

  const allowed = available >= cost;
  const tokens = allowed ? available - cost : available;

  return {
    state: { tokens, lastRefillMs: now },
    result: {
      allowed,
      limit: policy.limit,
      remaining: Math.floor(tokens),
      retryAfterMs: allowed ? 0 : Math.ceil((cost - available) / refillPerMs),
    },
  };
}
