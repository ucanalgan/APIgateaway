import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { rateLimiter } from '../src/index.js';

// Shared scenario with packages/adapters/express/test/rateLimiter.test.ts —
// same limit, same assertions. Proves core's rate limiter behaves
// identically regardless of which framework adapter wraps it (PLAN.md's
// "adapter parity" requirement).
async function buildApp() {
  const app = Fastify();
  await app.register(rateLimiter, { limit: 5, windowSec: 60 });
  app.get('/', async () => ({ ok: true }));
  return app;
}

describe('@apigate/adapter-fastify rateLimiter', () => {
  it('allows exactly `limit` requests, then rejects with 429', async () => {
    const app = await buildApp();

    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(200);
    }

    const blocked = await app.inject({ method: 'GET', url: '/' });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ error: 'rate_limit_exceeded' });
    expect(blocked.headers['retry-after']).toBeDefined();

    await app.close();
  });

  it('sets standard RateLimit-* headers', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/' });

    expect(res.headers['ratelimit-limit']).toBe('5');
    expect(res.headers['ratelimit-remaining']).toBe('4');

    await app.close();
  });

  it('keeps separate keys independent via a custom keyGenerator', async () => {
    const app = Fastify();
    await app.register(rateLimiter, {
      limit: 1,
      windowSec: 60,
      keyGenerator: (request) => String(request.headers['x-user']),
    });
    app.get('/', async () => ({ ok: true }));

    const userA1 = await app.inject({ method: 'GET', url: '/', headers: { 'x-user': 'a' } });
    const userA2 = await app.inject({ method: 'GET', url: '/', headers: { 'x-user': 'a' } });
    const userB1 = await app.inject({ method: 'GET', url: '/', headers: { 'x-user': 'b' } });

    expect(userA1.statusCode).toBe(200);
    expect(userA2.statusCode).toBe(429);
    expect(userB1.statusCode).toBe(200);

    await app.close();
  });
});
