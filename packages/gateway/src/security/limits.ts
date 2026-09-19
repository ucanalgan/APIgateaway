import { Transform, type Readable } from 'node:stream';
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

export class BodyTooLargeError extends Error {}

/**
 * Gateway body'yi parse etmeden stream olarak proxy'lediği için Fastify'ın
 * kendi `bodyLimit`'i devreye girmez — limiti burada biz uygularız. Bu hook
 * `Content-Length` bildirilmişse tek bayt okumadan reddeder; bildirilmemiş
 * (chunked) gövdeler için bkz. `limitBodySize`.
 */
export function enforceBodyLimit(maxBodyBytes: number) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const declared = Number(request.headers['content-length']);

    if (Number.isFinite(declared) && declared > maxBodyBytes) {
      await reply.code(413).send({
        error: 'payload_too_large',
        message: `Request body is ${declared} bytes, limit is ${maxBodyBytes}.`,
        requestId: request.id,
      });
    }
  };
}

/**
 * Chunked gövdeler (Content-Length yok) akarken sayılır; limit aşılırsa akış
 * `BodyTooLargeError` ile kesilir. Kaynak stream `pipeline` yerine düz `pipe`
 * ile bağlı — `pipeline` hata anında kaynağı (yani client'ın soketini) yok
 * eder, oysa client'a hâlâ bir 413 yanıtı yazabilmemiz gerekiyor.
 */
export function limitBodySize(source: Readable, maxBodyBytes: number): Readable {
  let seen = 0;

  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > maxBodyBytes) {
        callback(new BodyTooLargeError(`Request body exceeds ${maxBodyBytes} bytes.`));
        return;
      }
      callback(null, chunk);
    },
  });

  // Gövde hiç tüketilmezse (örn. GET + body) hata dinleyicisiz kalıp süreci
  // düşürmesin; tüketen taraf (undici / bufferStream) kendi dinleyicisini ekler.
  limiter.on('error', () => {});
  source.on('error', (err) => limiter.destroy(err));
  source.pipe(limiter);

  return limiter;
}
