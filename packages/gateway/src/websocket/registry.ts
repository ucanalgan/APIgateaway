/** Açık bir WebSocket bağlantısı — registry sadece sayım ve toplu kapatma için bilir. */
export interface TrackedConnection {
  readonly routeId: string;
  /** Kapanış el sıkışması başlatır (1001 "Going Away"); tarafların yanıt vermesi beklenmez. */
  shutdown(): void;
  /** El sıkışmasız, hemen. */
  terminate(): void;
}

export interface WebSocketRegistry {
  add(connection: TrackedConnection): void;
  remove(connection: TrackedConnection): void;
  countFor(routeId: string): number;
  size(): number;
  /** Tüm bağlantılara kapanış gönderir, `graceMs` içinde kapanmayanları keser. */
  closeAll(graceMs: number): Promise<void>;
}

export function createWebSocketRegistry(): WebSocketRegistry {
  const connections = new Set<TrackedConnection>();

  return {
    add: (connection) => void connections.add(connection),
    remove: (connection) => void connections.delete(connection),
    countFor(routeId) {
      let n = 0;
      for (const connection of connections) if (connection.routeId === routeId) n++;
      return n;
    },
    size: () => connections.size,

    async closeAll(graceMs) {
      for (const connection of [...connections]) connection.shutdown();

      const deadline = Date.now() + graceMs;
      while (connections.size > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      for (const connection of [...connections]) connection.terminate();
    },
  };
}
