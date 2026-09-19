import type { FastifyRequest } from 'fastify';
import { redactUrl } from '../websocket/url.js';

/**
 * Fastify'ın varsayılan request logu zaten header'ları dökmüyor (sadece
 * method/url/remoteAddress), o yüzden API key'ler bugün zaten loglanmıyor.
 * Bu, `logger.redact`'e verilecek savunma amaçlı bir ek katman — ileride
 * birisi header logging eklerse `Authorization`/admin token sızmasın.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-admin-token"]',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];

/**
 * Fastify'ın varsayılan `req` serializer'ı ile aynı alanlar — tek fark, URL'deki
 * `?access_token=` değerinin maskelenmesi (bkz. websocket/url.ts): token sorgu
 * dizesinde geliyorsa `url` log'a düz yazılırsa token loglara sızardı.
 */
export function serializeRequest(request: FastifyRequest): Record<string, unknown> {
  return {
    method: request.method,
    url: redactUrl(request.url),
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  };
}
