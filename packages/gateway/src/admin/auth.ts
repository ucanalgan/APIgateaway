import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { extractBearerToken } from '../http/bearerToken.js';

/**
 * Admin, tenant kavramının dışında — platform operatörü içindir, bu yüzden
 * apiKey/jwt tenant auth'unu ödünç almak yerine tek bir paylaşılan secret
 * kullanır. `sha256` + `timingSafeEqual`: hem timing attack'a karşı, hem de
 * `timingSafeEqual`'ın farklı uzunluktaki buffer'larda attığı hatadan kaçınır.
 */
export function verifyAdminToken(presented: string, configured: string): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(configured).digest();
  return timingSafeEqual(a, b);
}

export function requireAdminToken(token: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const presented = extractBearerToken(request.headers.authorization);

    if (!presented || !verifyAdminToken(presented, token)) {
      await reply.code(401).send({
        error: 'unauthorized',
        message: 'Missing or invalid admin token — expected "Authorization: Bearer <token>".',
        requestId: request.id,
      });
    }
  };
}
