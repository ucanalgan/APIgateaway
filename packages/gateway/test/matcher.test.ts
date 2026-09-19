import { describe, expect, it } from 'vitest';
import { matchRoute, matchRouteByPath, normalizeHost } from '../src/routing/matcher.js';
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

const hostRoutes = gatewayConfigSchema.parse({
  routes: [
    { id: 'acme', match: { host: 'api.acme.test', path: '/*' }, upstream: { targets: ['http://acme'] } },
    { id: 'wild', match: { host: '*.sites.test', path: '/*' }, upstream: { targets: ['http://wild'] } },
    { id: 'anyhost', match: { path: '/public/*' }, upstream: { targets: ['http://any'] } },
  ],
}).routes;

describe('matchRoute — host', () => {
  it('matches an exact host, ignoring case and a trailing FQDN dot', () => {
    for (const host of ['api.acme.test', 'API.Acme.TEST', 'api.acme.test.']) {
      expect(matchRoute(hostRoutes, { method: 'GET', path: '/x', host })?.id).toBe('acme');
    }
  });

  it('does not match a different host', () => {
    expect(matchRoute(hostRoutes, { method: 'GET', path: '/x', host: 'evil.test' })).toBeUndefined();
    expect(matchRoute(hostRoutes, { method: 'GET', path: '/x', host: 'notapi.acme.test' })).toBeUndefined();
    expect(matchRoute(hostRoutes, { method: 'GET', path: '/x', host: 'api.acme.test.evil.test' })).toBeUndefined();
  });

  it('a "*." pattern matches subdomains at any depth, but never the bare apex', () => {
    expect(matchRoute(hostRoutes, { method: 'GET', path: '/x', host: 'a.sites.test' })?.id).toBe('wild');
    expect(matchRoute(hostRoutes, { method: 'GET', path: '/x', host: 'a.b.sites.test' })?.id).toBe('wild');
    expect(matchRoute(hostRoutes, { method: 'GET', path: '/x', host: 'sites.test' })).toBeUndefined();
    expect(matchRoute(hostRoutes, { method: 'GET', path: '/x', host: 'xsites.test' })).toBeUndefined();
  });

  it('a route with no host constraint answers any host — including a missing one', () => {
    expect(matchRoute(hostRoutes, { method: 'GET', path: '/public/a', host: 'whatever.test' })?.id).toBe('anyhost');
    expect(matchRoute(hostRoutes, { method: 'GET', path: '/public/a' })?.id).toBe('anyhost');
  });

  it('a route with a host constraint never matches a request that has no host', () => {
    expect(matchRoute(hostRoutes, { method: 'GET', path: '/x' })).toBeUndefined();
    expect(matchRoute(hostRoutes, { method: 'GET', path: '/x', host: '' })).toBeUndefined();
  });

  it('route order still decides — a host-specific route listed first wins over a later catch-all', () => {
    const ordered = gatewayConfigSchema.parse({
      routes: [
        { id: 'specific', match: { host: 'a.test', path: '/*' }, upstream: { targets: ['http://s'] } },
        { id: 'catch-all', match: { path: '/*' }, upstream: { targets: ['http://c'] } },
      ],
    }).routes;

    expect(matchRoute(ordered, { method: 'GET', path: '/x', host: 'a.test' })?.id).toBe('specific');
    expect(matchRoute(ordered, { method: 'GET', path: '/x', host: 'b.test' })?.id).toBe('catch-all');
  });
});

describe('matchRouteByPath — host', () => {
  it('still applies the host constraint (a preflight must not borrow another host\'s CORS policy)', () => {
    expect(matchRouteByPath(hostRoutes, '/x', 'api.acme.test')?.id).toBe('acme');
    expect(matchRouteByPath(hostRoutes, '/x', 'evil.test')).toBeUndefined();
  });
});

describe('normalizeHost', () => {
  it('lower-cases, drops a trailing dot, and returns undefined for empty input', () => {
    expect(normalizeHost('Example.COM.')).toBe('example.com');
    expect(normalizeHost('')).toBeUndefined();
    expect(normalizeHost(undefined)).toBeUndefined();
    expect(normalizeHost('.')).toBeUndefined();
  });
});
