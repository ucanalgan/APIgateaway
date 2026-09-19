import type { IncomingHttpHeaders } from 'node:http';
import type { Socket } from 'node:net';
import type { FastifyReply, FastifyRequest } from 'fastify';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import { createMemoryStore, type Policy, type Store } from '@apigate/core/ratelimit';
import type { RouteConfig } from '../config/schema.js';
import type { Balancer } from '../proxy/balancer.js';
import { buildOutgoingHeaders, UpstreamTimeoutError } from '../proxy/forward.js';
import { joinUpstreamUrl } from '../proxy/upstreamUrl.js';
import { NoHealthyTargetError } from '../proxy/retry.js';
import type { Metrics } from '../observability/metrics.js';
import type { UsageBuffer } from '../usage/buffer.js';
import type { TrackedConnection, WebSocketRegistry } from './registry.js';
import type { PendingUpgrade } from './upgrade.js';

export interface WebSocketDeps {
  readonly registry: WebSocketRegistry;
  readonly metrics: Metrics;
  readonly usageBuffer: UsageBuffer | undefined;
}

export interface ProxyWebSocketArgs {
  readonly route: RouteConfig;
  readonly balancer: Balancer;
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
  readonly upgrade: PendingUpgrade;
  /** Rewrite uygulanmış upstream path + query (`access_token` zaten çıkarılmış). */
  readonly upstreamPath: string;
  /** Route transform'undan geçmiş gelen header'lar. */
  readonly headers: IncomingHttpHeaders;
  readonly deps: WebSocketDeps;
}

/** Bir tarafın kapanış el sıkışmasına yanıt vermezse bağlantıyı kesmeden önce beklenen süre. */
const CLOSE_GRACE_MS = 5_000;
/** Upstream'in reddettiği el sıkışmanın gövdesinden istemciye aktarılacak azami bayt. */
const REJECTION_BODY_LIMIT = 64 * 1024;

class ClientAbortedError extends Error {}

/** Upstream bağlandıktan sonra, istemci tarafı hazır olmadan gelenler — kaybolmasın. */
interface EarlyTraffic {
  readonly messages: Array<{ data: RawData; isBinary: boolean }>;
  closed?: { code: number; reason: Buffer };
  /** Bağlantı kurulunca eklenen geçici dinleyicileri söker. */
  detach(): void;
}

interface Opened {
  readonly kind: 'open';
  readonly ws: WebSocket;
  /** Upstream'in seçtiği alt protokol (seçmediyse `undefined`). */
  readonly protocol: string | undefined;
  readonly early: EarlyTraffic;
}

interface Rejected {
  readonly kind: 'rejected';
  readonly statusCode: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

/**
 * Gateway WebSocket'i **sonlandırır**: istemciyle ayrı, upstream'le ayrı bir
 * bağlantı tutar ve mesajları aralarında taşır. Önce upstream'e bağlanılır;
 * ancak upstream el sıkışmayı kabul ederse istemci `101` alır — upstream 401
 * derse istemci de gerçek bir 401 görür (açılıp hemen kapanan bir bağlantı
 * değil) ve seçilen alt protokol istemciye upstream'in seçtiğiyle döner.
 */
export async function proxyWebSocket(args: ProxyWebSocketArgs): Promise<FastifyReply> {
  const { route, balancer, request, reply, upgrade, deps } = args;
  const cfg = route.websocket!;

  if (deps.registry.countFor(route.id) >= cfg.maxConnections) {
    return reply.code(503).header('retry-after', '1').send({
      error: 'websocket_capacity',
      message: `Route "${route.id}" is at its limit of ${cfg.maxConnections} concurrent WebSocket connections.`,
      requestId: request.id,
    });
  }

  const target = balancer.pickTarget();
  if (!target) throw new NoHealthyTargetError(`Route "${route.id}" has no healthy upstream target.`);

  const url = joinUpstreamUrl(target, args.upstreamPath);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

  const outgoing = buildOutgoingHeaders({
    headers: args.headers,
    clientIp: request.ip,
    requestId: String(request.id),
  });
  // `ws` bu başlıkları kendisi üretir; istemcinin el sıkışmasındakiler upstream'e geçmez.
  // (`ws` çok değerli başlıkları kabul etmez — virgülle birleştirilir.)
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(outgoing)) {
    if (name.startsWith('sec-websocket-') || name === 'upgrade' || name === 'connection' || name === 'origin') continue;
    headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  const origin = typeof args.headers.origin === 'string' ? args.headers.origin : undefined;

  let outcome: Opened | Rejected;
  try {
    outcome = await connectUpstream(
      url.toString(),
      parseProtocols(args.headers['sec-websocket-protocol']),
      {
        headers,
        ...(origin !== undefined ? { origin } : {}),
        handshakeTimeout: route.upstream.timeoutMs,
        maxPayload: cfg.maxMessageBytes,
        perMessageDeflate: false,
      },
      upgrade.socket,
    );
  } catch (err) {
    if (err instanceof ClientAbortedError) {
      // İstemci upstream bağlanırken vazgeçti — yanıtlanacak kimse kalmadı. Soket
      // yarım-açık (istemci FIN yolladı, biz kapatmadık): kapatmazsak sızar ve
      // sunucunun kapanışını süresiz bekletir.
      reply.hijack();
      upgrade.socket.destroy();
      return reply;
    }
    balancer.reportFailure(target);
    throw err;
  }

  if (outcome.kind === 'rejected') {
    if (outcome.statusCode >= 500) {
      balancer.reportFailure(target);
      deps.metrics.recordUpstreamError(route.id, 'websocket_rejected');
    } else {
      balancer.reportSuccess(target);
    }

    for (const name of ['content-type', 'www-authenticate', 'retry-after']) {
      const value = outcome.headers[name];
      if (typeof value === 'string') reply.header(name, value);
    }
    return reply.code(outcome.statusCode).send(outcome.body);
  }

  balancer.reportSuccess(target);
  acceptClient(args, outcome.ws, outcome.protocol, outcome.early);
  return reply;
}

/** Upstream'e bağlanır; açılmasını, reddedilmesini ya da hata vermesini bekler. */
function connectUpstream(
  url: string,
  protocols: string[],
  options: WebSocket.ClientOptions,
  clientSocket: PendingUpgrade['socket'],
): Promise<Opened | Rejected> {
  return new Promise((resolve, reject) => {
    // `ws` istemcisi alt protokol önerip upstream hiçbirini seçmezse bağlantıyı
    // kendisi düşürür ("Server sent no subprotocol") — oysa RFC 6455 buna izin
    // verir ve alt protokolü umursamayan upstream'ler yaygındır. Bu yüzden
    // `protocols` argümanını kullanmayıp öneriyi başlıkla yapıyor, yanıttaki
    // seçimi kendimiz okuyup doğruluyoruz.
    let selected: string | undefined;
    const ws = new WebSocket(url, {
      ...options,
      headers: { ...options.headers, ...(protocols.length > 0 ? { 'sec-websocket-protocol': protocols.join(', ') } : {}) },
      finishRequest: (req) => {
        req.prependListener('upgrade', (res) => {
          const chosen = res.headers['sec-websocket-protocol'];
          selected = typeof chosen === 'string' ? chosen : undefined;
          delete res.headers['sec-websocket-protocol']; // ws'in kendi (fazla katı) doğrulamasını atlat
        });
        req.end();
      },
    });
    // Bu noktadan sonra hangi aşamada olursa olsun 'error' süreci düşürmesin.
    ws.on('error', () => {});

    const onClientClose = (): void => {
      reject(new ClientAbortedError());
      ws.terminate();
    };
    // Node'un HTTP soketleri yarım-açıktır: istemci FIN gönderince yalnızca
    // (okunuyorsa) 'end' yayılır, 'close' ancak biz de kapatınca gelir. El
    // sıkışma sürerken istemciden veri beklenmediği için soketi akışa alıp
    // 'end'i yakalıyoruz.
    clientSocket.once('close', onClientClose);
    clientSocket.once('end', onClientClose);
    clientSocket.resume();
    const settled = (): void => {
      clientSocket.off('close', onClientClose);
      clientSocket.off('end', onClientClose);
    };

    ws.once('open', () => {
      settled();
      // RFC 6455 §4.1: istemcinin önermediği bir alt protokolü seçen sunucu bağlantıyı düşürür.
      if (selected !== undefined && !protocols.includes(selected)) {
        ws.terminate();
        reject(new Error(`Upstream selected a sub-protocol that was not offered: ${selected}`));
        return;
      }
      // İstemci tarafı kabul edilene kadar upstream'in gönderdiği her şeyi (karşılama
      // mesajı, hatta kapanış) tut — `ws` dinleyicisi olmayan mesajı sessizce atar.
      const early: EarlyTraffic = {
        messages: [],
        detach: () => {
          ws.off('message', onEarlyMessage);
          ws.off('close', onEarlyClose);
        },
      };
      const onEarlyMessage = (data: RawData, isBinary: boolean): void => {
        early.messages.push({ data, isBinary });
      };
      const onEarlyClose = (code: number, reason: Buffer): void => {
        early.closed = { code, reason };
      };
      ws.on('message', onEarlyMessage);
      ws.on('close', onEarlyClose);
      resolve({ kind: 'open', ws, protocol: selected, early });
    });

    ws.once('unexpected-response', (_req, res) => {
      settled();
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        if (size >= REJECTION_BODY_LIMIT) return;
        chunks.push(chunk);
        size += chunk.length;
      });
      res.on('end', () => {
        resolve({ kind: 'rejected', statusCode: res.statusCode ?? 502, headers: res.headers, body: Buffer.concat(chunks) });
        ws.terminate();
      });
      res.on('error', (err) => reject(err));
    });

    ws.once('error', (err) => {
      settled();
      reject(/timed out/i.test(err.message) ? new UpstreamTimeoutError(`Upstream did not complete the WebSocket handshake within ${options.handshakeTimeout}ms`) : err);
    });
  });
}

/** Upstream açıldı — istemcinin el sıkışmasını tamamlayıp iki bağlantıyı köprüler. */
function acceptClient(
  args: ProxyWebSocketArgs,
  upstream: WebSocket,
  protocol: string | undefined,
  early: EarlyTraffic,
): void {
  const { route, request, reply, upgrade, deps } = args;
  const cfg = route.websocket!;
  const startedAt = Date.now();

  reply.hijack();
  upgrade.taken = true;
  reply.raw.detachSocket(upgrade.socket as Socket);

  let client: WebSocket | undefined;
  let finished = false;
  let firstCause: string | undefined;
  let closedSides = 0;
  let killTimer: NodeJS.Timeout | undefined;
  let lastActivity = Date.now();
  const timers: NodeJS.Timeout[] = [];

  const tracked: TrackedConnection = {
    routeId: route.id,
    shutdown: () => closeBoth(1001, 'Going Away', 'shutdown'),
    terminate: () => {
      client?.terminate();
      upstream.terminate();
    },
  };
  deps.registry.add(tracked);
  deps.metrics.webSocketOpened(route.id);

  const finish = (): void => {
    if (finished) return;
    finished = true;
    if (killTimer) clearTimeout(killTimer);
    for (const timer of timers) clearInterval(timer);
    deps.registry.remove(tracked);
    deps.metrics.webSocketClosed(route.id, firstCause ?? 'unknown');
    request.log.info(
      { route: route.id, reason: firstCause ?? 'unknown', durationMs: Date.now() - startedAt },
      'websocket closed',
    );
  };

  /** Karşı taraf kapanış el sıkışmasına yanıt vermezse takılıp kalmasın. */
  const armKill = (): void => {
    if (killTimer || finished) return;
    killTimer = setTimeout(() => {
      client?.terminate();
      upstream.terminate();
    }, CLOSE_GRACE_MS);
    killTimer.unref();
  };

  const closeBoth = (code: number, text: string, cause: string): void => {
    firstCause ??= cause;
    for (const ws of [client, upstream]) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.close(code, text);
    }
    armKill();
  };

  const onSideClosed = (): void => {
    if (++closedSides === 2) finish();
  };

  // El sıkışma tamamlanamazsa (ws `handleUpgrade` başarısız olup soketi yok
  // eder, callback hiç çağrılmaz) upstream bağlantısı sızmasın.
  upgrade.socket.once('close', () => {
    if (client) return;
    firstCause ??= 'handshake_failed';
    upstream.terminate();
    closedSides = 1;
    onSideClosed();
  });

  const limiter = cfg.messageRateLimit ? createMessageLimiter(cfg.messageRateLimit) : undefined;

  const relay = (direction: 'client_to_upstream' | 'upstream_to_client', data: RawData, isBinary: boolean): void => {
    const to = direction === 'client_to_upstream' ? upstream : client;
    if (!to || to.readyState !== WebSocket.OPEN) return;

    if (to.bufferedAmount > cfg.maxBufferedBytes) {
      closeBoth(1013, 'Try Again Later', 'backpressure');
      return;
    }

    to.send(data as Buffer, { binary: isBinary }, (err) => {
      if (err) to.terminate();
    });
    deps.metrics.webSocketMessage(route.id, direction);
    lastActivity = Date.now();
  };

  const wss = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    perMessageDeflate: false,
    maxPayload: cfg.maxMessageBytes,
    // İstemciye, upstream'in seçtiği alt protokol döner (yoksa hiçbiri).
    handleProtocols: (offered) => (protocol !== undefined && offered.has(protocol) ? protocol : false),
  });
  wss.on('headers', (headers) => {
    // `ws` başlıkları ham satırlar olarak yazar; id istemciden gelebildiği için satır sonlarından arındırılır.
    headers.push(`x-request-id: ${String(request.id).replace(/[\r\n]/g, '')}`);
  });

  wss.handleUpgrade(request.raw, upgrade.socket, upgrade.head, (accepted) => {
    client = accepted;

    deps.metrics.recordRequest(route.id, 101, reply.elapsedTime / 1000, request.apigateTenantId);
    if (deps.usageBuffer && request.apigateTenantId) {
      deps.usageBuffer.push({
        tenantId: request.apigateTenantId,
        routeId: route.id,
        statusCode: 101,
        latencyMs: Math.round(reply.elapsedTime),
      });
    }
    request.log.info({ route: route.id, protocol }, 'websocket opened');

    // Sıra önemli: limitli akışta mesajlar zincirle sırayla işlenir.
    let chain: Promise<void> = Promise.resolve();
    accepted.on('message', (data, isBinary) => {
      if (!limiter) {
        relay('client_to_upstream', data, isBinary);
        return;
      }
      chain = chain
        .then(async () => {
          if (finished || firstCause !== undefined) return;
          const result = await limiter.store.consume('connection', limiter.policy);
          if (!result.allowed) {
            closeBoth(1008, 'Message rate limit exceeded', 'rate_limited');
            return;
          }
          relay('client_to_upstream', data, isBinary);
        })
        .catch(() => {});
    });
    early.detach();
    upstream.on('message', (data, isBinary) => relay('upstream_to_client', data, isBinary));

    accepted.on('close', (code, reason) => {
      firstCause ??= 'client';
      relayClose(upstream, code, reason);
      armKill();
      onSideClosed();
    });
    const onUpstreamClose = (code: number, reason: Buffer): void => {
      firstCause ??= 'upstream';
      relayClose(accepted, code, reason);
      armKill();
      onSideClosed();
    };
    upstream.on('close', onUpstreamClose);

    // Upstream, istemci tarafı hazır olmadan konuştuysa (karşılama mesajı) sırayla ilet…
    for (const message of early.messages) relay('upstream_to_client', message.data, message.isBinary);
    // …ve hazır olmadan kapandıysa o kapanışı da uygula (olay bir daha gelmez).
    if (early.closed) onUpstreamClose(early.closed.code, early.closed.reason);

    accepted.on('error', (err) => {
      firstCause ??= 'error';
      request.log.warn({ err, route: route.id }, 'websocket client error');
    });
    upstream.on('error', (err) => {
      firstCause ??= 'error';
      request.log.warn({ err, route: route.id }, 'websocket upstream error');
    });

    startHeartbeat(cfg.pingIntervalMs, accepted, upstream, timers, () => {
      firstCause ??= 'dead_peer';
      accepted.terminate();
      upstream.terminate();
    });

    if (cfg.idleTimeoutMs > 0) {
      const timer = setInterval(() => {
        if (Date.now() - lastActivity >= cfg.idleTimeoutMs) closeBoth(1001, 'Idle timeout', 'idle');
      }, Math.max(20, Math.floor(cfg.idleTimeoutMs / 4)));
      timer.unref();
      timers.push(timer);
    }
  });
}

/** Her iki tarafa periyodik ping; bir sonraki turda hâlâ pong dönmemişse taraf ölü sayılır. */
function startHeartbeat(
  intervalMs: number,
  client: WebSocket,
  upstream: WebSocket,
  timers: NodeJS.Timeout[],
  onDeadPeer: () => void,
): void {
  if (intervalMs <= 0) return;

  let clientAlive = true;
  let upstreamAlive = true;
  client.on('pong', () => {
    clientAlive = true;
  });
  upstream.on('pong', () => {
    upstreamAlive = true;
  });

  const timer = setInterval(() => {
    if (!clientAlive || !upstreamAlive) {
      onDeadPeer();
      return;
    }
    clientAlive = false;
    upstreamAlive = false;
    if (client.readyState === WebSocket.OPEN) client.ping();
    if (upstream.readyState === WebSocket.OPEN) upstream.ping();
  }, intervalMs);
  timer.unref();
  timers.push(timer);
}

interface MessageLimiter {
  readonly store: Store;
  readonly policy: Policy;
}

/** Bağlantı BAŞINA sayaç: bellekte tutulur — mesaj başına Redis turu maliyeti olmasın. */
function createMessageLimiter(config: NonNullable<NonNullable<RouteConfig['websocket']>['messageRateLimit']>): MessageLimiter {
  return {
    store: createMemoryStore(config.algorithm),
    policy: {
      limit: config.limit,
      windowMs: config.windowSec * 1000,
      ...(config.burst !== undefined ? { burst: config.burst } : {}),
    },
  };
}

function parseProtocols(header: string | string[] | undefined): string[] {
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (!raw) return [];
  return raw
    .split(',')
    .map((protocol) => protocol.trim())
    .filter((protocol) => protocol !== '');
}

/** Bir kapanış çerçevesinde *gönderilebilen* kodlar (RFC 6455 §7.4). 1005/1006/1015 asla tel üzerinde gitmez. */
function isSendableCloseCode(code: number): boolean {
  return (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) || (code >= 3000 && code <= 4999);
}

/** Bir tarafın kapanışını (kodu ve gerekçesiyle) diğerine iletir. */
function relayClose(peer: WebSocket, code: number, reason: Buffer): void {
  if (peer.readyState !== WebSocket.OPEN && peer.readyState !== WebSocket.CONNECTING) return;

  if (code === 1005) peer.close(); // "kod yoktu"
  else if (isSendableCloseCode(code)) peer.close(code, reason);
  else peer.terminate(); // 1006 (anormal) ve 1015 gibi — iletilecek bir çerçeve yok
}
