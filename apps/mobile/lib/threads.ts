import type { Doc, ServerMessage } from "@ponzu/core";
import { readJson, writeJson } from "./cache";
import type { PhoneFile } from "./files";
import { Store, useStore } from "./store";
import { USER_AGENT } from "./ua";

/**
 * The comment threads and artboard names of designs the person comments in,
 * for Activity: kept from every design opened on the phone, and refreshed
 * for those designs when Activity opens. A refresh opens the design's socket
 * as a watcher (`watch=1`: read-only, not counted as an open canvas), takes
 * the hello and closes.
 */
export type ThreadDoc = Pick<Doc, "threads" | "pages">;

/** By `<mac>:<key>`. */
export const threadDocs = new Store<Record<string, ThreadDoc>>({});
let loaded = false;

const keyOf = (mac: string, key: string) => `${mac}:${key}`;

function slim(doc: Doc): ThreadDoc {
  return {
    threads: doc.threads,
    // Names only: Activity labels boards, it doesn't draw them.
    pages: doc.pages.map((p) => ({
      ...p,
      artboards: p.artboards.map((a) => ({ ...a, children: [] })),
    })),
  };
}

export function loadThreadDocs(macs: string[]) {
  if (loaded) return;
  loaded = true;
  const next: Record<string, ThreadDoc> = {};
  for (const mac of macs) Object.assign(next, readJson<Record<string, ThreadDoc>>(mac, "threads"));
  threadDocs.set((all) => ({ ...next, ...all }));
}

function save(mac: string) {
  const mine: Record<string, ThreadDoc> = {};
  for (const [k, v] of Object.entries(threadDocs.get())) if (k.startsWith(`${mac}:`)) mine[k] = v;
  writeJson(mac, "threads", mine);
}

/** The open design's doc, whenever it changes. */
export function keepThreads(mac: string, key: string, doc: Doc) {
  threadDocs.set((all) => ({ ...all, [keyOf(mac, key)]: slim(doc) }));
  save(mac);
}

/** Fetches the threads of `file` from its Mac once. */
export function refreshThreads(file: PhoneFile, base: string): Promise<void> {
  return new Promise((resolve) => {
    const url = `${base.replace(/^http/, "ws")}/ws?file=${encodeURIComponent(file.key)}&watch=1`;
    const socket = new (
      WebSocket as unknown as new (
        url: string,
        protocols: string[] | null,
        options: { headers: Record<string, string> },
      ) => WebSocket
    )(url, null, { headers: { "User-Agent": USER_AGENT } });
    const done = () => {
      clearTimeout(timer);
      socket.close();
      resolve();
    };
    const timer = setTimeout(done, 6_000);
    socket.onmessage = (e) => {
      try {
        const msg = JSON.parse(String(e.data)) as ServerMessage;
        if (msg.t === "hello") {
          keepThreads(file.mac, file.key, msg.doc);
          done();
        }
      } catch {
        done();
      }
    };
    socket.onerror = done;
  });
}

export function useThreadDocs() {
  return useStore(threadDocs);
}
