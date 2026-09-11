import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { Redis } from 'ioredis';
import {
  createMemoryCacheStore,
  createRedisCacheStore,
  type CacheStore,
} from '@apigate/core/cache';
import type { GatewayConfig, RouteConfig } from '../config/schema.js';

/** Aynı desen: redis verilmişse paylaşılır (distributed), yoksa her route kendi memory store'unu alır. */
export function createCacheStores(config: GatewayConfig, redisClient: Redis | undefined): Map<string, CacheStore> {
  const stores = new Map<string, CacheStore>();

  for (const route of config.routes) {
    if (!route.cache?.enabled) continue;
    stores.set(route.id, redisClient ? createRedisCacheStore(redisClient) : createMemoryCacheStore());
  }

  return stores;
}

/**
 * `cache:<routeId>:<hash>` — hash; method + path + (auth varsa) tenantId +
 * `varyBy`'daki header değerlerini kapsar. tenantId'nin key'e girmesi
 * bilinçli: `varyBy` sadece format header'ları (Accept-Language gibi) için,
 * auth izolasyonu için güvenilecek bir mekanizma değil — aksi halde bir
 * tenant'ın cache'lenmiş yanıtı başka bir tenant'a servis edilebilir.
 */
export function buildCacheKey(
  route: RouteConfig,
  method: string,
  path: string,
  headers: IncomingHttpHeaders,
  tenantId: string | undefined,
): string {
  const varyBy = route.cache?.varyBy ?? [];
  const varyParts = varyBy.map((name) => {
    const value = headers[name.toLowerCase()];
    return `${name.toLowerCase()}=${Array.isArray(value) ? value.join(',') : (value ?? '')}`;
  });

  const raw = [method, path, tenantId ? `tenant:${tenantId}` : '', ...varyParts].join('|');
  const hash = createHash('sha256').update(raw).digest('hex');
  return `cache:${route.id}:${hash}`;
}

/**
 * Set-Cookie asla cache'lenmemeli — aksi halde bir kullanıcının session
 * cookie'si başka bir client'a servis edilebilir (bilinen bir caching açığı).
 */
export function stripUncacheableHeaders(
  headers: Record<string, string | string[]>,
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'set-cookie') continue;
    result[key] = value;
  }
  return result;
}
