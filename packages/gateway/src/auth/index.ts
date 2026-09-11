import { hashApiKey, verifyApiKeyHash, verifyJwt } from '@apigate/core/auth';
import type { Redis } from 'ioredis';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DbPool } from '../db/client.js';
import { findActiveApiKeyWithPlan, touchApiKeyLastUsed } from '../db/repositories/apiKeys.js';
import type { RouteConfig } from '../config/schema.js';

export interface TenantPlan {
  readonly limit: number;
  readonly windowSec: number;
  readonly burst: number;
}

export interface AuthOutcome {
  readonly ok: boolean;
  /** Anonim (auth: none) istekte tenantId yok. */
  readonly tenantId?: string;
  readonly scopes?: readonly string[];
  /** Sadece apiKey auth'ta dolu — plan tablosundan gelir, tenant bazlı rate limit'i belirler. */
  readonly plan?: TenantPlan;
}

export interface AuthDeps {
  readonly db?: DbPool;
  readonly redis?: Redis;
}

const API_KEY_CACHE_TTL_SEC = 60;
const NEGATIVE_CACHE_MARKER = '__invalid__';

export function apiKeyCacheKey(hash: string): string {
  return `auth:apikey:${hash}`;
}

export async function authenticateRequest(
  route: RouteConfig,
  request: FastifyRequest,
  reply: FastifyReply,
  deps: AuthDeps,
): Promise<AuthOutcome> {
  if (route.auth.type === 'none') return { ok: true };

  const token = extractBearerToken(request.headers.authorization);
  if (!token) {
    await sendUnauthorized(reply, request, 'Missing or malformed Authorization header — expected "Bearer <token>".');
    return { ok: false };
  }

  if (route.auth.type === 'jwt') {
    const result = await verifyJwt(token, {
      jwksUrl: route.auth.jwksUrl,
      ...(route.auth.issuer !== undefined ? { issuer: route.auth.issuer } : {}),
      ...(route.auth.audience !== undefined ? { audience: route.auth.audience } : {}),
      ...(route.auth.tenantClaim !== undefined ? { tenantClaim: route.auth.tenantClaim } : {}),
      ...(route.auth.scopeClaim !== undefined ? { scopeClaim: route.auth.scopeClaim } : {}),
    });

    if (!result) {
      await sendUnauthorized(reply, request, 'Invalid or expired JWT.');
      return { ok: false };
    }

    // JWT tenant'ları Postgres plan tablosuna bağlı değil (dış IdP zaten
    // tenant'ı biliyor) — tenant bazlı rate limit route'un statik config'ini
    // kullanır, bkz. ratelimit/index.ts.
    return { ok: true, tenantId: result.tenantId, scopes: result.scopes };
  }

  // apiKey
  if (!deps.db) {
    request.log.error(`route "${route.id}" requires apiKey auth but no db is configured`);
    await reply.code(500).send({
      error: 'server_misconfigured',
      message: 'This route requires API key auth but the gateway has no database configured.',
      requestId: request.id,
    });
    return { ok: false };
  }

  const record = await lookupApiKey(token, deps.db, deps.redis, (err) =>
    request.log.warn({ err }, 'api key cache unavailable, falling back to db'),
  );
  if (!record || !verifyApiKeyHash(token, record.keyHash)) {
    await sendUnauthorized(reply, request, 'Invalid, expired, or revoked API key.');
    return { ok: false };
  }

  return { ok: true, tenantId: record.tenantId, scopes: record.scopes, plan: record.plan };
}

interface CachedApiKeyRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly scopes: readonly string[];
  readonly keyHash: string;
  readonly plan: TenantPlan;
}

async function lookupApiKey(
  raw: string,
  db: DbPool,
  redis: Redis | undefined,
  onCacheError: (err: unknown) => void,
): Promise<CachedApiKeyRecord | null> {
  const hash = hashApiKey(raw);
  const cacheKey = apiKeyCacheKey(hash);

  // Cache sadece bir optimizasyon — Redis'e ulaşılamıyorsa DB'ye düş, isteği
  // hiç kırma (auth için "fail open" diye bir şey yok, ama cache down olması
  // auth'u da düşürmemeli).
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached === NEGATIVE_CACHE_MARKER) return null;
      if (cached) return JSON.parse(cached) as CachedApiKeyRecord;
    } catch (err) {
      onCacheError(err);
    }
  }

  const record = await findActiveApiKeyWithPlan(db, hash);

  if (redis) {
    try {
      await redis.set(cacheKey, record ? JSON.stringify(record) : NEGATIVE_CACHE_MARKER, 'EX', API_KEY_CACHE_TTL_SEC);
    } catch (err) {
      onCacheError(err);
    }
  }

  // Hot path'i bloklamasın — cevap zaten döndü sayılır.
  if (record) void touchApiKeyLastUsed(db, record.id);

  return record;
}

function extractBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : undefined;
}

async function sendUnauthorized(reply: FastifyReply, request: FastifyRequest, message: string): Promise<void> {
  await reply.code(401).send({ error: 'unauthorized', message, requestId: request.id });
}
