import {
  createRealtimeClient,
  type RealtimeClient,
  type WebSocketFactory,
} from "@neon/realtime/client";

/*
 * The only module that knows Neon Realtime (docs/cloud.md, "Realtime"). Everything else talks
 * to `RealtimeTransport`, so a different push service can stand in for it here alone.
 */

/** A live query sealed by `POST /v1/live`: a bearer good for 60 seconds. Never log it. */
export interface Sealed {
  capability: string;
  queryFingerprint: string;
  expiresAt: number;
}

/**
 * `connecting`: syncing, at first or after a dropped socket. `stale`: the seal ran out and
 * the subscription waits for a renewal. `error`: final; subscribe again with a new seal.
 */
export type RealtimeStatus = "connecting" | "live" | "stale" | "error" | "closed";

export interface RealtimeListener {
  /** The whole current result, after every change: the transport applies the deltas. */
  rows(rows: readonly unknown[]): void;
  status(status: RealtimeStatus): void;
}

export interface RealtimeSubscription {
  /** A new seal for the same query. Rejects when it is refused; subscribe again then. */
  renew(sealed: Sealed): Promise<void>;
  close(): void;
}

export interface RealtimeTransport {
  subscribe(url: string, sealed: Sealed, listener: RealtimeListener): RealtimeSubscription;
  /** Close every subscription and socket. */
  close(): void;
}

/**
 * Neon Realtime: one client (one socket) per URL the API names, which reconnects by itself and
 * hands every subscription a full fresh result when it does. `webSocketFactory` is for runtimes
 * whose `WebSocket` needs options; browsers and React Native's global one work as they are.
 */
export function neonRealtime(
  opts: { webSocketFactory?: WebSocketFactory } = {},
): RealtimeTransport {
  const clients = new Map<string, RealtimeClient>();
  const clientFor = (url: string) => {
    let client = clients.get(url);
    if (!client) {
      client = createRealtimeClient({ url, webSocketFactory: opts.webSocketFactory });
      clients.set(url, client);
    }
    return client;
  };
  return {
    subscribe(url, sealed, listener) {
      const subscription = clientFor(url).subscribe<unknown>(sealed);
      let last: readonly unknown[] | undefined;
      const off = subscription.onChange(({ data, status }) => {
        if (data && data !== last) {
          last = data;
          listener.rows(data);
        }
        listener.status(status);
      });
      return {
        renew: (next) => subscription.renew(next),
        close() {
          off();
          subscription.unsubscribe();
        },
      };
    },
    close() {
      for (const client of clients.values()) client.close();
      clients.clear();
    },
  };
}
