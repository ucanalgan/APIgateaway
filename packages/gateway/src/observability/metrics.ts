import client from 'prom-client';

export interface Metrics {
  readonly registry: client.Registry;
  recordRequest(route: string, status: number, durationSec: number, tenantId: string | undefined): void;
  recordRateLimitDecision(route: string, decision: 'allowed' | 'blocked'): void;
  recordCacheResult(route: string, result: 'hit' | 'miss'): void;
  recordUpstreamError(route: string, type: string): void;
  setCircuitState(route: string, state: 'closed' | 'open' | 'half-open'): void;
  setUpstreamHealthy(route: string, target: string, healthy: boolean): void;
  observeRedisLatency(seconds: number): void;
}

const CIRCUIT_STATE_VALUE: Record<'closed' | 'open' | 'half-open', number> = {
  closed: 0,
  open: 1,
  'half-open': 2,
};

/** bkz. PLAN.md §10 — isimler ve label'lar oradaki spesifikasyonla birebir. */
export function createMetrics(): Metrics {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });

  const requestsTotal = new client.Counter({
    name: 'apigate_requests_total',
    help: 'Total requests handled by the gateway',
    labelNames: ['route', 'status', 'tenant'],
    registers: [registry],
  });

  const requestDuration = new client.Histogram({
    name: 'apigate_request_duration_seconds',
    help: 'Request duration in seconds',
    labelNames: ['route'],
    registers: [registry],
  });

  const ratelimitDecisions = new client.Counter({
    name: 'apigate_ratelimit_decisions_total',
    help: 'Rate limit decisions',
    labelNames: ['route', 'decision'],
    registers: [registry],
  });

  const cacheTotal = new client.Counter({
    name: 'apigate_cache_total',
    help: 'Cache lookups',
    labelNames: ['route', 'result'],
    registers: [registry],
  });

  const upstreamErrors = new client.Counter({
    name: 'apigate_upstream_errors_total',
    help: 'Upstream errors',
    labelNames: ['route', 'type'],
    registers: [registry],
  });

  const circuitState = new client.Gauge({
    name: 'apigate_circuit_state',
    help: '0=closed 1=open 2=half-open',
    labelNames: ['route'],
    registers: [registry],
  });

  const upstreamHealthy = new client.Gauge({
    name: 'apigate_upstream_healthy',
    help: '1=healthy 0=unhealthy',
    labelNames: ['route', 'target'],
    registers: [registry],
  });

  const redisLatency = new client.Histogram({
    name: 'apigate_redis_latency_seconds',
    help: 'Latency of gateway operations backed by Redis (rate limit / cache)',
    buckets: [0.0005, 0.001, 0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25],
    registers: [registry],
  });

  return {
    registry,
    recordRequest(route, status, durationSec, tenantId) {
      requestsTotal.inc({ route, status: String(status), tenant: tenantId ?? '' });
      requestDuration.observe({ route }, durationSec);
    },
    recordRateLimitDecision(route, decision) {
      ratelimitDecisions.inc({ route, decision });
    },
    recordCacheResult(route, result) {
      cacheTotal.inc({ route, result });
    },
    recordUpstreamError(route, type) {
      upstreamErrors.inc({ route, type });
    },
    setCircuitState(route, state) {
      circuitState.set({ route }, CIRCUIT_STATE_VALUE[state]);
    },
    setUpstreamHealthy(route, target, healthy) {
      upstreamHealthy.set({ route, target }, healthy ? 1 : 0);
    },
    observeRedisLatency(seconds) {
      redisLatency.observe(seconds);
    },
  };
}
