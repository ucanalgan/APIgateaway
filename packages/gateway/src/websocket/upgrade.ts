import { ServerResponse, type IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { FastifyInstance } from 'fastify';

export interface PendingUpgrade {
  readonly socket: Duplex;
  readonly head: Buffer;
  /** WebSocket proxy soketi devraldıysa true — ondan sonra normal bir yanıt artık mümkün değil. */
  taken: boolean;
}

const pending = new WeakMap<IncomingMessage, PendingUpgrade>();

/** Bu istek bir `upgrade` olayından mı geldi? (Fastify'ın handler'ı içinden `request.raw` ile sorulur.) */
export function pendingUpgrade(req: IncomingMessage): PendingUpgrade | undefined {
  return pending.get(req);
}

export function isWebSocketHandshake(req: IncomingMessage): boolean {
  const upgrade = req.headers.upgrade;
  const connection = req.headers.connection;

  return (
    typeof upgrade === 'string' &&
    upgrade.toLowerCase() === 'websocket' &&
    typeof connection === 'string' &&
    connection
      .toLowerCase()
      .split(',')
      .some((token) => token.trim() === 'upgrade')
  );
}

/**
 * RFC 6455 §4.2.1 — upstream'e bağlanmadan önce yakalanabilecek bozuk el
 * sıkışmalar. `ws` de bunları reddeder ama o noktada upstream bağlantısı
 * çoktan açılmış olurdu. Sorun yoksa `undefined`.
 */
export function handshakeProblem(req: IncomingMessage): string | undefined {
  if (req.method !== 'GET') return 'WebSocket handshake must be a GET request.';
  if (req.headers['sec-websocket-version'] !== '13') return 'Unsupported Sec-WebSocket-Version — only 13 is supported.';

  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || !/^[+/0-9A-Za-z]{22}==$/.test(key)) return 'Missing or invalid Sec-WebSocket-Key.';

  return undefined;
}

/**
 * Node, `Upgrade` isteklerini `'request'` olarak değil `'upgrade'` olarak yayar
 * — yani Fastify'ın pipeline'ı (route eşleşmesi, auth, rate limit, hook'lar)
 * normalde hiç çalışmazdı. İsteği sahte bir `ServerResponse` ile Fastify'ın
 * router'ına veriyoruz; böylece el sıkışma, sıradan bir istekle aynı katmanlardan
 * geçer. Reddedilirse normal bir HTTP yanıtı yazılır (ve soket kapatılır);
 * kabul edilirse handler yanıtı `hijack` edip soketi WebSocket'e devreder.
 */
export function attachUpgradeListener(app: FastifyInstance): void {
  app.server.on('upgrade', (req, socket, head) => {
    const state: PendingUpgrade = { socket, head, taken: false };
    pending.set(req, state);

    // Soketin sahibi henüz kimse değilken (ör. istemci el sıkışmanın ortasında
    // bağlantıyı koparırsa) 'error' dinleyicisiz kalıp süreci düşürmesin.
    socket.on('error', () => {});

    const res = new ServerResponse(req);
    res.assignSocket(socket as Socket);
    res.shouldKeepAlive = false;
    res.on('finish', () => {
      if (!state.taken) socket.end();
    });

    app.routing(req, res);
  });
}
