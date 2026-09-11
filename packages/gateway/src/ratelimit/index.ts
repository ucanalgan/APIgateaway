import type { Redis } from 'ioredis';
import { createMemoryStore, createRedisStore, type Policy, type RateLimitResult, type Store } from '@apigate/core/ratelimit';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { GatewayConfig, RouteConfig } from '../config/schema.js';
import type { TenantPlan } from '../auth/index.js';

/**
 * `redisClient` verilmişse (config.redis + auth ya da rate limit onu
 * gerektiriyorsa) tüm rate-limited route'lar onu paylaşır — distributed.
 * Verilmemişse her route kendi in-process memory store'unu alır.
 */
export function createRateLimitStores(config: GatewayConfig, redisClient: Redis | undefined): Map<string, Store> {
  const stores = new Map<string, Store>();

  for (const route of config.routes) {
    if (!route.rateLimit) continue;

    const store = redisClient
      ? createRedisStore(route.rateLimit.algorithm, redisClient)
      : createMemoryStore(route.rateLimit.algorithm);

    stores.set(route.id, store);
  }

  return stores;
}

export interface RateLimitContext {
  /** Auth başarılıysa dolu — bkz. auth/index.ts. */
  readonly tenantId?: string;
  /** apiKey auth'ta plan tablosundan gelir; doluysa route config yerine bunu kullan. */
  readonly tenantPlan?: TenantPlan;
}

/**
 * Route'un `keyBy` listesindeki her stratejiyi ayrı ayrı tüketir (bkz.
 * PLAN.md §5: "Üçü aynı anda uygulanabilir; herhangi biri reddederse istek
 * reddedilir"). Standart header'ları yazar; aşılmışsa 429 gönderir.
 * `false` dönerse handler zaten yanıt verdi demektir.
 *
 * Store'un kendisi hata verirse (örn. Redis'e ulaşılamıyor), `failOpen`
 * kararı devreye girer — bkz. PLAN.md §9 "rate limiter'ın kendisi outage
 * sebebi olmamalı".
 */
export async function enforceRateLimit(
  store: Store,
  route: RouteConfig,
  request: FastifyRequest,
  reply: FastifyReply,
  context: RateLimitContext = {},
  failOpen = true,
): Promise<boolean> {
  const config = route.rateLimit;
  if (!config) return true;

  const routePolicy: Policy = {
    limit: config.limit,
    windowMs: config.windowSec * 1000,
    ...(config.burst !== undefined ? { burst: config.burst } : {}),
  };

  const checks: Array<{ key: string; policy: Policy }> = [];

  for (const strategy of config.keyBy) {
    if (strategy === 'ip') {
      checks.push({ key: `ip:${request.ip}:route:${route.id}`, policy: routePolicy });
    } else if (context.tenantId) {
      const plan = context.tenantPlan;
      checks.push({
        key: `tenant:${context.tenantId}:route:${route.id}`,
        policy: plan
          ? { limit: plan.limit, windowMs: plan.windowSec * 1000, burst: plan.burst }
          : routePolicy,
      });
    }
    // keyBy içinde 'tenant' var ama istek anonimse o strateji sessizce atlanır
    // — anonim istek zaten auth katmanında reddedilmiş olurdu (route auth
    // gerektiriyorsa), yoksa tenant'sız kontrol edilecek bir şey yok.
  }

  if (checks.length === 0) return true;

  let results: RateLimitResult[];
  try {
    results = await Promise.all(checks.map((check) => store.consume(check.key, check.policy)));
  } catch (err) {
    request.log.error({ err, route: route.id, failOpen }, 'rate limit store unavailable');

    if (failOpen) return true;

    await reply.code(503).send({
      error: 'rate_limit_unavailable',
      message: 'Rate limiting is temporarily unavailable.',
      requestId: request.id,
    });
    return false;
  }

  const rejected = results.find((r) => !r.allowed);
  const reported: RateLimitResult = rejected ?? results[0]!;

  reply.header('RateLimit-Limit', reported.limit);
  reply.header('RateLimit-Remaining', reported.remaining);
  reply.header('RateLimit-Reset', Math.ceil(reported.retryAfterMs / 1000));

  if (rejected) {
    const retryAfterSec = Math.ceil(rejected.retryAfterMs / 1000);
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
