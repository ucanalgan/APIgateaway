import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { decideCacheability } from '@apigate/core/cache';
import type { GatewayConfig } from './config/schema.js';
import { watchConfig } from './config/watch.js';
import { matchRoute, matchRouteByPath } from './routing/matcher.js';
import { rewritePath } from './routing/rewrite.js';
import { isOriginAllowed, applyCorsResponseHeaders, applyPreflightHeaders } from './cors/index.js';
import { UpstreamTimeoutError } from './proxy/forward.js';
import { createBalancer, type Balancer } from './proxy/balancer.js';
import { forwardWithRetry, NoHealthyTargetError } from './proxy/retry.js';
import { applyRequestTransform } from './proxy/transform.js';
import { bufferStream } from './proxy/bufferStream.js';
import { BodyTooLargeError, enforceBodyLimit, enforceHeaderLimit, limitBodySize } from './security/limits.js';
import { createRateLimitStores, enforceRateLimit } from './ratelimit/index.js';
import { authenticateRequest } from './auth/index.js';
import { createCacheStores, buildCacheKey, cacheKeyPrefix, stripUncacheableHeaders } from './cache/index.js';
import { createDbPool, runMigrations, type DbPool } from './db/client.js';
import { createUsageBuffer } from './usage/buffer.js';
import { createMetrics } from './observability/metrics.js';
import { REDACT_PATHS } from './observability/logger.js';
import { registerAdminRoutes } from './admin/routes.js';
import type { Store } from '@apigate/core/ratelimit';
import type { CacheStore } from '@apigate/core/cache';

declare module 'fastify' {
  interface FastifyRequest {
    apigateTenantId?: string;
    apigateRouteId?: string;
  }
}

function apiKeyRoutesNeedingDb(config: GatewayConfig): string[] {
  return config.routes.filter((route) => route.auth.type === 'apiKey').map((route) => route.id);
}

/**
 * Fastify'ın kendisi (port, body limit, request timeout, admin route'ları)
 * boot'ta sabitlenir — sadece `routes` (ve ondan türeyen balancer/store'lar)
 * hot-reload edilebilir. `redis`/`db`/`admin`/`server` değiştiyse reload
 * reddedilir (bkz. PLAN.md §7 "yeni config doğrulamayı geçemezse eskisi
 * korunur" — burada "geçmemek" bunu da kapsıyor).
 */
function assertHotReloadable(oldConfig: GatewayConfig, newConfig: GatewayConfig): void {
  const immutableSections: Array<keyof GatewayConfig> = ['server', 'redis', 'db', 'admin'];
  for (const key of immutableSections) {
    if (JSON.stringify(oldConfig[key]) !== JSON.stringify(newConfig[key])) {
      throw new Error(`Config section "${key}" changed — this requires a restart, not a hot-reload.`);
    }
  }

  const missingDb = apiKeyRoutesNeedingDb(newConfig);
  if (missingDb.length > 0 && !newConfig.db) {
    throw new Error(`Route(s) ${missingDb.join(', ')} use auth.type "apiKey" but no top-level "db" config is set.`);
  }
}

/**
 * `enableOfflineQueue` kapalıyken bağlantı kurulmadan gönderilen komutlar
 * hemen reddedilir — boot'tan hemen sonraki ilk istekler Redis "down" sayılıp
 * `failOpen` ile sessizce limitsiz geçerdi. Bağlantı hazır olana ya da ilk
 * deneme başarısız olana kadar beklenir; Redis gerçekten down ise açılış
 * bloklanmaz (o zaman `failOpen` politikası zaten devrede olmalı).
 */
function waitForRedis(client: Redis): Promise<void> {
  if (client.status === 'ready') return Promise.resolve();

  return new Promise((resolve) => {
    const finish = (): void => {
      client.off('ready', finish);
      client.off('close', finish);
      resolve();
    };
    client.once('ready', finish);
    client.once('close', finish);
  });
}

/** Redis down iken `quit()` reddedilir (offline queue kapalı) — graceful shutdown'ı bozmasın. */
async function closeRedis(client: Redis): Promise<void> {
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}

interface RuntimeState {
  readonly config: GatewayConfig;
  readonly rateLimitStores: Map<string, Store>;
  readonly cacheStores: Map<string, CacheStore>;
  readonly balancers: Map<string, Balancer>;
}

function buildRuntimeState(config: GatewayConfig, redisClient: Redis | undefined): RuntimeState {
  return {
    config,
    rateLimitStores: createRateLimitStores(config, redisClient),
    cacheStores: createCacheStores(config, redisClient),
    balancers: new Map(config.routes.map((route) => [route.id, createBalancer(route)])),
  };
}

export async function buildServer(initialConfig: GatewayConfig, configPath: string): Promise<FastifyInstance> {
  const missingDb = apiKeyRoutesNeedingDb(initialConfig);
  if (missingDb.length > 0 && !initialConfig.db) {
    throw new Error(`Route(s) ${missingDb.join(', ')} use auth.type "apiKey" but no top-level "db" config is set.`);
  }

  const needsRedis =
    initialConfig.redis &&
    (initialConfig.routes.some((route) => route.rateLimit || route.cache?.enabled) || missingDb.length > 0);

  const dbPool: DbPool | undefined =
    initialConfig.db && (missingDb.length > 0 || initialConfig.admin) ? createDbPool(initialConfig.db.url) : undefined;
  if (dbPool) await runMigrations(dbPool);

  const usageBuffer = dbPool ? createUsageBuffer(dbPool) : undefined;
  const metrics = createMetrics();

  const trustProxyHops = initialConfig.server.trustProxyHops;
  // "N hop güvenilir" demek: bizim doğrudan bağlandığımız taraf (hop 0) ve
  // ondan sonraki N-1 ara proxy güvenilir kabul edilir; X-Forwarded-For'daki
  // ilk güvenilmeyen adres gerçek client sayılır. Güvenlik varsayımı ağ
  // seviyesinde: bu port'a sadece kendi reverse proxy'miz erişebiliyor
  // olmalı — aksi halde saldırgan doğrudan bağlanıp N tane sahte hop
  // uydurabilir (bkz. PLAN.md §5 "IP çıkarımı güvenlik açığı"). Fastify'ın
  // trustProxy'ye sayı verilmesini artık desteklememesi (fail-closed) bu
  // tam yüzden — biz aynı garantiyi ağ seviyesinde varsayıp kendi hop
  // fonksiyonumuzu yazıyoruz.
  const trustProxy: boolean | ((address: string, hop: number) => boolean) =
    trustProxyHops > 0 ? (_address, hop) => hop < trustProxyHops : false;

  // `failOpen`/the auth cache fallback need commands to fail *fast* when
  // Redis is unreachable. ioredis's default is the opposite — it queues
  // commands indefinitely while reconnecting, so a down Redis would hang
  // every request instead of tripping either fallback.
  //
  // Created right before the logger and given its 'error' listener with no
  // `await` in between: ioredis emits 'error' on every failed connection
  // attempt, and one landing before a listener exists is logged straight to
  // stderr, bypassing Fastify's structured logger.
  const redisClient = needsRedis
    ? new Redis(initialConfig.redis!.url, { enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 2000 })
    : undefined;

  const app = Fastify({
    logger: { redact: { paths: REDACT_PATHS, censor: '[redacted]' } },
    trustProxy,
    bodyLimit: initialConfig.server.maxBodyBytes,
    requestTimeout: initialConfig.server.requestTimeoutMs,
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
  });

  redisClient?.on('error', (err: unknown) => {
    app.log.warn({ err }, 'redis connection error');
  });
  dbPool?.on('error', (err: unknown) => {
    app.log.warn({ err }, 'postgres pool error');
  });
  if (redisClient) await waitForRedis(redisClient);

  app.decorateRequest('apigateTenantId', undefined);
  app.decorateRequest('apigateRouteId', undefined);

  // Gateway rastgele içerik tipleri proxy'ler; body'yi parse/buffer etmek
  // yerine olduğu gibi (stream) upstream'e aktarmalıyız.
  app.removeAllContentTypeParsers();
  // Fastify'ın `bodyLimit`'i sadece kendi okuduğu gövdelere uygulanır; stream
  // olarak geçirilenlere değil — limit bu yüzden burada, ayrıca uygulanır.
  app.addContentTypeParser('*', (_request, payload, done) => {
    done(null, limitBodySize(payload, initialConfig.server.maxBodyBytes));
  });

  app.addHook('onRequest', enforceHeaderLimit(initialConfig.server.maxHeaderCount));
  app.addHook('onRequest', enforceBodyLimit(initialConfig.server.maxBodyBytes));
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', request.id);

    // Route eşleşip eşleşmediğine (401/429/5xx dahil) bakmaksızın uygulanır
    // — tarayıcı, CORS header'ı olmayan bir hata gövdesini JS'e hiç
    // göstermez, o yüzden bu her yanıtta çalışmalı, sadece "başarılı" yolda değil.
    const origin = request.headers.origin;
    if (typeof origin === 'string' && request.apigateRouteId) {
      const route = state.config.routes.find((r) => r.id === request.apigateRouteId);
      if (route?.cors?.enabled && isOriginAllowed(route.cors, origin)) {
        applyCorsResponseHeaders(route.cors, origin, reply);
      }
    }

    return payload;
  });

  app.addHook('onResponse', async (request, reply) => {
    metrics.recordRequest(
      request.apigateRouteId ?? 'unmatched',
      reply.statusCode,
      reply.elapsedTime / 1000,
      request.apigateTenantId,
    );

    if (usageBuffer && request.apigateTenantId && request.apigateRouteId) {
      usageBuffer.push({
        tenantId: request.apigateTenantId,
        routeId: request.apigateRouteId,
        statusCode: reply.statusCode,
        latencyMs: Math.round(reply.elapsedTime),
      });
    }
  });

  let state = buildRuntimeState(initialConfig, redisClient);

  function reload(newConfig: GatewayConfig): void {
    assertHotReloadable(state.config, newConfig);

    const oldBalancers = state.balancers;
    // Redis-backed store'ların `.close()`'u paylaşılan `redisClient`'ı
    // kapatır — o yüzden eski store'ları KAPATMIYORUZ, sadece bırakıyoruz
    // (garbage collected). Balancer'lar ise kendi health-check interval'ini
    // tutuyor, bu gerçekten kapatılmalı yoksa her reload bir timer sızdırır.
    state = buildRuntimeState(newConfig, redisClient);
    for (const balancer of oldBalancers.values()) balancer.close();

    app.log.info({ routes: newConfig.routes.map((route) => route.id) }, 'config reloaded');
  }

  const configWatcher = watchConfig(configPath, {
    onReload: reload,
    onError: (err) => app.log.error({ err }, 'config reload failed — keeping the previous config'),
    watchFile: initialConfig.server.watch,
  });

  if (initialConfig.admin && dbPool) {
    await registerAdminRoutes(app, initialConfig.admin.token, {
      db: dbPool,
      ...(redisClient !== undefined ? { redis: redisClient } : {}),
      // `state` hot-reload'da yeniden atanıyor — her çağrıda güncel store'a bakmalı.
      purgeCache: (routeId, path) => {
        const store = state.cacheStores.get(routeId);
        return store ? store.deleteByPrefix(cacheKeyPrefix(routeId, path)) : undefined;
      },
    });
  }

  app.addHook('onClose', async () => {
    configWatcher.close();
    for (const balancer of state.balancers.values()) balancer.close();
    await usageBuffer?.close();
    await dbPool?.end();
    if (redisClient) await closeRedis(redisClient);
  });

  app.get('/health', async (request) => {
    request.apigateRouteId = '__health__';
    return { status: 'ok' };
  });

  app.get('/metrics', async (request, reply) => {
    request.apigateRouteId = '__metrics__';
    // Gauge'lar (circuit state, upstream healthy) event-driven değil —
    // scrape anında balancer'ların gerçek durumundan tazeleniyor. Bu,
    // Prometheus'un pull-model'i için standart yaklaşım.
    for (const [routeId, balancer] of state.balancers) {
      for (const target of balancer.getTargetStates()) {
        metrics.setUpstreamHealthy(routeId, target.url, target.healthy);
        if (target.circuitState) metrics.setCircuitState(routeId, target.circuitState);
      }
    }

    reply.header('content-type', metrics.registry.contentType);
    return metrics.registry.metrics();
  });

  app.all('/*', async (request, reply) => {
    const path = request.url.split('?')[0] ?? '/';

    // CORS preflight: tarayıcı bunu her zaman `OPTIONS` + kendi ürettiği
    // `Access-Control-Request-Method` header'ıyla gönderir — bir istemci
    // script'i bu header'ı asla elle set edemez, o yüzden varlığı tek
    // başına güvenilir bir sinyal. Route'un `match.methods` kısıtı burada
    // yok sayılır (preflight gerçek metotla değil hep OPTIONS ile gelir) ve
    // istek auth/rate-limit/proxy'e hiç girmeden burada cevaplanır —
    // preflight'ın kimlik doğrulaması ya da kotaya sayılması spec'e aykırı.
    const origin = request.headers.origin;
    const isPreflight =
      request.method === 'OPTIONS' &&
      typeof origin === 'string' &&
      typeof request.headers['access-control-request-method'] === 'string';

    if (isPreflight) {
      const corsRoute = matchRouteByPath(state.config.routes, path);
      if (corsRoute?.cors?.enabled && isOriginAllowed(corsRoute.cors, origin)) {
        request.apigateRouteId = corsRoute.id;
        applyPreflightHeaders(corsRoute.cors, origin, reply);
        return reply.code(204).send();
      }
    }

    const route = matchRoute(state.config.routes, { method: request.method, path });

    if (!route) {
      return reply.code(404).send({
        error: 'not_found',
        message: `No route matches ${request.method} ${path}.`,
        requestId: request.id,
      });
    }

    request.apigateRouteId = route.id;

    const authOutcome = await authenticateRequest(route, request, reply, {
      ...(dbPool !== undefined ? { db: dbPool } : {}),
      ...(redisClient !== undefined ? { redis: redisClient } : {}),
    });
    if (!authOutcome.ok) return reply;

    if (authOutcome.tenantId) {
      request.apigateTenantId = authOutcome.tenantId;
    }

    if (route.rateLimit) {
      const store = state.rateLimitStores.get(route.id);
      if (store) {
        const startedAt = process.hrtime.bigint();
        const proceed = await enforceRateLimit(
          store,
          route,
          request,
          reply,
          {
            ...(authOutcome.tenantId !== undefined ? { tenantId: authOutcome.tenantId } : {}),
            ...(authOutcome.plan !== undefined ? { tenantPlan: authOutcome.plan } : {}),
          },
          state.config.redis?.failOpen ?? true,
        );
        metrics.observeRedisLatency(Number(process.hrtime.bigint() - startedAt) / 1e9);
        metrics.recordRateLimitDecision(route.id, proceed ? 'allowed' : 'blocked');
        if (!proceed) return reply;
      }
    }

    const cacheStore = route.cache?.enabled ? state.cacheStores.get(route.id) : undefined;
    const cacheKey =
      cacheStore && request.method === 'GET'
        ? buildCacheKey(route, request.method, request.url, request.headers, authOutcome.tenantId)
        : undefined;

    if (cacheStore && cacheKey) {
      const startedAt = process.hrtime.bigint();
      const cached = await cacheStore.get(cacheKey);
      metrics.observeRedisLatency(Number(process.hrtime.bigint() - startedAt) / 1e9);

      if (cached) {
        metrics.recordCacheResult(route.id, 'hit');
        reply.header('X-Cache', 'HIT');
        reply.code(cached.statusCode);
        for (const [key, value] of Object.entries(cached.headers)) {
          reply.header(key, value);
        }
        return reply.send(cached.body);
      }
    }

    const targetPath = rewritePath(request.url, route);
    const balancer = state.balancers.get(route.id)!;
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

    try {
      const upstream = await forwardWithRetry(route, balancer, targetPath, {
        method: request.method,
        headers: applyRequestTransform(route, request.headers),
        body: hasBody ? (request.body as Readable) : undefined,
        timeoutMs: route.upstream.timeoutMs,
        clientIp: request.ip,
        requestId: String(request.id),
      });

      reply.code(upstream.statusCode);
      for (const [key, value] of Object.entries(upstream.headers)) {
        reply.header(key, value);
      }

      if (cacheStore && cacheKey) {
        // Cache'lemek için tam gövdeyi okumamız gerekiyor — bu route'a özel,
        // bilinçli bir buffering istisnası (bkz. README § Resilience'daki
        // retry buffer'lama ile aynı gerekçe).
        metrics.recordCacheResult(route.id, 'miss');
        reply.header('X-Cache', 'MISS');
        const body = await bufferStream(upstream.body);
        const decision = decideCacheability(upstream.statusCode, upstream.headers, route.cache!.ttlSec);

        if (decision.cacheable && body.byteLength <= state.config.server.maxBodyBytes) {
          const cached = {
            statusCode: upstream.statusCode,
            headers: stripUncacheableHeaders(upstream.headers),
            body,
          };
          const setStartedAt = process.hrtime.bigint();
          cacheStore
            .set(cacheKey, cached, decision.ttlSec)
            .then(() => metrics.observeRedisLatency(Number(process.hrtime.bigint() - setStartedAt) / 1e9))
            .catch((err: unknown) => {
              request.log.warn({ err, route: route.id }, 'failed to write cache entry');
            });
        }

        return reply.send(body);
      }

      return reply.send(upstream.body);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        return reply.code(413).send({
          error: 'payload_too_large',
          message: err.message,
          requestId: request.id,
        });
      }

      if (err instanceof UpstreamTimeoutError) {
        metrics.recordUpstreamError(route.id, 'timeout');
        return reply.code(504).send({
          error: 'upstream_timeout',
          message: err.message,
          requestId: request.id,
        });
      }

      if (err instanceof NoHealthyTargetError) {
        metrics.recordUpstreamError(route.id, 'no_healthy_target');
        return reply.code(503).send({
          error: 'service_unavailable',
          message: err.message,
          requestId: request.id,
        });
      }

      metrics.recordUpstreamError(route.id, 'connection');
      request.log.error({ err, route: route.id }, 'upstream request failed');
      return reply.code(502).send({
        error: 'bad_gateway',
        message: 'Upstream request failed.',
        requestId: request.id,
      });
    }
  });

  return app;
}
