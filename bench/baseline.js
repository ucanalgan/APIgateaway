// k6 baseline load test.
//
// Run twice with different BASE_URL values and compare the summaries to see
// how much latency/throughput the gateway adds over hitting the upstream
// directly (see README § Benchmarking for the results table):
//
//   k6 run -e BASE_URL=http://localhost:4000        bench/baseline.js   # direct upstream
//   k6 run -e BASE_URL=http://localhost:8080/bench   bench/baseline.js   # through the gateway (proxy only, no rate limit)
import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:4000';

export const options = {
  scenarios: {
    baseline: {
      executor: 'constant-vus',
      vus: 20,
      duration: '30s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  const res = http.get(`${BASE_URL}/health`);
  check(res, { 'status is 200': (r) => r.status === 200 });
}
