import type { KeyValueStorage } from "@ponzu/client";
import { Directory, File, Paths } from "expo-file-system";

/*
 * A `KeyValueStorage` over files in the app's documents, for what is large and not secret: the
 * canvases `DocCache` keeps for offline (`Paths.document/cache/docs`). The Keychain is for the
 * session alone. Clearing a folder is part of signing out.
 */

/** A key as a file name: safe characters kept, the rest escaped, so two keys never share a file. */
export function fileNameOf(key: string): string {
  return `${key.replace(/[^A-Za-z0-9._-]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`)}.json`;
}

function folder(...path: string[]): Directory {
  const dir = new Directory(Paths.document, ...path);
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

export function fileStorage(...path: string[]): KeyValueStorage & { clear(): void } {
  const file = (key: string) => new File(folder(...path), fileNameOf(key));
  return {
    async get(key) {
      const f = file(key);
      return f.exists ? f.textSync() : null;
    },
    async set(key, value) {
      const f = file(key);
      if (!f.exists) f.create();
      f.write(value);
    },
    async delete(key) {
      const f = file(key);
      if (f.exists) f.delete();
    },
    clear() {
      const dir = new Directory(Paths.document, ...path);
      if (dir.exists) dir.delete();
    },
  };
}

/** Where `DocCache` keeps the last canvases opened. */
export const DOC_CACHE_PATH = ["cache", "docs"] as const;
