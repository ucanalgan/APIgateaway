import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { rateLimiter } from '../src/index.js';

// Shared scenario with packages/adapters/fastify/test/rateLimiter.test.ts —
// same limit, same assertions. Proves core's rate limiter behaves
// identically regardless of which framework adapter wraps it (PLAN.md's
// "adapter parity" requirement).
function buildApp() {
  const app = express();
  app.use(rateLimiter({ limit: 5, windowSec: 60 }));
  app.get('/', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('@apigate/adapter-express rateLimiter', () => {
  it('allows exactly `limit` requests, then rejects with 429', async () => {
    const app = buildApp();

    for (let i = 0; i < 5; i++) {
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
    }

    const blocked = await request(app).get('/');
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ error: 'rate_limit_exceeded' });
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('sets standard RateLimit-* headers', async () => {
    const app = buildApp();
    const res = await request(app).get('/');

    expect(res.headers['ratelimit-limit']).toBe('5');
    expect(res.headers['ratelimit-remaining']).toBe('4');
  });

  it('keeps separate keys independent via a custom keyGenerator', async () => {
    const app = express();
    app.use(rateLimiter({ limit: 1, windowSec: 60, keyGenerator: (req) => String(req.headers['x-user']) }));
    app.get('/', (_req, res) => res.json({ ok: true }));

    const userA1 = await request(app).get('/').set('x-user', 'a');
    const userA2 = await request(app).get('/').set('x-user', 'a');
    const userB1 = await request(app).get('/').set('x-user', 'b');

    expect(userA1.status).toBe(200);
    expect(userA2.status).toBe(429);
    expect(userB1.status).toBe(200);
  });
});
