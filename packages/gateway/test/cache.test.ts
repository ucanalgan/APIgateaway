import { describe, expect, it } from 'vitest';
import { buildCacheKey, cacheKeyPrefix, stripUncacheableHeaders } from '../src/cache/index.js';
import { gatewayConfigSchema, type RouteConfig } from '../src/config/schema.js';

function routeWithCache(varyBy: string[] = []): RouteConfig {
  return gatewayConfigSchema.parse({
    routes: [
      {
        id: 'r',
        match: { path: '/*' },
        upstream: { targets: ['http://upstream'] },
        cache: { enabled: true, ttlSec: 60, varyBy },
      },
    ],
  }).routes[0]!;
}

describe('buildCacheKey', () => {
  it('is stable for the same method/path/headers', () => {
    const route = routeWithCache();
    const a = buildCacheKey(route, 'GET', '/x', {}, undefined);
    const b = buildCacheKey(route, 'GET', '/x', {}, undefined);
    expect(a).toBe(b);
  });

  it('differs by path', () => {
    const route = routeWithCache();
    expect(buildCacheKey(route, 'GET', '/x', {}, undefined)).not.toBe(
      buildCacheKey(route, 'GET', '/y', {}, undefined),
    );
  });

  it('differs by varyBy header value', () => {
    const route = routeWithCache(['Accept-Language']);
    const en = buildCacheKey(route, 'GET', '/x', { 'accept-language': 'en' }, undefined);
    const tr = buildCacheKey(route, 'GET', '/x', { 'accept-language': 'tr' }, undefined);
    expect(en).not.toBe(tr);
  });

  it('ignores a header not listed in varyBy', () => {
    const route = routeWithCache(['Accept-Language']);
    const a = buildCacheKey(route, 'GET', '/x', { 'accept-language': 'en', 'x-irrelevant': 'a' }, undefined);
    const b = buildCacheKey(route, 'GET', '/x', { 'accept-language': 'en', 'x-irrelevant': 'b' }, undefined);
    expect(a).toBe(b);
  });

  it('differs by query string', () => {
    const route = routeWithCache();
    expect(buildCacheKey(route, 'GET', '/items?page=1', {}, undefined)).not.toBe(
      buildCacheKey(route, 'GET', '/items?page=2', {}, undefined),
    );
    expect(buildCacheKey(route, 'GET', '/items?page=1', {}, undefined)).not.toBe(
      buildCacheKey(route, 'GET', '/items', {}, undefined),
    );
  });

  it('groups every variant of one path under the same purge prefix — and nothing else', () => {
    const route = routeWithCache(['Accept-Language']);
    const variants = [
      buildCacheKey(route, 'GET', '/items', {}, undefined),
      buildCacheKey(route, 'GET', '/items?page=2', {}, undefined),
      buildCacheKey(route, 'GET', '/items', { 'accept-language': 'tr' }, undefined),
      buildCacheKey(route, 'GET', '/items', {}, 'tenant-a'),
    ];
    const prefix = cacheKeyPrefix(route.id, '/items');

    for (const key of variants) expect(key.startsWith(prefix)).toBe(true);
    expect(buildCacheKey(route, 'GET', '/items/other', {}, undefined).startsWith(prefix)).toBe(false);
    expect(buildCacheKey(route, 'GET', '/items', {}, undefined).startsWith(cacheKeyPrefix(route.id))).toBe(true);
  });

  it('never lets one route\'s purge prefix match another route\'s keys, even when ids contain ":"', () => {
    const outer = routeWithCache();
    const inner = { ...outer, id: `${outer.id}:nested` };

    const innerKey = buildCacheKey(inner, 'GET', '/x', {}, undefined);

    expect(innerKey.startsWith(cacheKeyPrefix(outer.id))).toBe(false);
  });

  it('scopes the key by tenant — the cross-tenant-leak guard', () => {
    const route = routeWithCache();
    const tenantA = buildCacheKey(route, 'GET', '/x', {}, 'tenant-a');
    const tenantB = buildCacheKey(route, 'GET', '/x', {}, 'tenant-b');
    const anonymous = buildCacheKey(route, 'GET', '/x', {}, undefined);

    expect(tenantA).not.toBe(tenantB);
    expect(tenantA).not.toBe(anonymous);
  });
});

describe('stripUncacheableHeaders', () => {
  it('removes set-cookie regardless of casing', () => {
    const result = stripUncacheableHeaders({
      'Set-Cookie': 'session=secret',
      'content-type': 'application/json',
    });

    expect(result['Set-Cookie']).toBeUndefined();
    expect(result['content-type']).toBe('application/json');
  });
});
