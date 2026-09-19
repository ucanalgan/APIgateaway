import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.js';

const repoFile = (name: string): string => fileURLToPath(new URL(`../../../${name}`, import.meta.url));

// The configs the README tells people to run. Nothing else loads them, so
// without this a schema change could silently break `docker compose up`.
describe('shipped example configs', () => {
  it.each(['gateway.yaml', 'gateway.docker.yaml'])('%s loads and passes schema validation', (file) => {
    const config = loadConfig(repoFile(file));

    expect(config.routes.length).toBeGreaterThan(0);
    expect(new Set(config.routes.map((r) => r.id)).size).toBe(config.routes.length); // ids are unique
  });

  it('gateway.docker.yaml demonstrates host-based routing', () => {
    const route = loadConfig(repoFile('gateway.docker.yaml')).routes.find((r) => r.id === 'tenant-sites');

    expect(route?.match.host).toBe('*.sites.test');
  });
});
