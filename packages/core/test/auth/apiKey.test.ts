import { describe, expect, it } from 'vitest';
import {
  generateApiKey,
  hashApiKey,
  verifyApiKey,
  verifyApiKeyHash,
} from '../../src/auth/apiKey.js';

describe('generateApiKey', () => {
  it('produces a raw key, its hash, and a matching prefix', () => {
    const { raw, hash, prefix } = generateApiKey();

    expect(raw).toMatch(/^ag_live_/);
    expect(hash).toBe(hashApiKey(raw));
    expect(raw.startsWith(prefix)).toBe(true);
  });

  it('never produces the same raw key twice', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.raw).not.toBe(b.raw);
  });
});

describe('verifyApiKeyHash', () => {
  it('accepts the correct key', () => {
    const { raw, hash } = generateApiKey();
    expect(verifyApiKeyHash(raw, hash)).toBe(true);
  });

  it('rejects a wrong key', () => {
    const { hash } = generateApiKey();
    expect(verifyApiKeyHash('ag_live_not-the-right-one', hash)).toBe(false);
  });

  it('rejects a hash of different length without throwing', () => {
    const { raw } = generateApiKey();
    expect(verifyApiKeyHash(raw, 'deadbeef')).toBe(false);
  });
});

describe('verifyApiKey', () => {
  it('resolves tenant + scopes when the lookup finds a matching hash', async () => {
    const { raw, hash } = generateApiKey();

    const result = await verifyApiKey(raw, async (h) => {
      expect(h).toBe(hash);
      return { tenantId: 'tenant-1', scopes: ['read', 'write'], hash };
    });

    expect(result).toEqual({ tenantId: 'tenant-1', scopes: ['read', 'write'] });
  });

  it('returns null when the lookup finds nothing', async () => {
    const { raw } = generateApiKey();
    const result = await verifyApiKey(raw, async () => null);
    expect(result).toBeNull();
  });

  it('returns null when the lookup returns a record with a mismatched hash', async () => {
    const { raw } = generateApiKey();
    const other = generateApiKey();

    const result = await verifyApiKey(raw, async () => ({
      tenantId: 'tenant-1',
      scopes: [],
      hash: other.hash,
    }));

    expect(result).toBeNull();
  });
});
