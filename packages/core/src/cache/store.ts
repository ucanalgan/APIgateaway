export interface CachedResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string | string[]>;
  readonly body: Buffer;
}

export interface CacheStore {
  get(key: string): Promise<CachedResponse | null>;
  set(key: string, response: CachedResponse, ttlSec: number): Promise<void>;
  close(): Promise<void>;
}
