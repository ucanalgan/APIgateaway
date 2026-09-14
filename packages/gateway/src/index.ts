import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from './config/load.js';
import { buildServer } from './server.js';

// packages/gateway/src/index.ts (or dist/index.js) → repo root is 3 levels up.
// Resolving from the module's own location (rather than process.cwd()) means
// `gateway.yaml` is found the same way whether started via `npm run dev`,
// directly from packages/gateway, or from the built dist/ output in Docker.
const defaultConfigPath = fileURLToPath(new URL('../../../gateway.yaml', import.meta.url));
const configPath = process.env['GATEWAY_CONFIG'] ?? defaultConfigPath;
const config = loadConfig(configPath);

async function shutdown(server: FastifyInstance, signal: string): Promise<void> {
  server.log.info(`${signal} received, shutting down`);
  await server.close();
  process.exit(0);
}

async function main(): Promise<void> {
  const server = await buildServer(config, configPath);

  process.on('SIGTERM', () => void shutdown(server, 'SIGTERM'));
  process.on('SIGINT', () => void shutdown(server, 'SIGINT'));

  try {
    await server.listen({ port: config.server.port, host: '0.0.0.0' });
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

void main();
