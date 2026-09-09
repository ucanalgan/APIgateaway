import { describe, expect, it } from 'vitest';
import { rewritePath } from '../src/routing/rewrite.js';
import { gatewayConfigSchema } from '../src/config/schema.js';

function routeWithStripPrefix(stripPrefix: string) {
  return gatewayConfigSchema.parse({
    routes: [
      {
        id: 'r',
        match: { path: '/api/v1/*' },
        rewrite: { stripPrefix },
        upstream: { targets: ['http://upstream:3000'] },
      },
    ],
  }).routes[0]!;
}

describe('rewritePath', () => {
  it('strips the configured prefix', () => {
    expect(rewritePath('/api/v1/users/42', routeWithStripPrefix('/api/v1'))).toBe('/users/42');
  });

  it('preserves the query string', () => {
    expect(rewritePath('/api/v1/users?active=true', routeWithStripPrefix('/api/v1'))).toBe(
      '/users?active=true',
    );
  });

  it('falls back to / when the prefix strips the entire path', () => {
    expect(rewritePath('/api/v1', routeWithStripPrefix('/api/v1'))).toBe('/');
  });

  it('leaves the path untouched when no rewrite is configured', () => {
    const route = gatewayConfigSchema.parse({
      routes: [{ id: 'r', match: { path: '/*' }, upstream: { targets: ['http://upstream:3000'] } }],
    }).routes[0]!;

    expect(rewritePath('/anything/here', route)).toBe('/anything/here');
  });
});
