import type { Readable } from 'node:stream';
import { forwardRequest, type ForwardOptions, type ForwardResult } from './forward.js';
import type { Balancer } from './balancer.js';
import { bufferStream } from './bufferStream.js';
import type { RouteConfig } from '../config/schema.js';

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'PUT', 'DELETE']);

export function isIdempotentMethod(method: string): boolean {
  return IDEMPOTENT_METHODS.has(method);
}

export class NoHealthyTargetError extends Error {}

export interface ForwardWithRetryOptions extends Omit<ForwardOptions, 'body'> {
  readonly body: Readable | undefined;
}

/**
 * `balancer.pickTarget()` ile hedef seçer, `forwardRequest`'i çağırır, ve
 * yapılandırılmışsa (sadece idempotent metotlarda) bağlantı hatası/timeout'ta
 * exponential backoff + jitter ile tekrar dener — her denemede balancer
 * tekrar sorulur, böylece devre açılmış/sağlıksız bir target otomatik
 * atlanır. Upstream'in döndüğü bir 5xx retry'a *sebep olmaz* (PLAN.md §9:
 * muhtemelen bug, tekrar denemek yükü katlar) ama breaker'a hata olarak
 * işlenir.
 */
export async function forwardWithRetry(
  route: RouteConfig,
  balancer: Balancer,
  path: string,
  opts: ForwardWithRetryOptions,
): Promise<ForwardResult> {
  const retry = route.retry;
  const eligible = Boolean(retry) && isIdempotentMethod(opts.method);
  const maxAttempts = eligible ? retry!.attempts + 1 : 1;

  // Stream'ler tek seferlik — retry mümkünse body'yi bir kez buffer'la ki
  // her denemede yeniden gönderilebilsin.
  const body = eligible && opts.body ? await bufferStream(opts.body) : opts.body;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const target = balancer.pickTarget();
    if (!target) {
      throw new NoHealthyTargetError(`Route "${route.id}" has no healthy upstream target.`);
    }

    try {
      const result = await forwardRequest(target, path, { ...opts, body });

      if (result.statusCode >= 500) {
        balancer.reportFailure(target);
      } else {
        balancer.reportSuccess(target);
      }

      return result;
    } catch (err) {
      balancer.reportFailure(target);
      lastError = err;

      if (attempt < maxAttempts) {
        await sleep(jitteredBackoff(retry!.backoffMs, attempt));
        continue;
      }
    }
  }

  throw lastError;
}

/** Attempt 1 → [backoffMs, 2*backoffMs), attempt 2 → [2*backoffMs, 4*backoffMs), ... */
function jitteredBackoff(backoffMs: number, attempt: number): number {
  const upper = backoffMs * 2 ** attempt;
  const lower = backoffMs * 2 ** (attempt - 1);
  return lower + Math.random() * (upper - lower);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
