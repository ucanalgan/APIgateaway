import type { Policy, RateLimitResult, Store } from './Store.js';
import type { Algorithm } from '../algorithms/types.js';
import { fixedWindow } from '../algorithms/fixedWindow.js';
import { tokenBucket } from '../algorithms/tokenBucket.js';
import { leakyBucket } from '../algorithms/leakyBucket.js';
import { slidingWindowLog } from '../algorithms/slidingWindowLog.js';
import { slidingWindowCounter } from '../algorithms/slidingWindowCounter.js';

export type AlgorithmName =
  | 'fixedWindow'
  | 'tokenBucket'
  | 'leakyBucket'
  | 'slidingWindowLog'
  | 'slidingWindowCounter';

/**
 * In-process Map ile state tutar. JS tek thread'li olduğu için `consume`
 * içinde `await` olmadığı sürece oku-hesapla-yaz doğal olarak atomiktir —
 * testler bunu doğruluyor (bkz. test/ratelimit/memoryStore.test.ts).
 * Çoklu instance'ta paylaşılmaz; dağıtık kullanım için redisStore.ts.
 */
export function createMemoryStore(algorithm: AlgorithmName): Store {
  switch (algorithm) {
    case 'fixedWindow':
      return fromAlgorithm(fixedWindow);
    case 'tokenBucket':
      return fromAlgorithm(tokenBucket);
    case 'leakyBucket':
      return fromAlgorithm(leakyBucket);
    case 'slidingWindowLog':
      return fromAlgorithm(slidingWindowLog);
    case 'slidingWindowCounter':
      return fromAlgorithm(slidingWindowCounter);
  }
}

function fromAlgorithm<TState>(apply: Algorithm<TState>): Store {
  const state = new Map<string, TState>();

  return {
    consume(key: string, policy: Policy, cost = 1): Promise<RateLimitResult> {
      const { state: nextState, result } = apply(state.get(key), policy, Date.now(), cost);
      state.set(key, nextState);
      return Promise.resolve(result);
    },
    reset(key: string): Promise<void> {
      state.delete(key);
      return Promise.resolve();
    },
    close(): Promise<void> {
      state.clear();
      return Promise.resolve();
    },
  };
}
