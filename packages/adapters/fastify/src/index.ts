import fp from 'fastify-plugin';
import { createMemoryStore, type AlgorithmName, type Policy, type Store } from '@apigate/core/ratelimit';
import type { FastifyRequest } from 'fastify';

export interface RateLimiterOptions {
  readonly limit: number;
  readonly windowSec: number;
  readonly burst?: number;
  readonly algorithm?: AlgorithmName;
  /** Kendi Store'unu (örn. `createRedisStore`) ver — yoksa in-process memory store. */
  readonly store?: Store;
  readonly keyGenerator?: (request: FastifyRequest) => string;
}

/**
 * `app.register(rateLimiter, { limit: 100, windowSec: 60 })` — 15 satırlık
 * bir Fastify uygulamasına bunu eklemek yeterli. `fastify-plugin` ile
 * sarılı, o yüzden `onRequest` hook'u nereye register edilirse edilsin
 * (encapsulation'a takılmadan) uygulanır.
 */
export const rateLimiter = fp<RateLimiterOptions>(async (app, options) => {
  const store = options.store ?? createMemoryStore(options.algorithm ?? 'tokenBucket');
  const policy: Policy = {
    limit: options.limit,
    windowMs: options.windowSec * 1000,
    ...(options.burst !== undefined ? { burst: options.burst } : {}),
  };
  const keyGenerator = options.keyGenerator ?? ((request: FastifyRequest) => request.ip);

  app.addHook('onRequest', async (request, reply) => {
    const result = await store.consume(keyGenerator(request), policy);

    reply.header('RateLimit-Limit', result.limit);
    reply.header('RateLimit-Remaining', result.remaining);
    reply.header('RateLimit-Reset', Math.ceil(result.retryAfterMs / 1000));

    if (!result.allowed) {
      const retryAfterSec = Math.ceil(result.retryAfterMs / 1000);
      reply.header('Retry-After', retryAfterSec);
      await reply.code(429).send({
        error: 'rate_limit_exceeded',
        message: `Rate limit exceeded. Retry after ${retryAfterSec} seconds.`,
        retryAfter: retryAfterSec,
      });
    }
  });

  // Sadece biz oluşturduysak kapatıyoruz — kendi Store'unu (örn. paylaşılan
  // bir Redis client'ı saran) verdiyse ömrü çağıranın sorumluluğunda.
  if (!options.store) {
    app.addHook('onClose', async () => {
      await store.close();
    });
  }
}, { name: '@apigate/adapter-fastify' });

export default rateLimiter;
