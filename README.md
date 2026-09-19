# APIGate

[![CI](https://github.com/ucanalgan/apigate/actions/workflows/ci.yml/badge.svg)](https://github.com/ucanalgan/apigate/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/badge/coverage-95%25-brightgreen)](#coverage)

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
│  │     └─ cache/           # Cache-Control interpretation, Redis/memory stores
│  │
│  ├─ adapters/
│  │  ├─ express/             # @apigate/adapter-express — rate limiter as Express middleware
│  │  └─ fastify/             # @apigate/adapter-fastify — rate limiter as a Fastify plugin
│  │
│  └─ gateway/                # the actual application
│     ├─ src/
│     │  ├─ config/           # gateway.yaml loading + Zod validation
│     │  ├─ routing/          # route matcher + path rewrite
│     │  ├─ proxy/            # undici forwarding, load balancer, retry
│     │  ├─ security/         # request limits
│     │  ├─ auth/             # Postgres/Redis-backed key + JWT verification
│     │  ├─ ratelimit/        # wires core's Store into requests, tenant/IP keys
│     │  ├─ cache/            # cache key building, tenant isolation
│     │  ├─ usage/            # buffered usage_records writer
│     │  ├─ db/                # Postgres client, migrations, repositories
│     │  ├─ admin/            # /admin/* — tenant/plan/key CRUD, its own auth
│     │  └─ observability/    # Prometheus metrics, log redaction
│     └─ scripts/             # seed.ts, revoke-key.ts — see § Auth
│
├─ examples/
│  ├─ upstream/                       # a bare-bones HTTP server used for local testing
│  ├─ standalone-express/             # @apigate/core's rate limiter in a bare Express app
│  └─ standalone-fastify/             # ...and the same, in a bare Fastify app
├─ bench/                     # k6 load test scripts
├─ docker-compose.yml
├─ Dockerfile
├─ gateway.yaml               # local-dev config — no external dependencies
├─ gateway.docker.yaml        # config used by docker-compose (redis + postgres wired up)
└─ grafana-dashboard.json     # importable dashboard for the /metrics below
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
curl http://localhost:8080/metrics       # Prometheus text format, always on
```

### Run with Docker Compose

```bash
docker compose up --build
```

This starts the gateway, Redis, PostgreSQL, and **two** example-upstream
instances together, using [gateway.docker.yaml](gateway.docker.yaml) —
redis/db wired up, and routes demonstrating auth (`/api/*`), resilience
(`/echo/*`, two targets + health check + breaker), and caching (`/cached/*`)
— rather than the dependency-free root `gateway.yaml`. Try
`docker compose stop upstream2` and keep curling `/echo/*` — see
[§ Resilience](#resilience).

### Use `@apigate/core` without the gateway at all

The whole point of the `core`/`gateway` split — proved by two standalone,
independently-`npm install`able examples, each a bare Express/Fastify app
with no dependency on `packages/gateway`:

```bash
cd examples/standalone-express && npm install && npm start   # :3000
cd examples/standalone-fastify && npm install && npm start   # :3001
```

Both wire up `@apigate/core`'s rate limiter in about the same handful of
lines shown in [`packages/core/README.md`](packages/core/README.md) (the
standalone usage guide for `ratelimit`/`auth`/`breaker`/`cache`, all
usable without pulling in `packages/gateway` or even Fastify/Express) —
curl either one 6 times with a limit of 5 and the 6th is a `429`, with
identical headers and error body on both, proven in
[`packages/adapters/express/test`](packages/adapters/express/test) and
[`packages/adapters/fastify/test`](packages/adapters/fastify/test).

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

The `server` limits are enforced before a request reaches any route:
`maxHeaderCount` (→ `431`) and `maxBodyBytes` (→ `413`). Bodies are proxied as
raw streams rather than parsed, so the body limit is checked two ways: a
declared `Content-Length` over the limit is refused before a single byte is
read, and a chunked body (no `Content-Length`) is counted as it streams and
cut off the moment it crosses the limit — the upstream never receives a
complete request. An oversized body is the client's fault, so it never counts
against an upstream's circuit breaker.

### Rate limiting

A route with `rateLimit` gets one of five algorithms (`fixedWindow`,
`tokenBucket`, `leakyBucket`, `slidingWindowLog`, `slidingWindowCounter`).
`keyBy` picks which counters apply — `ip` (`ip:<addr>:route:<id>`), `tenant`
(`tenant:<id>:route:<id>`, needs `auth`), `global` (`global:route:<id>`,
one shared bucket for the route's *total* traffic, independent of who's
asking), or any combination: every listed key is checked independently and
the request is rejected if *any* of them is over quota. By default each
route's counters live in an in-process memory store — enough for a single
instance, and all `npm run dev` needs.

`global` needs its own `limit`/`windowSec` (and optional `burst`) — it
protects the upstream's total capacity, which is almost never the same
number as a single caller's quota:

```yaml
rateLimit:
  algorithm: tokenBucket
  keyBy: [ip, global]
  limit: 20            # per IP
  windowSec: 60
  global: { limit: 200, windowSec: 60 }   # the route as a whole, regardless of caller
```

Add a top-level `redis` block to share quota across multiple gateway
instances instead (state moves into Redis, atomic via a Lua script per
algorithm — see [packages/core/src/ratelimit](packages/core/src/ratelimit)):

```yaml
redis:
  url: redis://localhost:6379
  failOpen: true   # if Redis errors: true = let requests through, false = 503 (see § Resilience)
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

### Cache

A route with `cache.enabled` caches **GET** responses. The upstream's own
`Cache-Control` is honored on top of the route's `ttlSec`: `no-store`,
`no-cache`, and `private` are never cached (a shared cache — which this is —
must not store `private` responses); an upstream `max-age` is used instead
of `ttlSec` when it's *shorter*, never longer — `ttlSec` is a ceiling the
operator sets, not a suggestion. Only `200` responses are cached. A hit
short-circuits the whole rest of the pipeline (no transform, no proxy call)
and answers with `X-Cache: HIT`; a miss still gets `X-Cache: MISS` and is
stored for next time if cacheable.

```yaml
cache:
  enabled: true
  ttlSec: 60
  varyBy: [Accept, Accept-Language]   # separate cache entries per header value
```

**The cache key is scoped by tenant whenever the route has `auth` enabled**,
on top of whatever `varyBy` lists — this isn't configurable, and it's not
about response formatting: `varyBy` is for content-negotiation headers, not
authorization boundaries, and without this a cached response meant for one
tenant would get served to another. `Set-Cookie` is stripped before a
response is cached or replayed, for the same reason (a shared cache handing
out one user's session cookie to the next is a classic caching bug).

Caching a response means reading its body into memory once to store it —
the same buffering trade-off `retry` makes for request bodies, here applied
to the response instead, and scoped to routes that opt into `cache`.
Responses larger than `server.maxBodyBytes` are served normally but skipped
by the cache.

**`transform.request`** (`setHeaders`/`removeHeaders`) runs on the outbound
request to upstream — so on a cache miss, never on a hit, since a hit skips
the proxy call (and hence the outbound request) entirely:

```yaml
transform:
  request:
    setHeaders: { X-Gateway: apigate }
    removeHeaders: [X-Internal-Token]
```

### CORS

A route with `cors.enabled` gets both halves of CORS: preflight (`OPTIONS`
with an `Access-Control-Request-Method` header, which only a browser ever
sends) is answered directly — `204`, no auth, no rate limit, no upstream
call, since a preflight is never supposed to reach any of those — and every
other response to that route (success, cache hit, `401`, `429`, `5xx`, all
of it) gets `Access-Control-Allow-Origin` added on the way out, because a
browser needs the header on the *error* too to let JS read the body:

```yaml
cors:
  enabled: true
  origins: ['https://app.example.com']   # or ['*'] for any origin
  # methods, allowedHeaders, exposedHeaders, credentials, maxAgeSec are all optional
```

`origins: ['*']` and `credentials: true` never combine — that combination is
rejected by every browser (a wildcard can't carry credentials), so the
gateway always echoes back the exact `Origin` instead of `*` whenever
`credentials` is on, wildcard or not. An origin not on the list gets no
CORS headers at all: the gateway still answers the request normally (this
isn't an authorization mechanism, just a browser-enforced same-origin
policy), the browser is what blocks the script from reading the response.

```bash
curl -i -X OPTIONS http://localhost:8080/cached/hello \
  -H 'Origin: http://localhost:5500' -H 'Access-Control-Request-Method: GET'
```

### Resilience

With more than one `upstream.targets` entry, requests are spread round-robin
across them. Add `healthCheck` and each target gets proactively probed and
pulled out of rotation on failure (and back in once it recovers); add
`circuitBreaker` and each target additionally gets its own breaker
(closed → open after `failureThreshold` consecutive failures → half-open
retrial after `resetTimeoutMs`) that reacts to real request failures —
useful for catching problems between health-check intervals, or when there's
no `healthCheck` at all. Neither needs the other; either needs nothing beyond
listing more than one target to start round-robin-ing.

```yaml
upstream:
  targets: [http://svc-1:3000, http://svc-2:3000]
  healthCheck: { path: /health, intervalMs: 10000 }   # optional
circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 30000 }   # optional, per route
retry: { attempts: 2, backoffMs: 100 }                            # optional, per route
```

`retry` only fires for **GET/HEAD/PUT/DELETE** and only on a connection
failure or timeout — never because the upstream responded with a 5xx
(retrying that risks amplifying load on something already struggling; a 5xx
is passed straight through instead, though it still counts as a failure
against that target's breaker). Each attempt re-consults the balancer, so a
retry naturally lands on a different target once the first one's breaker
trips or health check marks it down. A body on a retryable request is buffered first, since a stream can only be
sent once — the gateway otherwise proxies bodies as a true, unbuffered
stream, so this trade-off is scoped to routes that opt into `retry`.

**`redis.failOpen`** (from [§ Rate limiting](#rate-limiting)) is enforced:
if the rate-limit store errors (Redis unreachable), the default `true`
lets the request through logging a warning; `false` returns `503`. The
API-key auth cache degrades the same way regardless of `failOpen` — a
down Redis just means every request falls back to Postgres instead of
failing outright, since the cache was only ever an optimization.

### Admin API

A top-level `admin` block turns on `/admin/*` — a real CRUD API for plans,
tenants, and keys, entirely separate from the proxy pipeline (it needs
`db`; JSON bodies work normally here, unlike the rest of the gateway which
proxies bodies as raw streams). It's protected by a single operator secret,
not the tenant `apiKey`/`jwt` auth above — admin actions aren't scoped to a
tenant, so reusing tenant auth for them would be a conceptual (and
practical) mismatch:

```yaml
admin:
  token: a-long-random-operator-secret   # Authorization: Bearer <token>, constant-time compare
```

```bash
TOKEN=a-long-random-operator-secret

curl -X POST http://localhost:8080/admin/plans -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"pro","rateLimit":1000,"windowSec":60,"burst":200}'
curl http://localhost:8080/admin/tenants -H "Authorization: Bearer $TOKEN"
curl -X POST http://localhost:8080/admin/tenants/<id>/keys -H "Authorization: Bearer $TOKEN" -d '{"name":"prod"}'
curl -X DELETE http://localhost:8080/admin/keys/<id> -H "Authorization: Bearer $TOKEN"   # instant, clears the cache too
curl "http://localhost:8080/admin/usage?tenantId=<id>&sinceHours=24" -H "Authorization: Bearer $TOKEN"
```

Key creation returns the raw key **once**, the same way `npm run seed` does
— see [packages/gateway/src/admin/routes.ts](packages/gateway/src/admin/routes.ts)
for the full route list. Listing keys never returns the raw key or its
hash, only the display `prefix` and metadata.

### Observability

`GET /metrics` — Prometheus text format, via `prom-client`. Counters
(`apigate_requests_total`, `..._ratelimit_decisions_total`,
`..._cache_total`, `..._upstream_errors_total`) and the request-duration
histogram are recorded as requests happen; the two gauges
(`apigate_circuit_state`, `apigate_upstream_healthy`) are computed fresh
from each route's balancer at scrape time rather than pushed — the correct
direction for state Prometheus is already polling for. Full metric/label
reference is in [packages/gateway/src/observability/metrics.ts](packages/gateway/src/observability/metrics.ts);
[grafana-dashboard.json](grafana-dashboard.json) has a starting dashboard
for all of them (request rate, 429 rate, p50/p95/p99 latency, rate-limit
decisions, cache hit ratio, upstream errors, breaker state, target health,
Redis op latency) — not rendered against a live Grafana in this
environment, so treat the panel JSON as a solid starting point to verify on
import, not as pixel-proven.

**Config hot-reload** — SIGHUP always tries a reload; set `server.watch:
true` to also reload on every write to the config file. Either way, only
`routes` is actually swappable at runtime: `server`, `redis`, `db`, and
`admin` are fixed for the process's lifetime (Fastify's own listener,
connections, and route tree can't be rebuilt without a restart), so a
reload that touches any of those is rejected — the old config keeps running
and the rejection is logged, never a crash. A syntactically-broken write
(most editors don't write files atomically, so `fs.watch` can catch a file
mid-write) fails the same safe way.

## Response contract

```
X-Request-Id: <uuid>          # generated if the client didn't send one, always echoed back
RateLimit-Limit: 100          # on rate-limited routes only
RateLimit-Remaining: 42
RateLimit-Reset: 12
Retry-After: 12                # 429 responses only
X-Cache: HIT | MISS            # on cache-enabled routes only
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

The Redis- and Postgres-backed tests are real integration tests, not
mocks — the Postgres ones create and drop their own throwaway database per
run. Both skip themselves if `REDIS_URL` (default
`redis://localhost:6379`) / `POSTGRES_URL` (default
`postgres://postgres:postgres@localhost:5432/postgres`) aren't reachable, so
`npm test` still works without Docker. Point them at real instances to run
everything:

```bash
docker run -d --rm -p 6379:6379 redis:7-alpine
docker run -d --rm -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16-alpine
REDIS_URL=redis://localhost:6379 POSTGRES_URL=postgres://postgres:postgres@localhost:5432/postgres npm run test
```

### Coverage

```bash
npm run coverage   # vitest run --coverage (needs Redis/Postgres reachable, same as above)
```

The badge is `v8`-measured statement coverage from the full suite run
against real Redis and Postgres: **95% statements, 92% branches, 94%
functions** (216 tests). It's a hand-updated number — re-run the command
above and edit the badge at the top of this file when it moves.

Two layers of tests produce it. `packages/core` — the framework-agnostic
algorithms, auth, breaker, and cache logic — is unit-tested directly, since
it's all functions that take plain data. The gateway is tested *through its
real request pipeline*: `buildServer()` + `app.inject()` (or a real
listening socket where the test needs one) in front of real HTTP upstreams
on ephemeral ports, a real JWKS endpoint with real RS256 signatures, a
throwaway Postgres database per file, and real Redis — including two
gateway instances sharing one Redis quota, and a deliberately-dead Redis
port for the `failOpen`/fail-closed and cache-fallback paths. Nothing in
the suite is mocked. See `packages/gateway/test/*Pipeline*.test.ts`,
`proxy.test.ts`, `apiKeyAuth.test.ts`, `adminApi.test.ts`.

The one file at 0% is `packages/gateway/src/index.ts` — the process
entrypoint (config load, signal handlers, `listen`), which `vitest` can't
meaningfully exercise without spawning the whole process; `docker compose up`
(§ Getting started) is what covers it.

## Benchmarking

`bench/baseline.js` is a [k6](https://k6.io) script for measuring the
gateway's proxy overhead — 20 constant VUs against `/health` for 30s, direct
vs. through the gateway's `bench` route (plain passthrough, no rate
limit/cache/auth, so it isolates proxy overhead instead of measuring the
demo routes' deliberately-low rate limits):

```bash
k6 run -e BASE_URL=http://localhost:4000       bench/baseline.js   # direct upstream
k6 run -e BASE_URL=http://localhost:8080/bench  bench/baseline.js   # through the gateway (proxy only)
```

Or, without installing k6 locally, run it against the `docker-compose.yml`
stack via the official image:

```bash
docker compose up -d
docker run --rm --network apigate_default -v "$PWD/bench:/bench" \
  -e BASE_URL=http://upstream:4000       grafana/k6 run /bench/baseline.js
docker run --rm --network apigate_default -v "$PWD/bench:/bench" \
  -e BASE_URL=http://gateway:8080/bench  grafana/k6 run /bench/baseline.js
```

Real numbers from that setup (Docker Desktop on Windows, gateway and
upstream both containerized on the same machine as the k6 load generator —
treat the absolute numbers as machine-specific, the *relative* overhead as
the interesting part):

| | RPS | avg | p50 | p90 | p95 | p99 |
| --- | --- | --- | --- | --- | --- | --- |
| Direct upstream | ~20,100 | 0.94 ms | 0.77 ms | 1.55 ms | 1.93 ms | 2.78 ms |
| Through gateway | ~3,670 | 5.38 ms | 4.72 ms | 7.05 ms | 8.78 ms | 14.2 ms |

The gateway adds roughly 4ms of p50 latency and caps throughput well below
the bare upstream on this single-process, single-machine setup — expected
for an extra network hop plus route matching, header rewriting, and undici's
own connection handling on top of Node's `http` server. `http_req_failed`
was `0.00%` on both runs (no dropped requests, just added latency). Re-run
the two commands above whenever you change proxy-path code to see whether
the delta moved.
