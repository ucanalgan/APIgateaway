import type { RouteConfig } from '../config/schema.js';

export interface MatchInput {
  readonly method: string;
  readonly path: string;
}

/**
 * Route array'i sırayla taranır, ilk eşleşen döner. Config'de daha spesifik
 * route'lar genel olanlardan önce tanımlanmalı — sıra öncelik demektir.
 */
export function matchRoute(routes: readonly RouteConfig[], input: MatchInput): RouteConfig | undefined {
  return routes.find((route) => matchesMethod(route, input.method) && matchesPath(route, input.path));
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
