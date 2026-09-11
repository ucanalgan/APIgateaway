import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { AuthResult } from './apiKey.js';

export interface JwtVerifyOptions {
  readonly jwksUrl: string;
  readonly issuer?: string;
  readonly audience?: string;
  /** Bu claim'den tenantId okunur; yoksa `sub`'a düşer. Varsayılan: 'tenant_id'. */
  readonly tenantClaim?: string;
  /** Boşlukla ayrılmış string ya da string dizisi olabilir. Varsayılan: 'scope'. */
  readonly scopeClaim?: string;
}

// Aynı JWKS URL için tekrar tekrar fetch etmemek üzere jose'nin remote set'ini
// process ömrü boyunca paylaşıyoruz (jose kendi içinde anahtar rotasyonu/TTL
// yönetimini zaten yapıyor).
const jwksCache = new Map<string, JWTVerifyGetKey>();

function getJwks(url: string): JWTVerifyGetKey {
  let jwks = jwksCache.get(url);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(url));
    jwksCache.set(url, jwks);
  }
  return jwks;
}

export async function verifyJwt(token: string, options: JwtVerifyOptions): Promise<AuthResult | null> {
  try {
    const jwks = getJwks(options.jwksUrl);
    const { payload } = await jwtVerify(token, jwks, {
      ...(options.issuer !== undefined ? { issuer: options.issuer } : {}),
      ...(options.audience !== undefined ? { audience: options.audience } : {}),
    });

    const tenantId = readTenantId(payload, options.tenantClaim ?? 'tenant_id');
    if (!tenantId) return null;

    return { tenantId, scopes: readScopes(payload, options.scopeClaim ?? 'scope') };
  } catch {
    return null;
  }
}

function readTenantId(payload: JWTPayload, claim: string): string | undefined {
  const value = payload[claim] ?? payload.sub;
  return typeof value === 'string' ? value : undefined;
}

function readScopes(payload: JWTPayload, claim: string): string[] {
  const value = payload[claim];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string') return value.split(' ').filter(Boolean);
  return [];
}
