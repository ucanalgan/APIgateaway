import type { RouteConfig } from '../config/schema.js';

export interface MatchInput {
  readonly method: string;
  readonly path: string;
  /** İstek host'u (port hariç) — bkz. `normalizeHost`. Yoksa `match.host` olan route'lar eşleşmez. */
  readonly host?: string | undefined;
}

/** Küçük harfe çevirir, FQDN'in sondaki noktasını atar. Boşsa `undefined`. */
export function normalizeHost(hostname: string | undefined): string | undefined {
  if (!hostname) return undefined;
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === '' ? undefined : host;
}

/**
 * Route array'i sırayla taranır, ilk eşleşen döner. Config'de daha spesifik
 * route'lar genel olanlardan önce tanımlanmalı — sıra öncelik demektir
 * (örn. `host` verilmiş bir route, host'suz bir `/*` route'undan önce gelmeli).
 */
export function matchRoute(routes: readonly RouteConfig[], input: MatchInput): RouteConfig | undefined {
  const host = normalizeHost(input.host);
  return routes.find(
    (route) => matchesMethod(route, input.method) && matchesPath(route, input.path) && matchesHost(route, host),
  );
}

/**
 * Method'u yok sayar — CORS preflight (`OPTIONS` + `Access-Control-Request-Method`)
 * bir route'un `match.methods` kısıtına gerçekte hiç uymaz (tarayıcı gerçek
 * metotla değil, hep `OPTIONS` ile sorar). Preflight'a doğru route'un
 * `cors` config'ini bulmak için kullanılır — bkz. server.ts. Host yine
 * uygulanır: aksi halde bir host'a gelen preflight başka bir host'un route'unun
 * CORS politikasıyla cevaplanırdı.
 */
export function matchRouteByPath(
  routes: readonly RouteConfig[],
  path: string,
  host?: string | undefined,
): RouteConfig | undefined {
  const normalized = normalizeHost(host);
  return routes.find((route) => matchesPath(route, path) && matchesHost(route, normalized));
}

function matchesMethod(route: RouteConfig, method: string): boolean {
  const methods = route.match.methods;
  return !methods || methods.includes(method as (typeof methods)[number]);
}

function matchesPath(route: RouteConfig, path: string): boolean {
  const pattern = route.match.path;

  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -2);
    return path === prefix || path.startsWith(`${prefix}/`);
  }

  return path === pattern;
}

function matchesHost(route: RouteConfig, host: string | undefined): boolean {
  const pattern = route.match.host?.toLowerCase();
  if (pattern === undefined) return true;
  if (host === undefined) return false;

  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1); // ".example.com"
    return host.length > suffix.length && host.endsWith(suffix);
  }

  return host === pattern;
}
