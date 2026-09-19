import { describe, expect, it } from 'vitest';
import { extractBearerToken } from '../src/http/bearerToken.js';

describe('extractBearerToken', () => {
  it('returns the token for a Bearer header, case-insensitively on the scheme', () => {
    expect(extractBearerToken('Bearer abc.def')).toBe('abc.def');
    expect(extractBearerToken('bearer abc')).toBe('abc');
    expect(extractBearerToken('BEARER abc')).toBe('abc');
  });

  it('returns undefined for a missing header', () => {
    expect(extractBearerToken(undefined)).toBeUndefined();
    expect(extractBearerToken('')).toBeUndefined();
  });

  it('returns undefined for another scheme or a scheme with no token', () => {
    expect(extractBearerToken('Basic dXNlcjpwdw==')).toBeUndefined();
    expect(extractBearerToken('Bearer')).toBeUndefined();
    expect(extractBearerToken('Bearer ')).toBeUndefined();
  });
});
