import { readFileSync, writeFileSync } from "node:fs";

/*
 * What this launch follows, for the studio's `app opened` and `update installed`
 * (docs/analytics.md): whether the app has ever started with this data folder, and the version
 * it last started as. Kept in `launches.json` in the data folder, which signing out leaves
 * alone; a folder that can't be written only means the next launch can't tell either.
 */

export interface Launch {
  /** No launch of this app on this computer before this one. */
  first: boolean;
  /** The version the last launch ran, when an update has been installed since. */
  updatedFrom: string | null;
}

interface Saved {
  version: string;
}

export function recordLaunch(
  file: string,
  version: string,
  io: {
    read: (path: string) => string;
    write: (path: string, text: string) => void;
  } = {
    read: (path) => readFileSync(path, "utf8"),
    write: (path, text) => writeFileSync(path, text),
  },
): Launch {
  let saved: Partial<Saved> | null = null;
  try {
    saved = JSON.parse(io.read(file)) as Partial<Saved>;
  } catch {}
  const last = typeof saved?.version === "string" ? saved.version : null;
  try {
    io.write(file, `${JSON.stringify({ version } satisfies Saved)}\n`);
  } catch {}
  return { first: saved === null, updatedFrom: last && last !== version ? last : null };
}
