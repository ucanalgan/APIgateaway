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

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/**
 * `cache:<routeId>:<pathHash>:<variantHash>` — anahtar iki katmanlı, ki purge
 * ön ek ile yapılabilsin: `cache:<routeId>:` route'un tamamını,
 * `cache:<routeId>:<pathHash>:` ise o path'in tüm varyantlarını (query string,
 * tenant, varyBy) kapsar. `routeId` URL-encode edilir — aksi halde `a:b` id'li
 * bir route'un anahtarları `a` route'unun önekine düşer ve purge onları da siler.
 */
export function cacheKeyPrefix(routeId: string, path?: string): string {
  const routePart = `cache:${encodeURIComponent(routeId)}:`;
  return path === undefined ? routePart : `${routePart}${sha256(path)}:`;
}

/**
 * `url` = path + query string (client'ın gördüğü, rewrite öncesi). Query string
 * anahtarın parçası: `/items?page=1` ile `/items?page=2` ayrı kayıtlardır.
 * Varyant hash'i method + query + (auth varsa) tenantId + `varyBy`'daki header
 * değerlerini kapsar. tenantId'nin key'e girmesi bilinçli: `varyBy` sadece
 * format header'ları (Accept-Language gibi) için, auth izolasyonu için
 * güvenilecek bir mekanizma değil — aksi halde bir tenant'ın cache'lenmiş
 * yanıtı başka bir tenant'a servis edilebilir.
 */
export function buildCacheKey(
  route: RouteConfig,
  method: string,
  url: string,
  headers: IncomingHttpHeaders,
  tenantId: string | undefined,
  host?: string,
): string {
  const queryStart = url.indexOf('?');
  const path = queryStart === -1 ? url : url.slice(0, queryStart);
  const query = queryStart === -1 ? '' : url.slice(queryStart + 1);

  const varyBy = route.cache?.varyBy ?? [];
  const varyParts = varyBy.map((name) => {
    const value = headers[name.toLowerCase()];
    return `${name.toLowerCase()}=${Array.isArray(value) ? value.join(',') : (value ?? '')}`;
  });

  // Host'a göre eşleşen bir route (özellikle `*.example.com`) birden çok host'a
  // cevap verir ve upstream içeriği host'a göre değiştirebilir (alt alan adı
  // başına tenant) — host anahtara girmezse `acme.x.com/panel` cevabı
  // `globex.x.com/panel`'e servis edilirdi. Host'suz route'lar için girmez:
  // aynı içeriği her host altında sunuyorlar, girmesi cache'i boşuna böler.
  const hostPart = route.match.host ? `host:${host ?? ''}` : '';

  const variant = [method, query, tenantId ? `tenant:${tenantId}` : '', hostPart, ...varyParts].join('|');
  return `${cacheKeyPrefix(route.id, path)}${sha256(variant)}`;
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
