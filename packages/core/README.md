# @apigate/core

Framework-agnostic rate limiting, auth, circuit breaking, and cache-policy
primitives. Nothing in here imports Fastify, Express, or any HTTP framework
— every function takes plain data in and returns plain data out. That's
what makes it copy-pasteable: drop `packages/core` into any Node.js
project and it works, no adapter required (though
[`@apigate/adapter-express`](../adapters/express) and
[`@apigate/adapter-fastify`](../adapters/fastify) exist if you want the
rate limiter wired up as middleware in one line — see
[`examples/standalone-express`](../../examples/standalone-express) and
[`examples/standalone-fastify`](../../examples/standalone-fastify)).

## Install

Not published to npm — copy the `packages/core` directory into your
project, or reference it with a `file:` dependency the way the examples in
this repo do:

```json
{ "dependencies": { "@apigate/core": "file:../path/to/packages/core" } }
```

`ioredis` is an optional peer dependency — only needed if you use the Redis
store variants; the in-process memory stores work with zero external
dependencies.

## `@apigate/core/ratelimit`

Five algorithms (`fixedWindow`, `tokenBucket`, `leakyBucket`,
`slidingWindowLog`, `slidingWindowCounter`), each available as an
in-process memory store or a Redis-backed one (atomic via a Lua script —
safe across multiple processes/instances sharing the same Redis).

```ts
import { createMemoryStore } from '@apigate/core/ratelimit';

const store = createMemoryStore('tokenBucket');

const result = await store.consume('user-123', { limit: 100, windowMs: 60_000, burst: 20 });
// { allowed: true, limit: 100, remaining: 19, retryAfterMs: 0 }
```

Redis-backed, for when more than one process needs to share the same quota:

```ts
import { Redis } from 'ioredis';
import { createRedisStore } from '@apigate/core/ratelimit';

const redis = new Redis(process.env.REDIS_URL);
const store = createRedisStore('tokenBucket', redis);

await store.consume('user-123', { limit: 100, windowMs: 60_000 });
```

`Policy` is `{ limit, windowMs, burst? }` (`burst` defaults to `limit` — the
bucket/window's capacity). `consume(key, policy, cost?)` — `cost` defaults
to `1`, use higher values to charge a single call for more than one unit of
quota. `store.reset(key)` clears one key; `store.close()` releases the
store's resources (for the Redis store, this calls `redis.quit()` — don't
share one `Redis` instance across stores you close independently).

## `@apigate/core/auth`

API key generation/hashing/verification, and JWT verification against a
JWKS endpoint. Neither one talks to a database — you provide the lookup.

```ts
import { generateApiKey, verifyApiKey } from '@apigate/core/auth';

const { raw, hash, prefix } = generateApiKey();
// raw:    "ag_live_..."  — show this to the user once, never store it
// hash:   sha256(raw)     — store this
// prefix: "ag_live_ab12"  — safe to display/log

const result = await verifyApiKey(raw, async (hash) => {
  // your own lookup — return null if not found/revoked
  return { tenantId: 'tenant-1', scopes: ['read'], hash };
});
// { tenantId: 'tenant-1', scopes: ['read'] } | null
```

Verification hashes the presented key and compares it to your lookup's
result with `crypto.timingSafeEqual` — never a plain `===` on secrets.

```ts
import { verifyJwt } from '@apigate/core/auth';

const result = await verifyJwt(token, {
  jwksUrl: 'https://your-idp.example/.well-known/jwks.json',
  issuer: 'https://your-idp.example/',   // optional
  audience: 'your-api',                   // optional
});
// { tenantId, scopes } | null — tenantId from a `tenant_id` claim (configurable), falling back to `sub`
```

## `@apigate/core/breaker`

A closed → open → half-open circuit breaker. Framework- and
transport-agnostic: you decide what "a request" means and call
`recordSuccess()`/`recordFailure()` yourself.

```ts
import { CircuitBreaker } from '@apigate/core/breaker';

const breaker = new CircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 30_000 });

if (!breaker.canRequest()) {
  throw new Error('circuit open — not calling the upstream');
}

try {
  const result = await callSomethingFlaky();
  breaker.recordSuccess();
} catch (err) {
  breaker.recordFailure();
  throw err;
}
```

After `failureThreshold` consecutive failures the breaker opens and
`canRequest()` returns `false` for `resetTimeoutMs`; after that it allows
exactly one trial request (`half-open`) — success closes it, failure
reopens it for another full `resetTimeoutMs`.

## `@apigate/core/cache`

Cache-Control interpretation as a pure function, plus memory/Redis stores
for the actual cached bytes.

```ts
import { decideCacheability, createMemoryCacheStore } from '@apigate/core/cache';

const decision = decideCacheability(200, { 'cache-control': 'public, max-age=30' }, 60);
// { cacheable: true, ttlSec: 30 } — upstream's max-age wins when it's shorter than your default

if (decision.cacheable) {
  const store = createMemoryCacheStore();
  await store.set('key', { statusCode: 200, headers: {}, body: Buffer.from('...') }, decision.ttlSec);
}
```

`decideCacheability` never marks anything but a `200` cacheable, and treats
`no-store`, `no-cache`, and `private` as non-cacheable — the same rules a
shared/proxy cache has to follow. It doesn't know about `Set-Cookie` or
multi-tenancy — those are call-site concerns (see
[packages/gateway/src/cache](../gateway/src/cache) for how the actual
gateway handles both).
