import { describe, expect, it } from 'vitest';
import { createMetrics } from '../src/observability/metrics.js';

describe('createMetrics', () => {
  it('exposes all the counters/gauges/histograms named in PLAN.md §10', async () => {
    const metrics = createMetrics();

    metrics.recordRequest('r', 200, 0.01, 'tenant-1');
    metrics.recordRateLimitDecision('r', 'allowed');
    metrics.recordCacheResult('r', 'hit');
    metrics.recordUpstreamError('r', 'timeout');
    metrics.setCircuitState('r', 'open');
    metrics.setUpstreamHealthy('r', 'http://a', true);
    metrics.observeRedisLatency(0.002);

    const output = await metrics.registry.metrics();

    for (const name of [
      'apigate_requests_total',
      'apigate_request_duration_seconds',
      'apigate_ratelimit_decisions_total',
      'apigate_cache_total',
      'apigate_upstream_errors_total',
      'apigate_circuit_state',
      'apigate_upstream_healthy',
      'apigate_redis_latency_seconds',
    ]) {
      expect(output).toContain(name);
    }
  });

  it('maps circuit state to the documented 0/1/2 values', async () => {
    const metrics = createMetrics();
    metrics.setCircuitState('r', 'closed');
    metrics.setCircuitState('r2', 'open');
    metrics.setCircuitState('r3', 'half-open');

    const output = await metrics.registry.metrics();

    expect(output).toContain('apigate_circuit_state{route="r"} 0');
    expect(output).toContain('apigate_circuit_state{route="r2"} 1');
    expect(output).toContain('apigate_circuit_state{route="r3"} 2');
  });

  it('labels requests by route/status/tenant', async () => {
    const metrics = createMetrics();
    metrics.recordRequest('echo', 404, 0.005, undefined);

    const output = await metrics.registry.metrics();
    expect(output).toContain('apigate_requests_total{route="echo",status="404",tenant=""} 1');
  });
});
