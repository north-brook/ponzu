import { applyCatalogPatch, type Catalog, type CatalogMessage } from "@ponzu/core";
import { readJson, writeJson } from "./cache";
import { type MacCatalog, mergeCatalogs, type PhoneFile } from "./files";
import { baseUrl, type Mac } from "./mac";
import { loadMacs, macs } from "./macs";
import { reach, reachOne } from "./reach";
import { baselineSeen } from "./seen";
import { Store, useStore } from "./store";
import { USER_AGENT } from "./ua";

/** Each Mac's catalog, live or from the cache, by Mac id. */
export const catalogs = new Store<Record<string, MacCatalog>>({});
/** Macs whose catalog socket is open now. */
export const live = new Store<Record<string, boolean>>({});

interface Feed {
  socket: WebSocket;
  closed: boolean;
  retry: number;
}
const feeds = new Map<string, Feed>();

function setCatalog(mac: Mac, catalog: Catalog) {
  catalogs.set((all) => ({ ...all, [mac.id]: { catalog, at: Date.now() } }));
  baselineSeen(mac.id, catalog.files);
  saveSoon(mac);
}

const saving = new Map<string, ReturnType<typeof setTimeout>>();
/** Writes a Mac's catalog to the cache, at most every couple of seconds. */
function saveSoon(mac: Mac) {
  if (saving.has(mac.id)) return;
  saving.set(
    mac.id,
    setTimeout(() => {
      saving.delete(mac.id);
      const c = catalogs.get()[mac.id];
      if (c) writeJson(mac.id, "catalog", c);
    }, 2_000),
  );
}

/** The cached catalogs, so Designs has something to show before any Mac answers. */
export async function loadCachedCatalogs() {
  await loadMacs();
  const next: Record<string, MacCatalog> = {};
  for (const mac of macs.get()) {
    const c = readJson<MacCatalog>(mac.id, "catalog");
    if (c?.catalog?.files) next[mac.id] = c;
  }
  catalogs.set((all) => ({ ...next, ...all }));
}

/** Opens `mac`'s catalog stream if it isn't open: a snapshot, then a patch per change. */
function open(mac: Mac) {
  const existing = feeds.get(mac.id);
  if (existing && !existing.closed) return;
  const url = `${baseUrl(mac).replace(/^http/, "ws")}/api/catalog/stream`;
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
    if (msg.t === "snapshot") setCatalog(mac, msg.catalog);
    else if (msg.t === "patch") {
      const prev = catalogs.get()[mac.id]?.catalog ?? { machines: [], files: [], agents: [] };
      setCatalog(mac, applyCatalogPatch(prev, msg.patch));
    }
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
  syncFeeds();
}

reach.subscribe(syncFeeds);

/** Every design on every Mac, newest edit first. */
export function useFiles(): PhoneFile[] {
  const saved = useStore(macs);
  const all = useStore(catalogs);
  const on = useStore(live);
  return useMemoFiles(saved, all, on);
}

let memo: { key: unknown[]; files: PhoneFile[] } | null = null;
function useMemoFiles(
  saved: Mac[],
  all: Record<string, MacCatalog>,
  on: Record<string, boolean>,
): PhoneFile[] {
  if (memo && memo.key[0] === saved && memo.key[1] === all && memo.key[2] === on) return memo.files;
  const files = mergeCatalogs(
    saved.map((m) => ({ id: m.id, name: m.name, kind: m.kind, base: baseUrl(m) })),
    all,
    (id) => Boolean(on[id]),
  );
  memo = { key: [saved, all, on], files };
  return files;
}

export function findFile(mac: string, key: string): PhoneFile | undefined {
  return memo?.files.find((f) => f.mac === mac && f.key === key);
}
