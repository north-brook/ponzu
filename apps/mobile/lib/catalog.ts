import type { Catalog, CatalogMessage } from "@ponzu/core";
import { useMutation, useQueries } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { type MacCatalog, mergeCatalogs, type PhoneFile } from "./files";
import { getJson, request } from "./http";
import { baseUrl, type Mac } from "./mac";
import {
  agentEdited,
  keys,
  type ShelfChange,
  shelfMutation,
  writeCatalogMessage,
} from "./mac-queries";
import { findMac, macs } from "./macs";
import { queryClient } from "./query";
import { reach, reachOne } from "./reach";
import { baselineSeen } from "./seen";
import { Store, useStore } from "./store";
import { USER_AGENT } from "./ua";

/**
 * Each Mac's designs. The catalog query (`keys.catalog`) is the one copy,
 * kept on disk by the query cache: Designs shows it the moment the app
 * opens, and a Mac that's asleep keeps its cards, dimmed. While a Mac
 * answers, its catalog socket keeps the query current, a snapshot and then
 * a patch per change. The phone asks each Mac for its own designs only
 * (`scope=local`), since it asks every Mac itself.
 */

/** Macs whose catalog socket is open now: their cards are live. */
export const live = new Store<Record<string, boolean>>({});

/** `GET /api/catalog`: what the Mac has now, when there's no socket to say. */
export function fetchCatalog(mac: Pick<Mac, "dns" | "address">): Promise<Catalog> {
  return getJson<Catalog>(`${baseUrl(mac)}/api/catalog?scope=local`, 8_000);
}

interface Feed {
  socket: WebSocket;
  closed: boolean;
  retry: number;
}
const feeds = new Map<string, Feed>();

/** Told when an agent changed a design on a Mac (activity-store.ts asks it what). */
let onAgentEdit: (mac: string) => void = () => {};
export function whenAgentEdits(fn: (mac: string) => void) {
  onAgentEdit = fn;
}

function onMessage(mac: Mac, msg: CatalogMessage) {
  if (agentEdited(queryClient.getQueryData<Catalog>(keys.catalog(mac.id)), msg))
    onAgentEdit(mac.id);
  const catalog = writeCatalogMessage(queryClient, mac.id, msg);
  if (catalog && msg.t !== "ping") baselineSeen(mac.id, catalog.files);
}

/** Opens `mac`'s catalog stream if it isn't open: a snapshot, then a patch per change. */
function open(mac: Mac) {
  const existing = feeds.get(mac.id);
  if (existing && !existing.closed) return;
  const url = `${baseUrl(mac).replace(/^http/, "ws")}/api/catalog/stream?scope=local`;
  // React Native's WebSocket takes headers as a third argument.
  const socket = new (
    WebSocket as unknown as new (
      url: string,
      protocols: string[] | null,
      options: { headers: Record<string, string> },
    ) => WebSocket
  )(url, null, { headers: { "User-Agent": USER_AGENT } });
  const feed: Feed = { socket, closed: false, retry: existing?.retry ?? 0 };
  feeds.set(mac.id, feed);
  socket.onopen = () => {
    feed.retry = 0;
    live.set((all) => ({ ...all, [mac.id]: true }));
  };
  socket.onmessage = (e) => {
    let msg: CatalogMessage;
    try {
      msg = JSON.parse(String(e.data));
    } catch {
      return;
    }
    onMessage(mac, msg);
  };
  socket.onclose = () => {
    if (feed.closed) return;
    feed.closed = true;
    live.set((all) => ({ ...all, [mac.id]: false }));
    if (stopped) return;
    // Back while the Mac answers; after a few misses, ask it where it stands.
    const delay = Math.min(8_000, 500 * 2 ** feed.retry++);
    setTimeout(async () => {
      // Stopped, forgotten, or tried long enough: the next reach pass opens it again.
      if (stopped || !macs.get().some((m) => m.id === mac.id) || feed.retry > 8) return;
      if (feed.retry > 3 && (await reachOne(mac)) !== "answer") return;
      if (reach.get()[mac.id] === "answer") open(mac);
    }, delay);
  };
}

let stopped = false;

/**
 * Keeps a catalog socket open to every Mac that answers. Called whenever
 * reach changes; Macs that stop answering keep their cached catalog, dimmed.
 */
export function syncFeeds() {
  stopped = false;
  const r = reach.get();
  for (const mac of macs.get()) if (r[mac.id] === "answer") open(mac);
}

/** Closes every catalog socket and opens them again (pull to refresh). */
export function refreshFeeds() {
  for (const [id, feed] of feeds) {
    feed.closed = true;
    feed.socket.close();
    feeds.delete(id);
  }
  live.set({});
  syncFeeds();
}

reach.subscribe(syncFeeds);

/** Each saved Mac's catalog as the cache holds it, with when it last came from the Mac. */
export function useCatalogs(): Record<string, MacCatalog> {
  const saved = useStore(macs);
  const combine = useCallback(
    (results: { data?: Catalog; dataUpdatedAt: number }[]) => {
      const all: Record<string, MacCatalog> = {};
      results.forEach((q, i) => {
        if (q.data?.files) all[saved[i]!.id] = { catalog: q.data, at: q.dataUpdatedAt };
      });
      return all;
    },
    [saved],
  );
  return useQueries({
    queries: saved.map((m) => ({
      queryKey: keys.catalog(m.id),
      queryFn: () => fetchCatalog(m),
      // The socket keeps it current; nothing here asks the Mac.
      enabled: false,
    })),
    combine,
  });
}

/** Every design on every Mac, newest edit first. */
export function useFiles(): PhoneFile[] {
  const saved = useStore(macs);
  const all = useCatalogs();
  const on = useStore(live);
  return useMemo(
    () =>
      mergeCatalogs(
        saved.map((m) => ({ id: m.id, name: m.name, kind: m.kind, base: baseUrl(m) })),
        all,
        (id) => Boolean(on[id]),
      ),
    [saved, all, on],
  );
}

/** One design, as Designs shows it. */
export function useFile(mac: string, key: string): PhoneFile | undefined {
  const files = useFiles();
  return useMemo(() => files.find((f) => f.mac === mac && f.key === key), [files, mac, key]);
}

/** Archive or restore a design, on its Mac. */
export function useShelve() {
  return useMutation(
    shelfMutation(queryClient, async ({ mac, key, action }: ShelfChange) => {
      const m = findMac(mac);
      if (!m) throw new Error("This Mac isn't paired anymore.");
      await request(`${baseUrl(m)}/api/shelf`, {
        method: "POST",
        body: { key, action },
        timeout: 6_000,
      });
    }),
  );
}
