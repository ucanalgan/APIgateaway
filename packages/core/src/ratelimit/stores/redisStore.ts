import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Redis } from 'ioredis';
import type { Policy, RateLimitResult, Store } from './Store.js';

export type AlgorithmName =
  | 'fixedWindow'
  | 'tokenBucket'
  | 'leakyBucket'
  | 'slidingWindowLog'
  | 'slidingWindowCounter';

type RateLimitCommand = (
  key: string,
  limit: number,
  windowMs: number,
  capacity: number,
  now: number,
  cost: number,
) => Promise<[allowed: number, remaining: number, retryAfterMs: number]>;

interface RedisWithRateLimitCommands extends Redis {
  rateLimitFixedWindow: RateLimitCommand;
  rateLimitTokenBucket: RateLimitCommand;
  rateLimitLeakyBucket: RateLimitCommand;
  rateLimitSlidingWindowLog: RateLimitCommand;
  rateLimitSlidingWindowCounter: RateLimitCommand;
}

const COMMAND_NAME = {
  fixedWindow: 'rateLimitFixedWindow',
  tokenBucket: 'rateLimitTokenBucket',
  leakyBucket: 'rateLimitLeakyBucket',
  slidingWindowLog: 'rateLimitSlidingWindowLog',
  slidingWindowCounter: 'rateLimitSlidingWindowCounter',
} as const satisfies Record<AlgorithmName, keyof RedisWithRateLimitCommands>;

function loadLua(algorithm: AlgorithmName): string {
  return readFileSync(fileURLToPath(new URL(`../lua/${algorithm}.lua`, import.meta.url)), 'utf8');
}

/**
 * Redis Lua script'leri ile atomik rate limiting — instance'lar arasında
 * paylaşılan state. Her algoritma tek bir Redis key'inde (hash veya zset)
 * yaşar, bu yüzden `reset` her zaman aynı basit silme işlemi.
 */
export function createRedisStore(algorithm: AlgorithmName, redis: Redis): Store {
  const commandName = COMMAND_NAME[algorithm];
  const client = redis as RedisWithRateLimitCommands;

  if (typeof client[commandName] !== 'function') {
    redis.defineCommand(commandName, { numberOfKeys: 1, lua: loadLua(algorithm) });
  }

  return {
    async consume(key: string, policy: Policy, cost = 1): Promise<RateLimitResult> {
      const capacity = policy.burst ?? policy.limit;
      const [allowed, remaining, retryAfterMs] = await client[commandName](
        key,
        policy.limit,
        policy.windowMs,
        capacity,
        Date.now(),
        cost,
      );

      return { allowed: allowed === 1, limit: policy.limit, remaining, retryAfterMs };
    },

    async reset(key: string): Promise<void> {
      if (algorithm === 'slidingWindowLog') {
        await redis.del(key, `${key}:seq`);
      } else {
        await redis.del(key);
      }
    },

    async close(): Promise<void> {
      await redis.quit();
    },
  };
}
