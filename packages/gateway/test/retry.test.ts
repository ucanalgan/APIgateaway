import { describe, expect, it } from 'vitest';
import { isIdempotentMethod } from '../src/proxy/retry.js';

describe('isIdempotentMethod', () => {
  it('treats GET, HEAD, PUT, DELETE as retryable', () => {
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) {
      expect(isIdempotentMethod(method)).toBe(true);
    }
  });

  it('never retries POST or PATCH', () => {
    for (const method of ['POST', 'PATCH', 'OPTIONS']) {
      expect(isIdempotentMethod(method)).toBe(false);
    }
  });
});
