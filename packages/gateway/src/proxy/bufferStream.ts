import type { Readable } from 'node:stream';

/** Streams are consumable only once — buffer when a body needs to be reused (retry) or inspected (cache). */
export async function bufferStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferLike));
  }
  return Buffer.concat(chunks);
}
