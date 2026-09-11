import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { decideCacheability } from '@apigate/core/cache';
import type { GatewayConfig } from './config/schema.js';
import { matchRoute } from './routing/matcher.js';
import { rewritePath } from './routing/rewrite.js';
import { UpstreamTimeoutError } from './proxy/forward.js';
import { createBalancer } from './proxy/balancer.js';
import { forwardWithRetry, NoHealthyTargetError } from './proxy/retry.js';
import { applyRequestTransform } from './proxy/transform.js';
import { bufferStream } from './proxy/bufferStream.js';
import { enforceHeaderLimit } from './security/limits.js';
import { createRateLimitStores, enforceRateLimit } from './ratelimit/index.js';
import { authenticateRequest } from './auth/index.js';
import { createCacheStores, buildCacheKey, stripUncacheableHeaders } from './cache/index.js';
import { createDbPool, runMigrations } from './db/client.js';
import { createUsageBuffer } from './usage/buffer.js';

declare module 'fastify' {
  interface FastifyRequest {
    apigateTenantId?: string;
    apigateRouteId?: string;
  }
}

export async function buildServer(config: GatewayConfig): Promise<FastifyInstance> {
  const apiKeyRoutes = config.routes.filter((route) => route.auth.type === 'apiKey');
  if (apiKeyRoutes.length > 0 && !config.db) {
    throw new Error(
      `Route(s) ${apiKeyRoutes.map((route) => route.id).join(', ')} use auth.type "apiKey" but no top-level ` +
        '"db" config is set.',
    );
  }

  const needsRedis =
    config.redis &&
    (config.routes.some((route) => route.rateLimit || route.cache?.enabled) || apiKeyRoutes.length > 0);
  // `failOpen`/the auth cache fallback need commands to fail *fast* when
  // Redis is unreachable. ioredis's default is the opposite — it queues
  // commands indefinitely while reconnecting, so a down Redis would hang
  // every request instead of tripping either fallback.
  const redisClient = needsRedis
    ? new Redis(config.redis!.url, { enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 2000 })
    : undefined;

  const dbPool = config.db && apiKeyRoutes.length > 0 ? createDbPool(config.db.url) : undefined;
  if (dbPool) await runMigrations(dbPool);

  const usageBuffer = dbPool ? createUsageBuffer(dbPool) : undefined;

  const trustProxyHops = config.server.trustProxyHops;
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

  const app = Fastify({
    logger: true,
    trustProxy,
    bodyLimit: config.server.maxBodyBytes,
    requestTimeout: config.server.requestTimeoutMs,
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
  });

  // ioredis emits 'error' on every failed reconnect attempt; without a
  // listener Node logs "Unhandled error event" straight to stderr, bypassing
  // Fastify's structured logger entirely.
  redisClient?.on('error', (err: unknown) => {
    app.log.warn({ err }, 'redis connection error');
  });

  app.decorateRequest('apigateTenantId', undefined);
  app.decorateRequest('apigateRouteId', undefined);

  // Gateway rastgele içerik tipleri proxy'ler; body'yi parse/buffer etmek
  // yerine olduğu gibi (stream) upstream'e aktarmalıyız.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (_request, payload, done) => {
    done(null, payload);
  });

  app.addHook('onRequest', enforceHeaderLimit(config.server.maxHeaderCount));
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', request.id);
    return payload;
  });

  if (usageBuffer) {
    app.addHook('onResponse', async (request, reply) => {
      if (!request.apigateTenantId || !request.apigateRouteId) return;
      usageBuffer.push({
        tenantId: request.apigateTenantId,
        routeId: request.apigateRouteId,
        statusCode: reply.statusCode,
        latencyMs: Math.round(reply.elapsedTime),
      });
    });
  }

  const rateLimitStores = createRateLimitStores(config, redisClient);
  const cacheStores = createCacheStores(config, redisClient);
  const balancers = new Map(config.routes.map((route) => [route.id, createBalancer(route)]));
  const failOpen = config.redis?.failOpen ?? true;

  app.addHook('onClose', async () => {
    await Promise.all([...rateLimitStores.values()].map((store) => store.close()));
    await Promise.all([...cacheStores.values()].map((store) => store.close()));
    for (const balancer of balancers.values()) balancer.close();
    await usageBuffer?.close();
    await dbPool?.end();
    if (redisClient) await redisClient.quit();
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.all('/*', async (request, reply) => {
    const path = request.url.split('?')[0] ?? '/';
    const route = matchRoute(config.routes, { method: request.method, path });

    if (!route) {
      return reply.code(404).send({
        error: 'not_found',
        message: `No route matches ${request.method} ${path}.`,
        requestId: request.id,
      });
    }

    const authOutcome = await authenticateRequest(route, request, reply, {
      ...(dbPool !== undefined ? { db: dbPool } : {}),
      ...(redisClient !== undefined ? { redis: redisClient } : {}),
    });
    if (!authOutcome.ok) return reply;

    if (authOutcome.tenantId) {
      request.apigateTenantId = authOutcome.tenantId;
      request.apigateRouteId = route.id;
    }

    if (route.rateLimit) {
      const store = rateLimitStores.get(route.id);
      if (store) {
        const proceed = await enforceRateLimit(
          store,
          route,
          request,
          reply,
          {
            ...(authOutcome.tenantId !== undefined ? { tenantId: authOutcome.tenantId } : {}),
            ...(authOutcome.plan !== undefined ? { tenantPlan: authOutcome.plan } : {}),
          },
          failOpen,
        );
        if (!proceed) return reply;
      }
    }

    const cacheStore = route.cache?.enabled ? cacheStores.get(route.id) : undefined;
    const cacheKey =
      cacheStore && request.method === 'GET'
        ? buildCacheKey(route, request.method, path, request.headers, authOutcome.tenantId)
        : undefined;

    if (cacheStore && cacheKey) {
      const cached = await cacheStore.get(cacheKey);
      if (cached) {
        reply.header('X-Cache', 'HIT');
        reply.code(cached.statusCode);
        for (const [key, value] of Object.entries(cached.headers)) {
          reply.header(key, value);
        }
        return reply.send(cached.body);
      }
    }

    const targetPath = rewritePath(request.url, route);
    const balancer = balancers.get(route.id)!;
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
        reply.header('X-Cache', 'MISS');
        const body = await bufferStream(upstream.body);
        const decision = decideCacheability(upstream.statusCode, upstream.headers, route.cache!.ttlSec);

        if (decision.cacheable && body.byteLength <= config.server.maxBodyBytes) {
          const cached = {
            statusCode: upstream.statusCode,
            headers: stripUncacheableHeaders(upstream.headers),
            body,
          };
          cacheStore.set(cacheKey, cached, decision.ttlSec).catch((err: unknown) => {
            request.log.warn({ err, route: route.id }, 'failed to write cache entry');
          });
        }

        return reply.send(body);
      }

      return reply.send(upstream.body);
    } catch (err) {
      if (err instanceof UpstreamTimeoutError) {
        return reply.code(504).send({
          error: 'upstream_timeout',
          message: err.message,
          requestId: request.id,
        });
      }

      if (err instanceof NoHealthyTargetError) {
        return reply.code(503).send({
          error: 'service_unavailable',
          message: err.message,
          requestId: request.id,
        });
      }

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
