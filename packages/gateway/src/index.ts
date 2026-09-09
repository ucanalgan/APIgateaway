import process from 'node:process';
import { loadConfig } from './config/load.js';
import { buildServer } from './server.js';

const configPath = process.env['GATEWAY_CONFIG'] ?? './gateway.yaml';
const config = loadConfig(configPath);
const server = buildServer(config);

async function start(): Promise<void> {
  try {
    await server.listen({ port: config.server.port, host: '0.0.0.0' });
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

async function shutdown(signal: string): Promise<void> {
  server.log.info(`${signal} received, shutting down`);
  await server.close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

void start();
