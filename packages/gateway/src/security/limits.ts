import type { FastifyReply, FastifyRequest } from 'fastify';

export function enforceHeaderLimit(maxHeaderCount: number) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const count = Object.keys(request.headers).length;

    if (count > maxHeaderCount) {
      await reply.code(431).send({
        error: 'too_many_headers',
        message: `Request has ${count} headers, limit is ${maxHeaderCount}.`,
        requestId: request.id,
      });
    }
  };
}
