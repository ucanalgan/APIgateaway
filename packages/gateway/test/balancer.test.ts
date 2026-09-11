import { describe, expect, it } from 'vitest';
import { createBalancer } from '../src/proxy/balancer.js';
import { gatewayConfigSchema, type RouteConfig } from '../src/config/schema.js';

function routeWithTargets(targets: string[], circuitBreaker?: { failureThreshold: number; resetTimeoutMs: number }): RouteConfig {
  return gatewayConfigSchema.parse({
    routes: [
      {
        id: 'r',
        match: { path: '/*' },
        upstream: { targets },
        ...(circuitBreaker ? { circuitBreaker } : {}),
      },
    ],
  }).routes[0]!;
}

describe('createBalancer', () => {
  it('cycles through targets round-robin with no breaker configured', () => {
    const balancer = createBalancer(routeWithTargets(['http://a', 'http://b', 'http://c']));

    expect(balancer.pickTarget()).toBe('http://a');
    expect(balancer.pickTarget()).toBe('http://b');
    expect(balancer.pickTarget()).toBe('http://c');
    expect(balancer.pickTarget()).toBe('http://a');

    balancer.close();
  });

  it('reportFailure/reportSuccess are no-ops without a configured breaker', () => {
    const balancer = createBalancer(routeWithTargets(['http://a']));
    balancer.reportFailure('http://a');
    balancer.reportFailure('http://a');
    balancer.reportFailure('http://a');
    // no circuitBreaker configured → always available regardless of failures
    expect(balancer.pickTarget()).toBe('http://a');
    balancer.close();
  });

  it('skips a target whose breaker has opened', () => {
    const balancer = createBalancer(
      routeWithTargets(['http://a', 'http://b'], { failureThreshold: 2, resetTimeoutMs: 1000 }),
    );

    balancer.reportFailure('http://a');
    balancer.reportFailure('http://a'); // a's breaker opens

    // both picks land on b now, a is skipped
    expect(balancer.pickTarget()).toBe('http://b');
    expect(balancer.pickTarget()).toBe('http://b');

    balancer.close();
  });

  it('returns undefined when every target is unavailable', () => {
    const balancer = createBalancer(
      routeWithTargets(['http://a', 'http://b'], { failureThreshold: 1, resetTimeoutMs: 1000 }),
    );

    balancer.reportFailure('http://a');
    balancer.reportFailure('http://b');

    expect(balancer.pickTarget()).toBeUndefined();
    balancer.close();
  });

  it('recovers a target once reportSuccess resets its breaker', () => {
    const balancer = createBalancer(
      routeWithTargets(['http://a', 'http://b'], { failureThreshold: 1, resetTimeoutMs: 1000 }),
    );

    balancer.reportFailure('http://a');
    expect(balancer.pickTarget()).toBe('http://b'); // a skipped

    balancer.reportSuccess('http://a');
    // round-robin cursor is back at index for 'a' next since only b was ever returned
    const picks = [balancer.pickTarget(), balancer.pickTarget()].sort();
    expect(picks).toEqual(['http://a', 'http://b']);

    balancer.close();
  });
});
