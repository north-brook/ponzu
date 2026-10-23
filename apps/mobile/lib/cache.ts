import { Directory, File, Paths } from "expo-file-system";
import { USER_AGENT } from "./ua";

/**
 * The phone's cache of each Mac's last catalog and each design's preview
 * images, in `Documents/cache/<mac>/`, so Designs opens at once and a Mac
 * that's asleep still shows what it had. Previews are kept within about 10 MB
 * across Macs, least recently used out first. The canvas always needs the Mac.
 */
const BUDGET = 10 * 1024 * 1024;

function root(): Directory {
  const dir = new Directory(Paths.document, "cache");
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

function macDir(mac: string): Directory {
  const dir = new Directory(root(), safe(mac));
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

function safe(name: string): string {
  return name.replace(/[^\w.-]+/g, "_").slice(-120);
}

export function readJson<T>(mac: string, name: string): T | null {
  try {
    const f = new File(macDir(mac), `${name}.json`);
    return f.exists ? (JSON.parse(f.textSync()) as T) : null;
  } catch {
    return null;
  }
}

export function writeJson(mac: string, name: string, value: unknown) {
  try {
    new File(macDir(mac), `${name}.json`).write(JSON.stringify(value));
  } catch {
    // A full disk only costs the offline view.
  }
}

/** A short, stable file name for a URL. */
function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

const inflight = new Map<string, Promise<string | null>>();

/** The cached copy of `url` on `mac`, or null. Touches it, for the LRU. */
export function cachedImage(mac: string, url: string): string | null {
  try {
    const f = new File(macDir(mac), "img", `${hash(url)}.png`);
    return f.exists ? f.uri : null;
  } catch {
    return null;
  }
}

/** Downloads `url` into `mac`'s cache; resolves with the file's uri. */
export function cacheImage(mac: string, url: string): Promise<string | null> {
  const key = `${mac}\0${url}`;
  const running = inflight.get(key);
  if (running) return running;
  const job = (async () => {
    try {
      const dir = new Directory(macDir(mac), "img");
      if (!dir.exists) dir.create({ intermediates: true });
      const dest = new File(dir, `${hash(url)}.png`);
      if (dest.exists) return dest.uri;
      const file = await File.downloadFileAsync(url, dest, {
        headers: { "User-Agent": USER_AGENT },
        idempotent: true,
      });
      trim();
      return file.uri;
    } catch {
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, job);
  return job;
}

let trimming = false;

/** Keeps the image cache within budget, oldest files out first. */
function trim() {
  if (trimming) return;
  trimming = true;
  setTimeout(() => {
    try {
      const files: { file: File; size: number; at: number }[] = [];
      for (const dir of root().list()) {
        if (!(dir instanceof Directory)) continue;
        const img = new Directory(dir, "img");
        if (!img.exists) continue;
        for (const f of img.list()) {
          if (!(f instanceof File)) continue;
          const info = f.info();
          files.push({ file: f, size: info.size ?? 0, at: info.modificationTime ?? 0 });
        }
      }
      let total = files.reduce((n, f) => n + f.size, 0);
      files.sort((a, b) => a.at - b.at);
      for (const f of files) {
        if (total <= BUDGET) break;
        f.file.delete();
        total -= f.size;
      }
    } catch {
      // Next time.
    } finally {
      trimming = false;
    }
  }, 2_000);
}
