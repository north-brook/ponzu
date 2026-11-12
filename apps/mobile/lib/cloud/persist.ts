import type { QueryKey } from "@tanstack/react-query";

/*
 * What of the person's cached answers goes to disk, so the app opens offline onto the last list
 * (docs/mobile.md, "Offline"). An allow-list: anything a later slice adds stays in memory until
 * it is named here. Never a thread page or a question: live queries cover those, and an old
 * question on disk could be answered after it closed.
 */

/** How long a kept answer is good for. */
export const PERSIST_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
export const PERSIST_KEY = "ponzu.queries";

/** The phone's own keys beside `queryKeys`: a workspace's canvases, for the list's first paint. */
export const phoneKeys = {
  canvases: (workspaceId: string) => ["ponzu", "workspace", workspaceId, "canvases"] as const,
  /** `GET /v1/canvases/:id`: the canvas's view, for its preview and assets origin. */
  canvasView: (canvasId: string) => ["ponzu", "canvas", canvasId, "view"] as const,
};

const exact = (key: QueryKey, ...parts: (string | null)[]) =>
  key.length === parts.length && parts.every((part, i) => part === null || key[i] === part);

/** Whether the answer under `key` may be written to disk. `null` matches any one id. */
export function persistable(key: QueryKey): boolean {
  if (key[0] !== "ponzu") return false;
  return (
    exact(key, "ponzu", "me") ||
    exact(key, "ponzu", "workspace", null) ||
    exact(key, "ponzu", "workspace", null, "canvases") ||
    exact(key, "ponzu", "canvas", null, "view") ||
    exact(key, "ponzu", "canvas", null, "pull-request") ||
    exact(key, "ponzu", "claude", "defaults") ||
    exact(key, "ponzu", "usage", null) ||
    exact(key, "ponzu", "notifications")
  );
}

/** A new app version or another person starts from nothing. */
export const buster = (version: string, userId: string) => `${version}:${userId}`;

/** The little of AsyncStorage the persister uses. */
export interface PersistStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/**
 * `storage` for one person's persister, which can be shut. The persister is throttled: a save
 * asked for in the two seconds before signing out runs after the copy on disk is removed, and
 * would write the person's answers back. Once shut, every save is dropped; reads and the
 * removal still go through.
 */
export function closableStorage(storage: PersistStorage): {
  storage: PersistStorage;
  close(): void;
} {
  let closed = false;
  return {
    storage: {
      getItem: (key) => storage.getItem(key),
      setItem: (key, value) => (closed ? Promise.resolve() : storage.setItem(key, value)),
      removeItem: (key) => storage.removeItem(key),
    },
    close() {
      closed = true;
    },
  };
}
