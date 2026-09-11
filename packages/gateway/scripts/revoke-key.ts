import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Redis } from 'ioredis';
import { loadConfig } from '../src/config/load.js';
import { createDbPool } from '../src/db/client.js';
import { revokeApiKey } from '../src/db/repositories/apiKeys.js';
import { apiKeyCacheKey } from '../src/auth/index.js';

const keyId = process.argv[2];
if (!keyId) {
  console.error('Usage: npm run revoke-key -- <api-key-id>');
  process.exit(1);
}

const defaultConfigPath = fileURLToPath(new URL('../../../gateway.yaml', import.meta.url));
const config = loadConfig(process.env['GATEWAY_CONFIG'] ?? defaultConfigPath);

if (!config.db) {
  console.error('gateway.yaml has no top-level "db" block.');
  process.exit(1);
}

const pool = createDbPool(config.db.url);
const redis = config.redis ? new Redis(config.redis.url) : undefined;

async function main(): Promise<void> {
  const revoked = await revokeApiKey(pool, keyId!);

  if (!revoked) {
    console.error(`No active key found with id ${keyId}.`);
    process.exitCode = 1;
    return;
  }

  if (redis) {
    // Sadece DB'de revoke etmek yetmez — cache TTL dolana kadar (60sn) key
    // hâlâ geçerli görünür. "Anında reddedilir" demek bunu da silmek demek.
    await redis.del(apiKeyCacheKey(revoked.hash));
  }

  console.log(`Revoked key ${keyId}. Cache invalidated: ${redis ? 'yes' : 'no redis configured, nothing to clear'}.`);
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
    if (redis) await redis.quit();
  });
