/**
 * Tarayıcıdaki `new WebSocket()` `Authorization` başlığı gönderemez, bu yüzden
 * (route'ta `websocket.queryToken` açıksa) token `?access_token=` ile gelir
 * (RFC 6750 §2.3). URL'ler log'lara ve ara proxy'lere sızabildiği için token
 * her yerde maskelenir ve upstream'e URL'de iletilmez.
 */
export const ACCESS_TOKEN_PARAM = 'access_token';

const REDACTED = '[redacted]';

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function splitUrl(url: string): [path: string, query: string | undefined] {
  const idx = url.indexOf('?');
  return idx === -1 ? [url, undefined] : [url.slice(0, idx), url.slice(idx + 1)];
}

function keyOf(pair: string): string {
  const eq = pair.indexOf('=');
  return safeDecode(eq === -1 ? pair : pair.slice(0, eq));
}

/** Boş değer "yok" sayılır. */
export function extractQueryToken(url: string, name: string = ACCESS_TOKEN_PARAM): string | undefined {
  const [, query] = splitUrl(url);
  if (query === undefined) return undefined;

  for (const pair of query.split('&')) {
    if (keyOf(pair) !== name) continue;
    const eq = pair.indexOf('=');
    const value = eq === -1 ? '' : safeDecode(pair.slice(eq + 1));
    if (value !== '') return value;
  }
  return undefined;
}

/** Diğer parametreleri olduğu gibi (yeniden kodlamadan) bırakıp `name`'i çıkarır. */
export function stripQueryParam(url: string, name: string = ACCESS_TOKEN_PARAM): string {
  const [path, query] = splitUrl(url);
  if (query === undefined) return url;

  const kept = query.split('&').filter((pair) => pair !== '' && keyOf(pair) !== name);
  return kept.length === 0 ? path : `${path}?${kept.join('&')}`;
}

/** Log'a yazılacak URL — `access_token`'ın değeri maskelenir, geri kalan aynen kalır. */
export function redactUrl(url: string, name: string = ACCESS_TOKEN_PARAM): string {
  const [path, query] = splitUrl(url);
  if (query === undefined) return url;

  const masked = query.split('&').map((pair) => (keyOf(pair) === name ? `${pair.split('=')[0]}=${REDACTED}` : pair));
  return `${path}?${masked.join('&')}`;
}
