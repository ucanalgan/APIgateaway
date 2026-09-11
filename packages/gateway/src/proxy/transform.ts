import type { IncomingHttpHeaders } from 'node:http';
import type { RouteConfig } from '../config/schema.js';

/** `route.transform.request` — upstream'e giden istekten header ekler/siler. */
export function applyRequestTransform(route: RouteConfig, headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const transform = route.transform?.request;
  if (!transform) return headers;

  const result: IncomingHttpHeaders = { ...headers };

  for (const name of transform.removeHeaders) {
    delete result[name.toLowerCase()];
  }
  for (const [name, value] of Object.entries(transform.setHeaders)) {
    result[name.toLowerCase()] = value;
  }

  return result;
}
