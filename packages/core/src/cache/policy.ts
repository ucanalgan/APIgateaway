export interface CacheDecision {
  readonly cacheable: boolean;
  /** Sadece `cacheable: true` iken anlamlı. */
  readonly ttlSec: number;
}

/**
 * Upstream'in `Cache-Control` header'ını route'un varsayılan `ttlSec`'i ile
 * birleştirir. `no-store`/`no-cache`/`private` varsa hiç cache'lenmez —
 * paylaşımlı (shared) bir cache olarak gateway `private` yanıtları
 * saklamamalı. `max-age` varsayılanı override eder ama route'un TTL'ini
 * aşamaz (operatör her zaman bir üst sınır koyabilmeli). Sadece `200`
 * cache'lenir — diğer durum kodları (özellikle hatalar) hiç saklanmaz.
 */
export function decideCacheability(
  statusCode: number,
  responseHeaders: Record<string, string | string[] | undefined>,
  defaultTtlSec: number,
): CacheDecision {
  if (statusCode !== 200) return { cacheable: false, ttlSec: 0 };

  const directives = parseCacheControl(responseHeaders['cache-control']);

  if (directives.noStore || directives.noCache || directives.private) {
    return { cacheable: false, ttlSec: 0 };
  }

  const ttlSec = directives.maxAge !== undefined ? Math.min(directives.maxAge, defaultTtlSec) : defaultTtlSec;
  if (ttlSec <= 0) return { cacheable: false, ttlSec: 0 };

  return { cacheable: true, ttlSec };
}

interface CacheControlDirectives {
  readonly noStore: boolean;
  readonly noCache: boolean;
  readonly private: boolean;
  readonly maxAge?: number;
}

function parseCacheControl(value: string | string[] | undefined): CacheControlDirectives {
  const raw = Array.isArray(value) ? value.join(', ') : (value ?? '');
  const directives = raw
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);

  let maxAge: number | undefined;
  for (const directive of directives) {
    if (!directive.startsWith('max-age=')) continue;
    const parsed = Number(directive.slice('max-age='.length));
    if (Number.isFinite(parsed)) maxAge = parsed;
  }

  return {
    noStore: directives.includes('no-store'),
    noCache: directives.includes('no-cache'),
    private: directives.includes('private'),
    ...(maxAge !== undefined ? { maxAge } : {}),
  };
}
