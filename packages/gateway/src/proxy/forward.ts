import type { IncomingHttpHeaders } from 'node:http';
import type { Readable } from 'node:stream';
import { errors as undiciErrors, request as undiciRequest, type Dispatcher } from 'undici';
import { joinUpstreamUrl } from './upstreamUrl.js';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export class UpstreamTimeoutError extends Error {}

export interface ForwardOptions {
  readonly method: string;
  readonly headers: IncomingHttpHeaders;
  /**
   * A `Buffer` (not a `Readable`) when the caller might retry this request —
   * streams can only be consumed once, so retry.ts buffers the body first.
   */
  readonly body: Readable | Buffer | undefined;
  readonly timeoutMs: number;
  /** İki gövde parçası arası azami süre; verilmezse `timeoutMs`, `0` = sınırsız (SSE). */
  readonly bodyTimeoutMs?: number;
  readonly clientIp: string;
  readonly requestId: string;
}

export interface ForwardResult {
  readonly statusCode: number;
  readonly headers: Record<string, string | string[]>;
  readonly body: Readable;
}

export async function forwardRequest(target: string, path: string, opts: ForwardOptions): Promise<ForwardResult> {
  const url = joinUpstreamUrl(target, path);

  try {
    const { statusCode, headers, body } = await undiciRequest(url, {
      method: opts.method as Dispatcher.HttpMethod,
      headers: buildOutgoingHeaders(opts),
      ...(opts.body ? { body: opts.body } : {}),
      headersTimeout: opts.timeoutMs,
      bodyTimeout: opts.bodyTimeoutMs ?? opts.timeoutMs,
    });

    return {
      statusCode,
      headers: stripHopByHop(headers),
      body: body as unknown as Readable,
    };
  } catch (err) {
    if (err instanceof undiciErrors.HeadersTimeoutError || err instanceof undiciErrors.BodyTimeoutError) {
      throw new UpstreamTimeoutError(`Upstream did not respond within ${opts.timeoutMs}ms`);
    }
    throw err;
  }
}

/** Upstream'e giden header'lar: hop-by-hop/host atılır, X-Forwarded-* ve request id eklenir. WebSocket el sıkışması da bunu kullanır. */
export function buildOutgoingHeaders(opts: Pick<ForwardOptions, 'headers' | 'clientIp' | 'requestId'>): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};

  for (const [key, value] of Object.entries(opts.headers)) {
    if (value === undefined || key === 'host' || HOP_BY_HOP_HEADERS.has(key)) continue;
    result[key] = value;
  }

  const existingForwardedFor = opts.headers['x-forwarded-for'];
  result['x-forwarded-for'] = existingForwardedFor
    ? `${Array.isArray(existingForwardedFor) ? existingForwardedFor.join(', ') : existingForwardedFor}, ${opts.clientIp}`
    : opts.clientIp;
  result['x-forwarded-proto'] = 'http';
  result['x-request-id'] = opts.requestId;

  if (typeof opts.headers['host'] === 'string') {
    result['x-forwarded-host'] = opts.headers['host'];
  }

  return result;
}

function stripHopByHop(headers: Record<string, string | string[] | undefined>): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(key)) continue;
    result[key] = value;
  }

  return result;
}
