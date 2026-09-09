# APIGate

A framework-agnostic API Gateway and rate limiter, built as a learning project and
as a reusable building block.

**Stack:** TypeScript · Node.js · Fastify · undici · Redis · PostgreSQL · Docker

## Goals

1. **A defensible, well-measured project.** Every architectural decision has a
   reason, and every layer's latency cost is benchmarked.
2. **A reusable core.** `packages/core` is framework-agnostic — it can be
   dropped into any Node.js project (Fastify, Express, or otherwise) without
   modification.

## Design rule

> `packages/core` never imports a web framework.

The core takes plain data in and returns plain data out — it knows nothing
about Fastify, Express, or HTTP itself. `packages/gateway` is the Fastify
application that wires the core into an actual server.

```
core/ratelimit  →  consume(key, policy) → { allowed, remaining, retryAfterMs }
core/auth       →  verifyKey(raw)       → { tenantId, scopes } | null
core/breaker    →  CircuitBreaker class
core/cache      →  get/set + Cache-Control interpretation
```

## How a request flows through the gateway

```
Request
  → Route matching       (which upstream does this go to?)
  → Security limits       (body size, header count)
  → Authentication        (is the API key / JWT valid?)
  → Rate limiting         (has this tenant exceeded its quota?)
  → Cache lookup          (do we already have this response?)
  → Transform              (path rewrite, add/remove headers)
  → Proxy + load balance  (forward to a healthy upstream)
  → Metrics + logging     (what happened, how long did it take?)
Response
```

Each layer is independent and can be disabled with a single line in config.

## Project structure

```
apigate/
├─ packages/
│  ├─ core/                  # framework-agnostic — the reusable part
│  │  └─ src/
│  │     ├─ ratelimit/       # algorithms, Store interface, Redis/memory stores
│  │     ├─ auth/            # API key + JWT verification
│  │     ├─ breaker/         # circuit breaker
│  │     └─ cache/           # Cache-Control interpretation
│  │
│  ├─ adapters/               # core → framework glue (fastify, express)
│  │
│  └─ gateway/                # the actual application
│     └─ src/
│        ├─ config/           # gateway.yaml loading + Zod validation
│        ├─ routing/          # route matcher + path rewrite
│        ├─ proxy/            # undici-based forwarding
│        ├─ security/         # request limits
│        ├─ admin/            # tenant/key management API (planned)
│        ├─ db/                # PostgreSQL client (planned)
│        └─ observability/    # metrics + logging (planned)
│
├─ examples/upstream/         # a bare-bones HTTP server used for local testing
├─ bench/                     # k6 load test scripts
├─ docker-compose.yml
├─ Dockerfile
└─ gateway.yaml               # example config
```

## Getting started

### Prerequisites

- Node.js 20+
- npm

### Install

```bash
npm install
```

### Run locally

```bash
npm run build
npm run dev -w packages/gateway
```

This starts the gateway on the port set in `gateway.yaml` (`8080` by default)
and reads its config from `GATEWAY_CONFIG` (defaults to `./gateway.yaml`).

Try it against the example upstream fixture:

```bash
node examples/upstream/index.js   # fake backend on :4000, in another terminal
curl http://localhost:8080/health
curl http://localhost:8080/echo/hello   # proxied to the example upstream
```

### Run with Docker Compose

```bash
docker compose up --build
```

This starts the gateway, Redis, PostgreSQL, and the example upstream together.

## Configuration

The gateway reads a single YAML file (`gateway.yaml` by default), validated
against a Zod schema at startup — invalid config fails fast with a readable
error instead of misbehaving at runtime.

```yaml
server:
  port: 8080
  trustProxyHops: 1
  maxBodyBytes: 1048576
  maxHeaderCount: 100
  requestTimeoutMs: 30000

routes:
  - id: users-api
    match:
      path: /api/v1/users/*
      methods: [GET, POST]
    rewrite:
      stripPrefix: /api/v1
    upstream:
      targets:
        - http://users-service:3000
      timeoutMs: 5000
    rateLimit:
      algorithm: tokenBucket
      keyBy: [ip]
      limit: 100
      windowSec: 60
```

Every route needs an `id`, a `match.path` (an exact path, or a path ending in
`/*` for a prefix match), and at least one `upstream.targets` entry.
`cache`, `auth`, and `circuitBreaker` are being wired up in later phases — see
[Status](#status) below.

### Rate limiting

A route with `rateLimit` gets one of five algorithms (`fixedWindow`,
`tokenBucket`, `leakyBucket`, `slidingWindowLog`, `slidingWindowCounter`),
keyed by client IP (`ip:<addr>:route:<id>`; tenant-based keys land with auth
in a later phase). By default each route's counters live in an in-process
memory store — enough for a single instance, and all `npm run dev` needs.

Add a top-level `redis` block to share quota across multiple gateway
instances instead (state moves into Redis, atomic via a Lua script per
algorithm — see [packages/core/src/ratelimit](packages/core/src/ratelimit)):

```yaml
redis:
  url: redis://localhost:6379
  failOpen: true   # not enforced yet — see Status
```

`docker-compose.yml` already runs a `redis` service if you want to try this
locally.

## Response contract

```
X-Request-Id: <uuid>          # generated if the client didn't send one, always echoed back
RateLimit-Limit: 100          # on rate-limited routes only
RateLimit-Remaining: 42
RateLimit-Reset: 12
Retry-After: 12                # 429 responses only
```

Error responses share one shape:

```json
{ "error": "not_found", "message": "No route matches GET /nope.", "requestId": "..." }
{ "error": "rate_limit_exceeded", "message": "...", "retryAfter": 12, "requestId": "..." }
```

## Testing

```bash
npm run lint       # eslint
npm run typecheck   # tsc --build, strict
npm run test         # vitest
```

The Redis-backed store's tests are real integration tests (no mocking — see
PLAN's testing philosophy) and need a reachable Redis; they skip themselves
if `REDIS_URL` (defaults to `redis://localhost:6379`) isn't reachable, so
`npm test` still works without Docker. Point `REDIS_URL` at a real instance
to run them, e.g.:

```bash
docker run -d --rm -p 6379:6379 redis:7-alpine
REDIS_URL=redis://localhost:6379 npm run test
```

## Benchmarking

`bench/baseline.js` is a [k6](https://k6.io) script for measuring the
gateway's proxy overhead:

```bash
k6 run -e BASE_URL=http://localhost:4000       bench/baseline.js   # direct upstream
k6 run -e BASE_URL=http://localhost:8080/echo   bench/baseline.js   # through the gateway
```

Compare the two runs' RPS/p50/p99 to see the added cost of each layer as more
of them come online.

## Status

- [x] **Monorepo skeleton** — npm workspaces, strict TypeScript, ESLint,
      Prettier, vitest, Docker, CI (lint + typecheck + test)
- [x] **Proxy** — route matching, undici forwarding, path rewrite, hop-by-hop
      header stripping, per-upstream timeouts, streaming request/response
      bodies, request ID propagation, header-count limits
- [x] **Rate limiting** — all five algorithms, in-process memory store or
      distributed Redis store (atomic via Lua, proven against a real Redis —
      see `packages/core/test/ratelimit`), standard headers + 429 contract.
      IP-keyed only for now; tenant keys and the Redis-down `failOpen`
      behavior land with auth and resilience below.
- [ ] **Auth** — API key and JWT verification, tenant-based quotas
- [ ] **Resilience** — circuit breaker, load balancing, retries
- [ ] **Cache** — Cache-Control-aware response caching
- [ ] **Admin API + observability** — tenant/key management, Prometheus
      metrics
- [ ] **Express adapter + standalone examples** — proof that `core` really is
      framework-agnostic
