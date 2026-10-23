import {
  applyCatalogPatch,
  type Catalog,
  type CatalogMessage,
  type CatalogShelf,
} from "@ponzu/core";
import type { MutationOptions, Query, QueryClient } from "@tanstack/react-query";

/**
 * What the phone asks each Mac for, as React Query keys, and the cache
 * writes the live feeds and shelf changes make. Pure, so tests run with a
 * QueryClient and no React Native.
 *
 * - `["mac", id, "info"]`: `/api/info`. Persisted.
 * - `["mac", id, "macs"]`: `/api/macs`, the other Macs it knows.
 * - `["mac", id, "catalog"]`: its designs. Persisted, so launch shows the
 *   last list at once and an asleep Mac keeps its cards. The catalog socket
 *   writes its snapshot and patches here; there is no other copy.
 */
export const keys = {
  mac: (id: string) => ["mac", id] as const,
  info: (id: string) => ["mac", id, "info"] as const,
  macs: (id: string) => ["mac", id, "macs"] as const,
  catalog: (id: string) => ["mac", id, "catalog"] as const,
};

/** How long a persisted cache is worth showing. Queries live at least as long. */
export const PERSIST_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

/** Only each Mac's info and catalog go to disk, once they've read. */
export function persistable(query: Pick<Query, "queryKey" | "state">): boolean {
  const [scope, , what] = query.queryKey;
  return (
    scope === "mac" && (what === "info" || what === "catalog") && query.state.status === "success"
  );
}

/** A catalog after one message from `/api/catalog/stream`. A patch before any snapshot starts from empty. */
export function applyCatalogMessage(
  prev: Catalog | undefined,
  msg: CatalogMessage,
): Catalog | undefined {
  if (msg.t === "snapshot") return msg.catalog;
  if (msg.t === "patch")
    return applyCatalogPatch(prev ?? { machines: [], files: [], agents: [] }, msg.patch);
  return prev;
}

/** Writes a stream message into `mac`'s catalog query. Returns the catalog as it now stands. */
export function writeCatalogMessage(
  client: QueryClient,
  mac: string,
  msg: CatalogMessage,
): Catalog | undefined {
  if (msg.t === "ping") return client.getQueryData<Catalog>(keys.catalog(mac));
  return client.setQueryData<Catalog>(keys.catalog(mac), (prev) => applyCatalogMessage(prev, msg));
}

export type ShelfAction = "archive" | "restore" | "scratch" | "recent";

/** The shelf a design lands on, as desktop shows it before the stream confirms. */
export function shelfAfter(action: ShelfAction): CatalogShelf {
  return action === "archive" ? "archived" : action === "scratch" ? "scratch" : "recent";
}

/** `catalog` with design `key` on `shelf` (missing means Recent). */
export function withShelf(catalog: Catalog, key: string, shelf: CatalogShelf | undefined): Catalog {
  return {
    ...catalog,
    files: catalog.files.map((f) => {
      if (f.key !== key) return f;
      const { shelf: _old, ...rest } = f;
      return shelf ? { ...rest, shelf } : rest;
    }),
  };
}

export interface ShelfChange {
  /** The saved Mac's id. */
  mac: string;
  key: string;
  action: ShelfAction;
}

/**
 * Archive, restore, or move a design between Recent and Scratch
 * (`POST /api/shelf`): the card moves at once; if the Mac says no, it goes
 * back to the shelf it was on. Only that design's shelf goes back, so a patch
 * from the stream in the meantime stands. The stream confirms either way.
 */
export function shelfMutation(
  client: QueryClient,
  post: (change: ShelfChange) => Promise<unknown>,
): MutationOptions<unknown, Error, ShelfChange, { was: CatalogShelf | undefined } | undefined> {
  return {
    mutationFn: post,
    onMutate: async ({ mac, key, action }) => {
      const key_ = keys.catalog(mac);
      await client.cancelQueries({ queryKey: key_ });
      const state = client.getQueryState<Catalog>(key_);
      const file = state?.data?.files.find((f) => f.key === key);
      if (!state?.data || !file) return undefined;
      // Keep when it last came from the Mac: "as they were at …" reads it.
      client.setQueryData<Catalog>(key_, withShelf(state.data, key, shelfAfter(action)), {
        updatedAt: state.dataUpdatedAt,
      });
      return { was: file.shelf };
    },
    onError: (_err, { mac, key }, context) => {
      if (!context) return;
      const key_ = keys.catalog(mac);
      const state = client.getQueryState<Catalog>(key_);
      if (state?.data)
        client.setQueryData<Catalog>(key_, withShelf(state.data, key, context.was), {
          updatedAt: state.dataUpdatedAt,
        });
    },
  };
}
