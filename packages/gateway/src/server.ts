import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import type { GatewayConfig } from './config/schema.js';
import { matchRoute } from './routing/matcher.js';
import { rewritePath } from './routing/rewrite.js';
import { forwardRequest, UpstreamTimeoutError } from './proxy/forward.js';
import { enforceHeaderLimit } from './security/limits.js';

export function buildServer(config: GatewayConfig): FastifyInstance {
  const app = Fastify({
    logger: true,
    trustProxy: config.server.trustProxyHops > 0,
    bodyLimit: config.server.maxBodyBytes,
    requestTimeout: config.server.requestTimeoutMs,
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
  });

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
