import { generateApiKey } from '@apigate/core/auth';
import type { DbPool } from '../client.js';

export interface CreateApiKeyInput {
  readonly tenantId: string;
  readonly name?: string;
  readonly scopes?: readonly string[];
  readonly expiresAt?: Date;
}

export interface CreatedApiKey {
  /** Ham key — bu, tek dönen anı. Çağıran hemen kullanıcıya göstermeli. */
  readonly raw: string;
  readonly id: string;
  readonly prefix: string;
}

export async function createApiKey(pool: DbPool, input: CreateApiKeyInput): Promise<CreatedApiKey> {
  const { raw, hash, prefix } = generateApiKey();

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO api_keys (tenant_id, key_hash, key_prefix, name, scopes, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [input.tenantId, hash, prefix, input.name ?? null, input.scopes ?? [], input.expiresAt ?? null],
  );

  const row = rows[0];
  if (!row) throw new Error('createApiKey: insert returned no row');

  return { raw, id: row.id, prefix };
}

export interface ActiveApiKeyWithPlan {
  readonly id: string;
  readonly tenantId: string;
  readonly scopes: readonly string[];
  readonly keyHash: string;
  readonly plan: { readonly limit: number; readonly windowSec: number; readonly burst: number };
}

/**
 * Aktif (revoke edilmemiş, süresi geçmemiş) key'i tenant'ın planıyla birlikte
 * getirir — tenant `suspended` ise de eşleşmez. Hot path'te tek sorgu.
 */
export async function findActiveApiKeyWithPlan(pool: DbPool, keyHash: string): Promise<ActiveApiKeyWithPlan | null> {
  const { rows } = await pool.query<{
    id: string;
    tenant_id: string;
    scopes: string[];
    key_hash: string;
    rate_limit: number;
    window_sec: number;
    burst: number;
  }>(
    `SELECT ak.id, ak.tenant_id, ak.scopes, ak.key_hash, p.rate_limit, p.window_sec, p.burst
     FROM api_keys ak
     JOIN tenants t ON t.id = ak.tenant_id
     JOIN plans p ON p.id = t.plan_id
     WHERE ak.key_hash = $1
       AND ak.revoked_at IS NULL
       AND (ak.expires_at IS NULL OR ak.expires_at > now())
       AND t.status = 'active'`,
    [keyHash],
  );

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    tenantId: row.tenant_id,
    scopes: row.scopes,
    keyHash: row.key_hash,
    plan: { limit: row.rate_limit, windowSec: row.window_sec, burst: row.burst },
  };
}

export interface ApiKeySummary {
  readonly id: string;
  readonly tenantId: string;
  /** Ham key ve hash asla dönmez — sadece UI'da tanınabilirlik için prefix. */
  readonly prefix: string;
  readonly name: string | null;
  readonly scopes: readonly string[];
  readonly lastUsedAt: string | null;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

export async function listApiKeysForTenant(pool: DbPool, tenantId: string): Promise<ApiKeySummary[]> {
  const { rows } = await pool.query<{
    id: string;
    tenant_id: string;
    key_prefix: string;
    name: string | null;
    scopes: string[];
    last_used_at: string | null;
    expires_at: string | null;
    revoked_at: string | null;
    created_at: string;
  }>(
    `SELECT id, tenant_id, key_prefix, name, scopes, last_used_at, expires_at, revoked_at, created_at
     FROM api_keys WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId],
  );

  return rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    prefix: row.key_prefix,
    name: row.name,
    scopes: row.scopes,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  }));
}

export async function touchApiKeyLastUsed(pool: DbPool, id: string): Promise<void> {
  await pool.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [id]);
}

/** Revoke eder ve invalidation için hash'i döner (çağıran cache'i silmeli). */
export async function revokeApiKey(pool: DbPool, id: string): Promise<{ hash: string } | null> {
  const { rows } = await pool.query<{ key_hash: string }>(
    'UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING key_hash',
    [id],
  );

  const row = rows[0];
  return row ? { hash: row.key_hash } : null;
}
