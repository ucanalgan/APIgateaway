export interface CachedResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string | string[]>;
  readonly body: Buffer;
}

export interface CacheStore {
  get(key: string): Promise<CachedResponse | null>;
  set(key: string, response: CachedResponse, ttlSec: number): Promise<void>;
  /** Removes every live entry whose key starts with `prefix`; resolves with how many were removed. */
  deleteByPrefix(prefix: string): Promise<number>;
  close(): Promise<void>;
}
