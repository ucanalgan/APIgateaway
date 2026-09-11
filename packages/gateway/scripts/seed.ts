import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/load.js';
import { createDbPool, runMigrations } from '../src/db/client.js';
import { createPlan, findPlanByName, type Plan } from '../src/db/repositories/plans.js';
import { createTenant } from '../src/db/repositories/tenants.js';
import { createApiKey } from '../src/db/repositories/apiKeys.js';

const defaultConfigPath = fileURLToPath(new URL('../../../gateway.yaml', import.meta.url));
const config = loadConfig(process.env['GATEWAY_CONFIG'] ?? defaultConfigPath);

if (!config.db) {
  console.error('gateway.yaml has no top-level "db" block — add one before seeding.');
  process.exit(1);
}

const pool = createDbPool(config.db.url);

async function ensurePlan(name: string, rateLimit: number, windowSec: number, burst: number): Promise<Plan> {
  const existing = await findPlanByName(pool, name);
  if (existing) return existing;
  return createPlan(pool, { name, rateLimit, windowSec, burst });
}

async function main(): Promise<void> {
  await runMigrations(pool);

  const free = await ensurePlan('free', 100, 60, 20);
  await ensurePlan('pro', 1000, 60, 200);

  const tenant = await createTenant(pool, { name: 'demo-tenant', planId: free.id });
  const key = await createApiKey(pool, { tenantId: tenant.id, name: 'seed key' });

  console.log('Seeded:');
  console.log('  plans:  free (100/60s), pro (1000/60s)');
  console.log(`  tenant: ${tenant.name} (${tenant.id}) on plan "free"`);
  console.log(`  key id: ${key.id}  (save this — it's what "npm run revoke-key -- <id>" takes)`);
  console.log(`  raw key (shown once): ${key.raw}`);
  console.log('');
  console.log('Try it against a route with `auth: { type: apiKey }`:');
  console.log(`  curl -H "Authorization: Bearer ${key.raw}" http://localhost:8080/<route-path>`);
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
