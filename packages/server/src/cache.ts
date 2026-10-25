import { readdir, rm, stat, utimes } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/*
 * Ponzu's disk cache, outside every design: ~/.ponzu/cache, one folder per
 * kind (renditions/, pictures/, loops/, remote/). Files are named by a hash of
 * what they're made from, and each folder is trimmed to its own budget, least
 * recently used first. A cached item may be several files (data and its
 * metadata): they share a name up to the first "-" or ".", and are kept or
 * dropped together.
 */

export function defaultCacheDir(): string {
  return join(process.env.PONZU_HOME ?? join(homedir(), ".ponzu"), "cache");
}

/** Mark files used, at most once an hour each: modification time is the LRU clock. */
export async function touch(...paths: string[]) {
  await Promise.all(
    paths.map(async (p) => {
      const s = await stat(p).catch(() => null);
      if (s && Date.now() - s.mtimeMs > 3_600_000) {
        const now = new Date();
        await utimes(p, now, now).catch(() => {});
      }
    }),
  );
}

/** The item a cache file belongs to: its name up to the first "-" or ".". */
export function unitOf(name: string): string {
  return /^[^-.]+/.exec(name)?.[0] ?? name;
}

/**
 * Delete the least recently used items in `dir` until it's under 80% of `max`
 * bytes. An item's files go together, and it counts as used when any of them was.
 */
export async function trim(dir: string, max: number): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const units = new Map<string, { files: string[]; size: number; at: number }>();
  await Promise.all(
    names.map(async (n) => {
      const p = join(dir, n);
      const s = await stat(p).catch(() => null);
      if (!s?.isFile()) return;
      const id = unitOf(n);
      const u = units.get(id) ?? { files: [], size: 0, at: 0 };
      u.files.push(p);
      u.size += s.size;
      u.at = Math.max(u.at, s.mtimeMs);
      units.set(id, u);
    }),
  );
  let total = 0;
  for (const u of units.values()) total += u.size;
  if (total <= max) return;
  const order = [...units.values()].sort((a, b) => a.at - b.at);
  for (const u of order) {
    if (total <= max * 0.8) break;
    await Promise.all(u.files.map((f) => rm(f, { force: true })));
    total -= u.size;
  }
}

let started = false;

/**
 * Trim each of the cache's folders once, a few seconds after the server starts:
 * otherwise a cache that grew past its budget last time is only trimmed once
 * this run has written enough to look.
 */
export function trimAtStart(dirs: { dir: string; max: number }[], delayMs = 5000) {
  if (started) return;
  started = true;
  const t = setTimeout(() => {
    void (async () => {
      for (const d of dirs) await trim(d.dir, d.max).catch(() => {});
    })();
  }, delayMs);
  t.unref?.();
}
