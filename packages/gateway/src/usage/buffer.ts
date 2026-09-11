import type { DbPool } from '../db/client.js';
import { insertUsageBatch, type UsageRecord } from '../db/repositories/usage.js';

export interface UsageBuffer {
  push(record: UsageRecord): void;
  flush(): Promise<void>;
  /** Interval'i durdurur ve kalanı son bir kez yazar — graceful shutdown'da çağır. */
  close(): Promise<void>;
}

export interface UsageBufferOptions {
  readonly flushIntervalMs?: number;
  readonly maxBatchSize?: number;
  readonly onError?: (err: unknown) => void;
}

/**
 * Her istekte Postgres'e yazmak istek yolunu yavaşlatır (bkz. PLAN.md §6).
 * Bunun yerine bellekte biriktirip periyodik/eşik dolunca toplu INSERT eder.
 */
export function createUsageBuffer(pool: DbPool, options: UsageBufferOptions = {}): UsageBuffer {
  const flushIntervalMs = options.flushIntervalMs ?? 5000;
  const maxBatchSize = options.maxBatchSize ?? 500;
  const onError = options.onError ?? (() => {});

  let buffer: UsageRecord[] = [];

  const timer = setInterval(() => {
    void flush();
  }, flushIntervalMs);
  timer.unref();

  async function flush(): Promise<void> {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];

    try {
      await insertUsageBatch(pool, batch);
    } catch (err) {
      // Kullanım kaydı analitik amaçlı — yazımı başarısız olsa da isteğin
      // kendisini etkilememeli.
      onError(err);
    }
  }

  return {
    push(record) {
      buffer.push(record);
      if (buffer.length >= maxBatchSize) void flush();
    },
    flush,
    async close() {
      clearInterval(timer);
      await flush();
    },
  };
}
