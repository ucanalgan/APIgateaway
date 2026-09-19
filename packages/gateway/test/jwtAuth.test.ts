import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, startUpstream, type TestUpstream } from './helpers.js';

// A real JWKS endpoint and real RS256 signatures — the gateway fetches keys
// over HTTP exactly as it would from a production identity provider.
let jwksServer: Server;
let jwksUrl: string;
let privateKey: CryptoKey;
let foreignPrivateKey: CryptoKey;
const kid = 'test-key-1';

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  foreignPrivateKey = (await generateKeyPair('RS256')).privateKey;
  const jwk = await exportJWK(pair.publicKey);

  jwksServer = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] }));
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
  jwksUrl = `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}/.well-known/jwks.json`;
});

afterAll(() => {
  jwksServer.close();
});

let app: FastifyInstance | undefined;
let up: TestUpstream | undefined;

afterEach(async () => {
  await app?.close();
  await up?.close();
  app = undefined;
  up = undefined;
});

function sign(
  claims: Record<string, unknown>,
  opts: { key?: CryptoKey; audience?: string; expiresAt?: number } = {},
): Promise<string> {
  let builder = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuedAt()
    .setExpirationTime(opts.expiresAt ?? '5m');
  if (opts.audience) builder = builder.setAudience(opts.audience);
  return builder.sign(opts.key ?? privateKey);
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function jwtApp(extraRoute: Record<string, unknown> = {}, jwt: Record<string, unknown> = {}) {
  up = await startUpstream();
  app = await buildTestApp([
    {
      id: 'secure',
      match: { path: '/secure/*' },
      upstream: { targets: [up.url] },
      auth: { type: 'jwt', jwksUrl, ...jwt },
      ...extraRoute,
    },
  ]);
  return app;
}

describe('JWT auth', () => {
  it('lets a validly signed token through and reaches the upstream', async () => {
    const gw = await jwtApp();

    const res = await gw.inject({
      method: 'GET',
      url: '/secure/x',
      headers: bearer(await sign({ tenant_id: 't1' })),
    });

    expect(res.statusCode).toBe(200);
    expect(up!.requests).toHaveLength(1);
  });

  it('answers 401 for a missing, malformed, or non-Bearer Authorization header', async () => {
    const gw = await jwtApp();

    for (const headers of [{}, { authorization: 'Bearer' }, { authorization: 'Basic dXNlcjpwdw==' }]) {
      const res = await gw.inject({ method: 'GET', url: '/secure/x', headers });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: 'unauthorized' });
    }
    expect(up!.requests).toHaveLength(0);
  });

  it('answers 401 for a garbage token, a foreign signature, an expired token, and a wrong audience', async () => {
    const gw = await jwtApp({}, { audience: 'apigate' });
    const now = Math.floor(Date.now() / 1000);

    const tokens = [
      'not.a.jwt',
      await sign({ tenant_id: 't' }, { key: foreignPrivateKey, audience: 'apigate' }),
      await sign({ tenant_id: 't' }, { audience: 'apigate', expiresAt: now - 60 }),
      await sign({ tenant_id: 't' }, { audience: 'someone-else' }),
    ];

    for (const token of tokens) {
      const res = await gw.inject({ method: 'GET', url: '/secure/x', headers: bearer(token) });
      expect(res.statusCode).toBe(401);
    }
    expect(up!.requests).toHaveLength(0);
  });

  it('feeds the token\'s tenant claim into a tenant-keyed rate limit', async () => {
    const gw = await jwtApp({ rateLimit: { algorithm: 'fixedWindow', keyBy: ['tenant'], limit: 1, windowSec: 60 } });
    const tenantA = bearer(await sign({ tenant_id: 'tenant-a' }));
    const tenantB = bearer(await sign({ tenant_id: 'tenant-b' }));

    const a1 = await gw.inject({ method: 'GET', url: '/secure/x', headers: tenantA });
    const a2 = await gw.inject({ method: 'GET', url: '/secure/x', headers: tenantA });
    const b1 = await gw.inject({ method: 'GET', url: '/secure/x', headers: tenantB });

    expect(a1.statusCode).toBe(200);
    expect(a2.statusCode).toBe(429);
    expect(b1.statusCode).toBe(200); // a different tenant has its own bucket
  });

  it('scopes the response cache by tenant — one tenant never receives another\'s cached response', async () => {
    const gw = await jwtApp({ cache: { enabled: true, ttlSec: 60 } });
    const tenantA = bearer(await sign({ tenant_id: 'tenant-a' }));
    const tenantB = bearer(await sign({ tenant_id: 'tenant-b' }));

    const a1 = await gw.inject({ method: 'GET', url: '/secure/report', headers: tenantA });
    const b1 = await gw.inject({ method: 'GET', url: '/secure/report', headers: tenantB });
    const a2 = await gw.inject({ method: 'GET', url: '/secure/report', headers: tenantA });

    expect(a1.headers['x-cache']).toBe('MISS');
    expect(b1.headers['x-cache']).toBe('MISS'); // NOT a HIT on tenant A's entry
    expect(a2.headers['x-cache']).toBe('HIT');
    expect(up!.requests).toHaveLength(2);
  });
});
