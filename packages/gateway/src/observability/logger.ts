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
