import { readFileSync } from 'node:fs';
import { load as parseYaml } from 'js-yaml';
import { gatewayConfigSchema, type GatewayConfig } from './schema.js';

export function loadConfig(path: string): GatewayConfig {
  const raw = readFileSync(path, 'utf8');
  const parsed = parseYaml(raw);
  const result = gatewayConfigSchema.safeParse(parsed);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid config at ${path}:\n${issues}`);
  }

  return result.data;
}
