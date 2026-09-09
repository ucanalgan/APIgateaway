import type { Policy, RateLimitResult } from '../stores/Store.js';

export interface AlgorithmOutput<TState> {
  readonly state: TState;
  readonly result: RateLimitResult;
}

/** Her algoritma bu imzada: mevcut state + policy + zaman → yeni state + karar. */
export type Algorithm<TState> = (
  state: TState | undefined,
  policy: Policy,
  now: number,
  cost: number,
) => AlgorithmOutput<TState>;
