import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const KEY_PREFIX = 'ag_live_';
const SECRET_BYTE_LENGTH = 24;

export interface GeneratedApiKey {
  /** Sadece üretim anında döner — DB'de asla saklanmaz. */
  readonly raw: string;
  readonly hash: string;
  /** UI'da göstermek için — "ag_live_a1b2c3d4" gibi. */
  readonly prefix: string;
}

export function generateApiKey(): GeneratedApiKey {
  const raw = KEY_PREFIX + randomBytes(SECRET_BYTE_LENGTH).toString('base64url');
  return { raw, hash: hashApiKey(raw), prefix: raw.slice(0, KEY_PREFIX.length + 4) };
}

export function hashApiKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Sabit zamanlı karşılaştırma — `raw`'dan hesaplanan hash, DB'den gelen
 * `expectedHash` ile string `===` yerine bununla karşılaştırılmalı.
 * Timing attack: erken çıkan bir `===` karşılaştırması, doğru hash'i
 * byte byte tahmin etmeye izin verebilir.
 */
export function verifyApiKeyHash(raw: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashApiKey(raw), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export interface AuthResult {
  readonly tenantId: string;
  readonly scopes: readonly string[];
}

export interface ApiKeyRecord {
  readonly tenantId: string;
  readonly scopes: readonly string[];
  readonly hash: string;
}

export type ApiKeyLookup = (hash: string) => Promise<ApiKeyRecord | null>;

/**
 * Basit tüketiciler için: hash'i çıkar, `lookup` ile kaydı bul, sabit
 * zamanlı doğrula. Plan/tenant gibi uygulamaya özel zenginleştirme
 * gerekiyorsa (bkz. gateway/src/auth), `hashApiKey`/`verifyApiKeyHash`
 * primitiflerini doğrudan kullanıp kendi orkestrasyonunu yaz.
 */
export async function verifyApiKey(raw: string, lookup: ApiKeyLookup): Promise<AuthResult | null> {
  const hash = hashApiKey(raw);
  const record = await lookup(hash);
  if (!record || !verifyApiKeyHash(raw, record.hash)) return null;
  return { tenantId: record.tenantId, scopes: record.scopes };
}
