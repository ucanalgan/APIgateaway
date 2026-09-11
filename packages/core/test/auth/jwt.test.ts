import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { verifyJwt } from '../../src/auth/jwt.js';

// verifyJwt fetches its JWKS over HTTP (that's the point — real key rotation
// support), so this spins up a throwaway local JWKS endpoint rather than
// mocking jose internals.
let server: Server;
let jwksUrl: string;
let privateKey: CryptoKey;
const kid = 'test-key-1';

beforeAll(async () => {
  const { privateKey: priv, publicKey } = await generateKeyPair('RS256');
  privateKey = priv;
  const jwk = await exportJWK(publicKey);

  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] }));
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  jwksUrl = `http://localhost:${port}/.well-known/jwks.json`;
});

afterAll(() => {
  server.close();
});

function sign(claims: Record<string, unknown>, opts: { issuer?: string; audience?: string } = {}): Promise<string> {
  let builder = new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid }).setIssuedAt().setExpirationTime('5m');
  if (opts.issuer) builder = builder.setIssuer(opts.issuer);
  if (opts.audience) builder = builder.setAudience(opts.audience);
  return builder.sign(privateKey);
}

describe('verifyJwt', () => {
  it('resolves tenantId from a custom claim and scopes from a space-separated string', async () => {
    const token = await sign({ tenant_id: 'tenant-42', scope: 'read write' });
    const result = await verifyJwt(token, { jwksUrl });

    expect(result).toEqual({ tenantId: 'tenant-42', scopes: ['read', 'write'] });
  });

  it('falls back to `sub` when there is no tenant claim', async () => {
    const token = await sign({ sub: 'tenant-from-sub' });
    const result = await verifyJwt(token, { jwksUrl });

    expect(result?.tenantId).toBe('tenant-from-sub');
  });

  it('reads array-valued scopes claims too', async () => {
    const token = await sign({ sub: 't', scopes: ['a', 'b'] });
    const result = await verifyJwt(token, { jwksUrl, scopeClaim: 'scopes' });

    expect(result?.scopes).toEqual(['a', 'b']);
  });

  it('rejects a token signed with an unknown key', async () => {
    const { privateKey: otherKey } = await generateKeyPair('RS256');
    const token = await new SignJWT({ sub: 't' })
      .setProtectedHeader({ alg: 'RS256', kid: 'unknown-key' })
      .sign(otherKey);

    const result = await verifyJwt(token, { jwksUrl });
    expect(result).toBeNull();
  });

  it('rejects an expired token', async () => {
    const token = await new SignJWT({ sub: 't' })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 1000)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 500)
      .sign(privateKey);

    const result = await verifyJwt(token, { jwksUrl });
    expect(result).toBeNull();
  });

  it('enforces issuer and audience when configured', async () => {
    const token = await sign({ sub: 't' }, { issuer: 'https://issuer.example', audience: 'api' });

    const wrongIssuer = await verifyJwt(token, { jwksUrl, issuer: 'https://someone-else.example' });
    expect(wrongIssuer).toBeNull();

    const correct = await verifyJwt(token, { jwksUrl, issuer: 'https://issuer.example', audience: 'api' });
    expect(correct?.tenantId).toBe('t');
  });
});
