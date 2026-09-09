export interface Policy {
  readonly limit: number;
  readonly windowMs: number;
  /** Burst kapasitesi. Verilmezse `limit` kullanılır. */
  readonly burst?: number;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly retryAfterMs: number;
}

export interface Store {
  /**
   * Kota tüketir. Atomik olmak zorunda — oku-hesapla-yaz şeklinde
   * uygulanırsa eşzamanlı çağrılar limiti aşar.
   */
  consume(key: string, policy: Policy, cost?: number): Promise<RateLimitResult>;

  reset(key: string): Promise<void>;
  close(): Promise<void>;
}
