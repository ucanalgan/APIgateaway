import { describe, expect, it } from 'vitest';
import { verifyAdminToken } from '../src/admin/auth.js';

describe('verifyAdminToken', () => {
  it('accepts the correct token', () => {
    expect(verifyAdminToken('correct-token', 'correct-token')).toBe(true);
  });

  it('rejects a wrong token', () => {
    expect(verifyAdminToken('wrong-token', 'correct-token')).toBe(false);
  });

  it('rejects a token of a different length without throwing', () => {
    expect(verifyAdminToken('short', 'a-much-longer-configured-token')).toBe(false);
  });

  it('rejects an empty presented token', () => {
    expect(verifyAdminToken('', 'correct-token')).toBe(false);
  });
});
