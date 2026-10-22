import { applyCatalogPatch, type Catalog, type CatalogMessage } from "@ponzu/core";

type SetCatalog = (update: (c: Catalog | null) => Catalog | null) => void;

/**
 * Keep the home screen's catalog current from the server's stream: a snapshot,
 * then each change, on this Mac and the person's other Macs. Patches apply to
 * what's showing, so a change the studio made itself (archiving, say) stays
 * until the server's own word on it arrives. Reconnects, backing off, and
 * fetches the catalog once while the stream can't open. Returns the stop.
 */
export function watchCatalog(origin: string, set: SetCatalog): () => void {
  let socket: WebSocket | null = null;
  /** Counts the stream's snapshots: a fallback answer that a snapshot overtook is out of date. */
  let snapshots = 0;
  let retry = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const url = `${origin.replace(/^http/, "ws")}/api/catalog/stream`;

  const connect = () => {
    let opened = false;
    const s = new WebSocket(url);
    socket = s;
    s.onopen = () => {
      opened = true;
      retry = 0;
    };
    s.onmessage = (e) => {
      let msg: CatalogMessage;
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (msg.t === "snapshot") {
        snapshots++;
        set(() => msg.catalog);
      } else if (msg.t === "patch") set((c) => c && applyCatalogPatch(c, msg.patch));
    };
    s.onclose = () => {
      if (stopped) return;
      // Something to show while the stream is down. Not once a snapshot came while it was on
      // its way: that's newer, and the patches after it build on it.
      if (!opened) {
        const asked = snapshots;
        void fetch(`${origin}/api/catalog`)
          .then((r) => (r.ok ? (r.json() as Promise<Catalog>) : null))
          .then((c) => !stopped && c && snapshots === asked && set(() => c))
          .catch(() => {});
      }
      timer = setTimeout(connect, Math.min(5000, 250 * 2 ** retry++));
    };
  };
  connect();
  return () => {
    stopped = true;
    clearTimeout(timer);
    socket?.close();
  };
}
