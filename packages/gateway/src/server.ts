import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import type { GatewayConfig } from './config/schema.js';
import { matchRoute } from './routing/matcher.js';
import { rewritePath } from './routing/rewrite.js';
import { forwardRequest, UpstreamTimeoutError } from './proxy/forward.js';
import { enforceHeaderLimit } from './security/limits.js';
import { createRateLimitStores, enforceRateLimit } from './ratelimit/index.js';
import { authenticateRequest } from './auth/index.js';
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

  const needsRedis = config.redis && (config.routes.some((route) => route.rateLimit) || apiKeyRoutes.length > 0);
  const redisClient = needsRedis ? new Redis(config.redis!.url) : undefined;

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
  app.addHook('onClose', async () => {
    await Promise.all([...rateLimitStores.values()].map((store) => store.close()));
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
        const proceed = await enforceRateLimit(store, route, request, reply, {
          ...(authOutcome.tenantId !== undefined ? { tenantId: authOutcome.tenantId } : {}),
          ...(authOutcome.plan !== undefined ? { tenantPlan: authOutcome.plan } : {}),
        });
        if (!proceed) return reply;
      }
    }

    const targetPath = rewritePath(request.url, route);
    const target = route.upstream.targets[0];

    if (!target) {
      return reply.code(502).send({
        error: 'bad_gateway',
        message: `Route "${route.id}" has no upstream targets configured.`,
        requestId: request.id,
      });
    }

    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

    try {
      const upstream = await forwardRequest(target, targetPath, {
        method: request.method,
        headers: request.headers,
        body: hasBody ? (request.body as Readable) : undefined,
        timeoutMs: route.upstream.timeoutMs,
        clientIp: request.ip,
        requestId: String(request.id),
      });

      reply.code(upstream.statusCode);
      for (const [key, value] of Object.entries(upstream.headers)) {
        reply.header(key, value);
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

      request.log.error({ err, route: route.id, target }, 'upstream request failed');
      return reply.code(502).send({
        error: 'bad_gateway',
        message: 'Upstream request failed.',
        requestId: request.id,
      });
    }
  });

  return app;
}
