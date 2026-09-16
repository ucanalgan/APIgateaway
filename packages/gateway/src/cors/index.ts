import type { FastifyReply } from 'fastify';
import type { RouteConfig } from '../config/schema.js';

export type CorsConfig = NonNullable<RouteConfig['cors']>;

/** `'*'` joker; aksi halde `origin` listede birebir olmalı. */
export function isOriginAllowed(cors: CorsConfig, origin: string): boolean {
  return cors.origins.includes('*') || cors.origins.includes(origin);
}

/**
 * `credentials: true` iken tarayıcı `Access-Control-Allow-Origin: *`'ı
 * reddeder (spec) — bu yüzden credentials açıksa joker olsa bile origin
 * birebir yansıtılır, asla `*` ile birleşmez.
 */
function allowOriginValue(cors: CorsConfig, origin: string): string {
  return cors.origins.includes('*') && !cors.credentials ? '*' : origin;
}

/** Preflight olmayan (asıl) her yanıta uygulanır — başarı, 401, 429, 5xx fark etmez. */
export function applyCorsResponseHeaders(cors: CorsConfig, origin: string, reply: FastifyReply): void {
  reply.header('Access-Control-Allow-Origin', allowOriginValue(cors, origin));
  reply.header('Vary', 'Origin');
  if (cors.credentials) reply.header('Access-Control-Allow-Credentials', 'true');
  if (cors.exposedHeaders.length > 0) {
    reply.header('Access-Control-Expose-Headers', cors.exposedHeaders.join(', '));
  }
}

/** Sadece preflight (`OPTIONS` + `Access-Control-Request-Method`) yanıtına. */
export function applyPreflightHeaders(cors: CorsConfig, origin: string, reply: FastifyReply): void {
  applyCorsResponseHeaders(cors, origin, reply);
  reply.header('Access-Control-Allow-Methods', cors.methods.join(', '));
  reply.header('Access-Control-Allow-Headers', cors.allowedHeaders.join(', '));
  reply.header('Access-Control-Max-Age', String(cors.maxAgeSec));
}
