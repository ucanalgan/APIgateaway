export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Bu kadar ardışık hata → devre açılır. */
  readonly failureThreshold: number;
  /** Devre açıldıktan bu kadar ms sonra half-open'da tek deneme yapılır. */
  readonly resetTimeoutMs: number;
}

/**
 * closed → (failureThreshold ardışık hata) → open
 * open → (resetTimeoutMs geçti) → half-open (tek deneme geçer)
 * half-open → başarı → closed  |  half-open → hata → open (sayaç sıfırlanır)
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private halfOpenTrialInFlight = false;

  constructor(private readonly options: CircuitBreakerOptions) {}

  getState(): CircuitState {
    return this.state;
  }

  /**
   * İstek bu breaker üzerinden gönderilebilir mi? `open` durumdaysa ve süre
   * dolmuşsa `half-open`'a geçirir ve tek denemeye izin verir.
   */
  canRequest(now: number = Date.now()): boolean {
    if (this.state === 'closed') return true;

    if (this.state === 'open') {
      if (now - this.openedAt < this.options.resetTimeoutMs) return false;
      this.state = 'half-open';
      this.halfOpenTrialInFlight = false;
    }

    // half-open: aynı anda sadece bir deneme
    if (this.halfOpenTrialInFlight) return false;
    this.halfOpenTrialInFlight = true;
    return true;
  }

  recordSuccess(): void {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.halfOpenTrialInFlight = false;
  }

  recordFailure(now: number = Date.now()): void {
    this.halfOpenTrialInFlight = false;

    if (this.state === 'half-open') {
      this.state = 'open';
      this.openedAt = now;
      return;
    }

    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.options.failureThreshold) {
      this.state = 'open';
      this.openedAt = now;
    }
  }
}
