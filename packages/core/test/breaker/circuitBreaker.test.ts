import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from '../../src/breaker/circuitBreaker.js';

const options = { failureThreshold: 3, resetTimeoutMs: 1000 };

describe('CircuitBreaker', () => {
  it('starts closed and allows requests', () => {
    const breaker = new CircuitBreaker(options);
    expect(breaker.getState()).toBe('closed');
    expect(breaker.canRequest(0)).toBe(true);
  });

  it('stays closed below the failure threshold', () => {
    const breaker = new CircuitBreaker(options);
    breaker.recordFailure(0);
    breaker.recordFailure(0);
    expect(breaker.getState()).toBe('closed');
    expect(breaker.canRequest(0)).toBe(true);
  });

  it('opens after `failureThreshold` consecutive failures', () => {
    const breaker = new CircuitBreaker(options);
    breaker.recordFailure(0);
    breaker.recordFailure(0);
    breaker.recordFailure(0);
    expect(breaker.getState()).toBe('open');
    expect(breaker.canRequest(0)).toBe(false);
  });

  it('a success resets the failure count', () => {
    const breaker = new CircuitBreaker(options);
    breaker.recordFailure(0);
    breaker.recordFailure(0);
    breaker.recordSuccess();
    breaker.recordFailure(0);
    breaker.recordFailure(0);
    // 2 failures again after the reset, still below threshold of 3
    expect(breaker.getState()).toBe('closed');
  });

  it('moves to half-open after resetTimeoutMs and allows exactly one trial', () => {
    const breaker = new CircuitBreaker(options);
    breaker.recordFailure(0);
    breaker.recordFailure(0);
    breaker.recordFailure(0);
    expect(breaker.canRequest(500)).toBe(false); // too soon

    expect(breaker.canRequest(1000)).toBe(true); // resetTimeoutMs elapsed
    expect(breaker.getState()).toBe('half-open');
    expect(breaker.canRequest(1000)).toBe(false); // a trial is already in flight
  });

  it('half-open success closes the circuit', () => {
    const breaker = new CircuitBreaker(options);
    breaker.recordFailure(0);
    breaker.recordFailure(0);
    breaker.recordFailure(0);
    breaker.canRequest(1000); // enter half-open, consume the trial slot

    breaker.recordSuccess();
    expect(breaker.getState()).toBe('closed');
    expect(breaker.canRequest(1000)).toBe(true);
  });

  it('half-open failure reopens the circuit for another full resetTimeoutMs', () => {
    const breaker = new CircuitBreaker(options);
    breaker.recordFailure(0);
    breaker.recordFailure(0);
    breaker.recordFailure(0);
    breaker.canRequest(1000); // enter half-open

    breaker.recordFailure(1000);
    expect(breaker.getState()).toBe('open');
    expect(breaker.canRequest(1500)).toBe(false);
    expect(breaker.canRequest(2000)).toBe(true); // another full resetTimeoutMs later
  });
});
