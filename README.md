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
core/ratelimit  →  consume(key, policy)         → { allowed, remaining, retryAfterMs }
core/auth       →  verifyApiKey(raw, lookup)     → { tenantId, scopes } | null
                →  verifyJwt(token, jwksOptions) → { tenantId, scopes } | null
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
│  │     ├─ auth/            # API key + JWT verification primitives
│  │     ├─ breaker/         # circuit breaker
│  │     └─ cache/           # Cache-Control interpretation
│  │
│  ├─ adapters/               # core → framework glue (fastify, express)
│  │
│  └─ gateway/                # the actual application
│     ├─ src/
│     │  ├─ config/           # gateway.yaml loading + Zod validation
│     │  ├─ routing/          # route matcher + path rewrite
│     │  ├─ proxy/            # undici-based forwarding
│     │  ├─ security/         # request limits
│     │  ├─ auth/             # Postgres/Redis-backed key + JWT verification
│     │  ├─ ratelimit/        # wires core's Store into requests, tenant/IP keys
│     │  ├─ usage/            # buffered usage_records writer
│     │  ├─ db/                # Postgres client, migrations, repositories
│     │  ├─ admin/            # tenant/key management API (planned)
│     │  └─ observability/    # metrics + logging (planned)
│     └─ scripts/             # seed.ts, revoke-key.ts — see § Auth
│
├─ examples/upstream/         # a bare-bones HTTP server used for local testing
├─ bench/                     # k6 load test scripts
├─ docker-compose.yml
├─ Dockerfile
├─ gateway.yaml               # local-dev config — no external dependencies
└─ gateway.docker.yaml        # config used by docker-compose (redis + postgres wired up)
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

This starts the gateway, Redis, PostgreSQL, and the example upstream together,
using [gateway.docker.yaml](gateway.docker.yaml) (redis/db wired up, plus an
`auth: apiKey` route) rather than the dependency-free root `gateway.yaml`.

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
`cache` and `circuitBreaker` are being wired up in later phases — see
[Status](#status) below.

### Rate limiting

A route with `rateLimit` gets one of five algorithms (`fixedWindow`,
`tokenBucket`, `leakyBucket`, `slidingWindowLog`, `slidingWindowCounter`).
`keyBy` picks which counters apply — `ip` (`ip:<addr>:route:<id>`), `tenant`
(`tenant:<id>:route:<id>`, needs `auth`), or both at once: every listed key
is checked independently and the request is rejected if *any* of them is
over quota. By default each route's counters live in an in-process memory
store — enough for a single instance, and all `npm run dev` needs.

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

### Auth

A route's `auth.type` is `none` (default), `apiKey`, or `jwt`. Either way the
gateway reads `Authorization: Bearer <token>` and, on success, makes the
resolved tenant available to `rateLimit: { keyBy: [tenant] }` above.

**`apiKey`** needs a top-level `db` block (Postgres) — the gateway runs its
own migrations on startup. Keys are `sha256` hashed at rest and compared with
a constant-time check (never stored or logged in plaintext); a positive/negative
verification cache lives in Redis when configured (60s TTL), invalidated
immediately on revoke. The **rate limit for `keyBy: [tenant]` comes from the
tenant's plan** (Postgres `plans.rate_limit/window_sec/burst`), not the
route's static `rateLimit` config — that's what lets a `free` and a `pro`
tenant hit the same route with different quotas.

```bash
# with db (and optionally redis) uncommented in gateway.yaml:
npm run seed -w packages/gateway          # creates free/pro plans, a tenant, and a key
npm run revoke-key -w packages/gateway -- <key-id>   # instant — clears the cache too
```

```yaml
db:
  url: postgres://apigate:apigate@localhost:5432/apigate

routes:
  - id: protected-api
    match: { path: /api/* }
    upstream: { targets: [http://localhost:4000] }
    auth: { type: apiKey }
    rateLimit: { algorithm: tokenBucket, keyBy: [tenant], limit: 100, windowSec: 60 }
```

**`jwt`** verifies against a JWKS endpoint (`jose`, with key rotation
handled for you) — no database involved. `tenantId` comes from a configurable
claim (default `tenant_id`, falling back to `sub`); scopes from `scope`
(space-separated) or a configurable array claim.

```yaml
auth:
  type: jwt
  jwksUrl: https://your-idp.example/.well-known/jwks.json
  issuer: https://your-idp.example/      # optional
  audience: apigate                       # optional
```

Full usage per tenant (status code, latency, route) is buffered in memory and
flushed to Postgres `usage_records` in batches (every 5s or 500 records,
whichever first) rather than written synchronously per request — see
[packages/gateway/src/usage/buffer.ts](packages/gateway/src/usage/buffer.ts).

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
{ "error": "unauthorized", "message": "...", "requestId": "..." }
{ "error": "rate_limit_exceeded", "message": "...", "retryAfter": 12, "requestId": "..." }
```

## Testing

```bash
npm run lint       # eslint
npm run typecheck   # tsc --build, strict
npm run test         # vitest
```

The Redis- and Postgres-backed tests are real integration tests (no mocking —
see PLAN's testing philosophy): the Postgres ones create and drop their own
throwaway database per run. Both skip themselves if `REDIS_URL` (default
`redis://localhost:6379`) / `POSTGRES_URL` (default
`postgres://postgres:postgres@localhost:5432/postgres`) aren't reachable, so
`npm test` still works without Docker. Point them at real instances to run
everything:

```bash
docker run -d --rm -p 6379:6379 redis:7-alpine
docker run -d --rm -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16-alpine
REDIS_URL=redis://localhost:6379 POSTGRES_URL=postgres://postgres:postgres@localhost:5432/postgres npm run test
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
      see `packages/core/test/ratelimit`), standard headers + 429 contract,
      IP- and/or tenant-keyed. The Redis-down `failOpen` behavior isn't
      enforced yet — see Resilience below.
- [x] **Auth** — API key (Postgres-backed, sha256 + constant-time compare,
      Redis verification cache with instant revoke invalidation) and JWT
      (JWKS) verification; tenant-scoped, plan-driven rate limits; buffered
      usage recording. See `packages/gateway/test/db.test.ts` and
      `packages/core/test/auth`.
- [ ] **Resilience** — circuit breaker, load balancing, retries, the
      Redis-down `failOpen` policy
- [ ] **Cache** — Cache-Control-aware response caching
- [ ] **Admin API + observability** — tenant/key management, Prometheus
      metrics
- [ ] **Express adapter + standalone examples** — proof that `core` really is
      framework-agnostic
