import { request as undiciRequest } from 'undici';
import { CircuitBreaker } from '@apigate/core/breaker';
import type { RouteConfig } from '../config/schema.js';

interface TargetState {
  readonly url: string;
  healthy: boolean;
  readonly breaker: CircuitBreaker | undefined;
}

export interface TargetSnapshot {
  readonly url: string;
  readonly healthy: boolean;
  /** `undefined` — bu route'ta circuitBreaker yapılandırılmamış. */
  readonly circuitState: 'closed' | 'open' | 'half-open' | undefined;
}

export interface Balancer {
  /** Round-robin ile sıradaki müsait target'ı döner; hiçbiri müsait değilse `undefined`. */
  pickTarget(): string | undefined;
  reportSuccess(target: string): void;
  reportFailure(target: string): void;
  /** Metrik scrape'i için anlık durum — `/metrics` bunu okuyup gauge'ları tazeler. */
  getTargetStates(): readonly TargetSnapshot[];
  /** Health check interval'ini durdurur — graceful shutdown'da çağır. */
  close(): void;
}

/**
 * Her route için bir kez oluşturulur. `route.upstream.healthCheck`
 * verilmişse periyodik aktif prob yapar (round-robin havuzundan çıkar/girer);
 * `route.circuitBreaker` verilmişse her target'ın kendi breaker'ı olur
 * (gerçek isteklerdeki hatalardan pasif olarak öğrenir). İkisi de opsiyonel
 * — hiçbiri yoksa tüm target'lar her zaman müsait sayılır.
 */
export function createBalancer(route: RouteConfig): Balancer {
  const targets: TargetState[] = route.upstream.targets.map((url) => ({
    url,
    healthy: true,
    breaker: route.circuitBreaker ? new CircuitBreaker(route.circuitBreaker) : undefined,
  }));

  let cursor = 0;
  let healthCheckTimer: NodeJS.Timeout | undefined;

  const healthCheck = route.upstream.healthCheck;
  if (healthCheck) {
    const probeAll = (): void => {
      void Promise.all(targets.map((target) => probe(target, healthCheck.path, route.upstream.timeoutMs)));
    };

    probeAll();
    healthCheckTimer = setInterval(probeAll, healthCheck.intervalMs);
    healthCheckTimer.unref();
  }

  return {
    pickTarget(): string | undefined {
      for (let i = 0; i < targets.length; i++) {
        const index = (cursor + i) % targets.length;
        const target = targets[index]!;
        if (!target.healthy) continue;
        if (target.breaker && !target.breaker.canRequest()) continue;

        cursor = (index + 1) % targets.length;
        return target.url;
      }
      return undefined;
    },

    reportSuccess(url: string): void {
      targets.find((target) => target.url === url)?.breaker?.recordSuccess();
    },

    reportFailure(url: string): void {
      targets.find((target) => target.url === url)?.breaker?.recordFailure();
    },

    getTargetStates(): readonly TargetSnapshot[] {
      return targets.map((target) => ({
        url: target.url,
        healthy: target.healthy,
        circuitState: target.breaker?.getState(),
      }));
    },

    close(): void {
      if (healthCheckTimer) clearInterval(healthCheckTimer);
    },
  };
}

async function probe(target: TargetState, path: string, timeoutMs: number): Promise<void> {
  try {
    const { statusCode } = await undiciRequest(new URL(path, target.url), {
      method: 'GET',
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
    target.healthy = statusCode >= 200 && statusCode < 400;
  } catch {
    target.healthy = false;
  }
}
