import { describe, expect, it } from 'vitest';
import { gatewayConfigSchema } from '../src/config/schema.js';

describe('gatewayConfigSchema', () => {
  it('applies defaults when only required fields are given', () => {
    const result = gatewayConfigSchema.parse({});

    expect(result.server.port).toBe(8080);
    expect(result.server.watch).toBe(false);
    expect(result.routes).toEqual([]);
    expect(result.admin).toBeUndefined();
  });

  it('accepts an admin token', () => {
    const result = gatewayConfigSchema.parse({ admin: { token: 'secret' } });
    expect(result.admin).toEqual({ token: 'secret' });
  });

  it('rejects an empty admin token', () => {
    const result = gatewayConfigSchema.safeParse({ admin: { token: '' } });
    expect(result.success).toBe(false);
  });

  it('rejects a route without an upstream target', () => {
    const result = gatewayConfigSchema.safeParse({
      routes: [{ id: 'bad', match: { path: '/x' }, upstream: { targets: [] } }],
    });

    expect(result.success).toBe(false);
  });

  it('accepts a fully specified route', () => {
    const result = gatewayConfigSchema.parse({
      routes: [
        {
          id: 'users-api',
          match: { path: '/api/v1/users/*', methods: ['GET', 'POST'] },
          upstream: { targets: ['http://users-service:3000'] },
          rateLimit: { limit: 100, windowSec: 60 },
        },
      ],
    });

    expect(result.routes[0]?.auth.type).toBe('none');
    expect(result.routes[0]?.rateLimit?.algorithm).toBe('tokenBucket');
  });
});
