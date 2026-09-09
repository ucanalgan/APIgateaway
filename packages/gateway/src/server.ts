import Fastify, { type FastifyInstance } from 'fastify';
import type { GatewayConfig } from './config/schema.js';

export function buildServer(config: GatewayConfig): FastifyInstance {
  const app = Fastify({
    logger: true,
    trustProxy: config.server.trustProxyHops > 0,
    bodyLimit: config.server.maxBodyBytes,
    requestTimeout: config.server.requestTimeoutMs,
  });

  app.get('/health', async () => ({ status: 'ok' }));

  return app;
}
