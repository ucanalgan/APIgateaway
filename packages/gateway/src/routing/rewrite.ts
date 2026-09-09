import type { RouteConfig } from '../config/schema.js';

/**
 * `stripPrefix` uygulanmış hedef path + query string döner.
 * Örn: url=/api/v1/users/42, stripPrefix=/api/v1 → /users/42
 */
export function rewritePath(originalUrl: string, route: RouteConfig): string {
  const [path, query] = splitUrl(originalUrl);
  const stripPrefix = route.rewrite?.stripPrefix;

  let rewritten = path;
  if (stripPrefix && path.startsWith(stripPrefix)) {
    rewritten = path.slice(stripPrefix.length);
    if (!rewritten.startsWith('/')) {
      rewritten = `/${rewritten}`;
    }
  }

  return query === undefined ? rewritten : `${rewritten}?${query}`;
}

function splitUrl(url: string): [string, string | undefined] {
  const idx = url.indexOf('?');
  return idx === -1 ? [url, undefined] : [url.slice(0, idx), url.slice(idx + 1)];
}
