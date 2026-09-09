import { describe, expect, it } from 'vitest';
import { matchRoute } from '../src/routing/matcher.js';
import { gatewayConfigSchema } from '../src/config/schema.js';

const routes = gatewayConfigSchema.parse({
  routes: [
    {
      id: 'users-api',
      match: { path: '/api/v1/users/*', methods: ['GET', 'POST'] },
      upstream: { targets: ['http://users-service:3000'] },
    },
    {
      id: 'exact-health',
      match: { path: '/health' },
      upstream: { targets: ['http://health-service:3000'] },
    },
  ],
}).routes;

describe('matchRoute', () => {
  it('matches a wildcard prefix', () => {
    const route = matchRoute(routes, { method: 'GET', path: '/api/v1/users/42' });
    expect(route?.id).toBe('users-api');
  });

  it('matches the wildcard prefix itself with no trailing segment', () => {
    const route = matchRoute(routes, { method: 'GET', path: '/api/v1/users' });
    expect(route?.id).toBe('users-api');
  });

  it('rejects a method not listed for the route', () => {
    const route = matchRoute(routes, { method: 'DELETE', path: '/api/v1/users/42' });
    expect(route).toBeUndefined();
  });

  it('matches an exact path with no configured methods (any method allowed)', () => {
    const route = matchRoute(routes, { method: 'POST', path: '/health' });
    expect(route?.id).toBe('exact-health');
  });

  it('returns undefined when nothing matches', () => {
    const route = matchRoute(routes, { method: 'GET', path: '/nope' });
    expect(route).toBeUndefined();
  });
});
