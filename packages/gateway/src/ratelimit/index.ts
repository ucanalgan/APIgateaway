import { Redis } from 'ioredis';
import { createMemoryStore, createRedisStore, type Policy, type Store } from '@apigate/core/ratelimit';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { GatewayConfig, RouteConfig } from '../config/schema.js';

/**
 * `config.redis` verilmişse tüm rate-limited route'lar tek bir Redis
 * bağlantısını paylaşır (distributed — birden fazla gateway instance'ı aynı
 * kotayı görür). Verilmemişse her route kendi in-process memory store'unu
 * alır (tek instance için yeterli, bkz. PLAN.md §5).
 */
export function createRateLimitStores(config: GatewayConfig): Map<string, Store> {
  const rateLimitedRoutes = config.routes.filter((route) => route.rateLimit);
  const redisClient =
    config.redis && rateLimitedRoutes.length > 0 ? new Redis(config.redis.url) : undefined;
  const stores = new Map<string, Store>();

  for (const route of rateLimitedRoutes) {
    if (!route.rateLimit) continue;

    const store = redisClient
      ? createRedisStore(route.rateLimit.algorithm, redisClient)
      : createMemoryStore(route.rateLimit.algorithm);

    stores.set(route.id, store);
  }

  return stores;
}

/**
 * Bu route için limiti tüketir, standart header'ları yazar ve aşılmışsa
 * 429 gönderir. `false` dönerse handler zaten yanıt verdi demektir — çağıran
 * proxy'lemeye devam etmemeli.
 */
export async function enforceRateLimit(
  store: Store,
  route: RouteConfig,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  const config = route.rateLimit;
  if (!config) return true;

  const policy: Policy = {
    limit: config.limit,
    windowMs: config.windowSec * 1000,
    ...(config.burst !== undefined ? { burst: config.burst } : {}),
  };

  // Faz 3 kapsamı sadece IP bazlı anahtarlama — tenant bazlı limit auth'a
  // bağımlı (bkz. PLAN.md Faz 4).
  const key = `ip:${request.ip}:route:${route.id}`;
  const result = await store.consume(key, policy);

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
      requestId: request.id,
    });
    return false;
  }

  return true;
}
