/**
 * Upstream'e gidecek tam URL'yi kurar: `target`'ın **origin**'i (şema + host +
 * port) sabit kalır, `path` (+ query) onun arkasına eklenir.
 *
 * `new URL(path, target)` bunun için güvenli DEĞİL: istemci `//baska-host/x`
 * gibi bir istek satırı gönderirse WHATWG URL bunu "şema-göreli" bir başvuru
 * sayıp **host'u değiştirir** — gateway, route'un hiç işaret etmediği bir
 * (örn. iç ağdaki) servise istek atardı (SSRF). Burada path her zaman origin'den
 * sonraki kısımdır; `//x/y` upstream'e `//x/y` yolu olarak gider, host olarak değil.
 */
export function joinUpstreamUrl(target: string, path: string): URL {
  const origin = new URL(target).origin;
  return new URL(`${origin}${path.startsWith('/') ? path : `/${path}`}`);
}
