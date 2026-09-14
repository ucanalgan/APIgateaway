import { createMemoryStore, type AlgorithmName, type Policy, type Store } from '@apigate/core/ratelimit';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export interface RateLimiterOptions {
  readonly limit: number;
  readonly windowSec: number;
  readonly burst?: number;
  readonly algorithm?: AlgorithmName;
  /** Kendi Store'unu (örn. `createRedisStore`) ver — yoksa in-process memory store. */
  readonly store?: Store;
  readonly keyGenerator?: (req: Request) => string;
}

/** `app.use(rateLimiter({ limit: 100, windowSec: 60 }))` — bu kadar. */
export function rateLimiter(options: RateLimiterOptions): RequestHandler {
  const store = options.store ?? createMemoryStore(options.algorithm ?? 'tokenBucket');
  const policy: Policy = {
    limit: options.limit,
    windowMs: options.windowSec * 1000,
    ...(options.burst !== undefined ? { burst: options.burst } : {}),
  };
  const keyGenerator = options.keyGenerator ?? ((req: Request) => req.ip ?? 'unknown');

  return function rateLimiterMiddleware(req: Request, res: Response, next: NextFunction): void {
    store
      .consume(keyGenerator(req), policy)
      .then((result) => {
        res.setHeader('RateLimit-Limit', result.limit);
        res.setHeader('RateLimit-Remaining', result.remaining);
        res.setHeader('RateLimit-Reset', Math.ceil(result.retryAfterMs / 1000));

        if (!result.allowed) {
          const retryAfterSec = Math.ceil(result.retryAfterMs / 1000);
          res.setHeader('Retry-After', retryAfterSec);
          res.status(429).json({
            error: 'rate_limit_exceeded',
            message: `Rate limit exceeded. Retry after ${retryAfterSec} seconds.`,
            retryAfter: retryAfterSec,
          });
          return;
        }

        next();
      })
      .catch(next);
  };
}
