import { describe, expect, it } from 'vitest';
import { decideCacheability } from '../../src/cache/policy.js';

describe('decideCacheability', () => {
  it('uses the route default TTL when there is no Cache-Control header', () => {
    const decision = decideCacheability(200, {}, 60);
    expect(decision).toEqual({ cacheable: true, ttlSec: 60 });
  });

  it('never caches a non-200 response', () => {
    for (const statusCode of [201, 204, 301, 404, 500]) {
      expect(decideCacheability(statusCode, {}, 60).cacheable).toBe(false);
    }
  });

  it('never caches no-store', () => {
    const decision = decideCacheability(200, { 'cache-control': 'no-store' }, 60);
    expect(decision.cacheable).toBe(false);
  });

  it('never caches no-cache', () => {
    const decision = decideCacheability(200, { 'cache-control': 'no-cache' }, 60);
    expect(decision.cacheable).toBe(false);
  });

  it('never caches private (shared cache must not store it)', () => {
    const decision = decideCacheability(200, { 'cache-control': 'private, max-age=120' }, 60);
    expect(decision.cacheable).toBe(false);
  });

  it('uses upstream max-age when it is shorter than the route default', () => {
    const decision = decideCacheability(200, { 'cache-control': 'max-age=10' }, 60);
    expect(decision).toEqual({ cacheable: true, ttlSec: 10 });
  });

  it('caps upstream max-age at the route default, never exceeds it', () => {
    const decision = decideCacheability(200, { 'cache-control': 'max-age=3600' }, 60);
    expect(decision).toEqual({ cacheable: true, ttlSec: 60 });
  });

  it('treats max-age=0 as not cacheable', () => {
    const decision = decideCacheability(200, { 'cache-control': 'max-age=0' }, 60);
    expect(decision.cacheable).toBe(false);
  });

  it('handles a multi-valued header the same as a joined string', () => {
    const decision = decideCacheability(200, { 'cache-control': ['public', 'max-age=30'] }, 60);
    expect(decision).toEqual({ cacheable: true, ttlSec: 30 });
  });
});
