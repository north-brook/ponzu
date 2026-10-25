import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { defaultCacheDir, touch, trim } from "./cache.ts";

/**
 * Remote images a design links to, kept on disk so the canvas can show
 * smaller copies of them (see Renditions) and still show them offline.
 *
 * Only the canvas comes through here, and only for images. Ponzu's server
 * fetches the image instead of the canvas: the same Mac and network, but
 * without the canvas's cookies or referrer. Screenshots, exports and agents'
 * tools still load remote images themselves.
 *
 * What it fetches is anyone's URL, so it's careful: public addresses only
 * (never this Mac, the LAN or a cloud metadata service, checked again at every
 * redirect, and connected to by the address checked, so a name that resolves
 * differently the second time can't steer it), a few at a time, a size limit
 * enforced while reading, and only raster images, by their bytes rather than
 * what the other server says. An SVG served from Ponzu's own origin could run
 * script there.
 */

/** Refetch an image this old in the background, still answering with what's kept. */
const FRESH_MS = 24 * 3_600_000;
export const MAX_BYTES = 64 * 1024 ** 2;
/** Fetches at once. */
const PARALLEL = 4;
const MAX_REDIRECTS = 3;

export type RasterType = "image/jpeg" | "image/png" | "image/gif" | "image/webp" | "image/avif";

export interface Fetched {
  path: string;
  type: RasterType;
}

interface Kept {
  type: RasterType;
  at: number;
  etag?: string;
  modified?: string;
}

/** Resolves a host name to its addresses. */
export type Resolver = (host: string) => Promise<string[]>;

const resolveHost: Resolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

export interface RemoteImagesOptions {
  maxBytes?: number;
  fetcher?: typeof fetch;
  resolver?: Resolver;
}

export class RemoteImages {
  readonly dir: string;
  /** The folder's budget on disk. */
  readonly maxBytes: number;
  private fetcher: typeof fetch;
  private resolver: Resolver;
  private pending = new Map<string, Promise<Fetched | null>>();
  private written = 0;
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(dir = defaultCacheDir(), opts: RemoteImagesOptions = {}) {
    this.dir = join(dir, "remote");
    this.maxBytes = opts.maxBytes ?? 1024 ** 3;
    this.fetcher = opts.fetcher ?? fetch;
    this.resolver = opts.resolver ?? resolveHost;
  }

  /** The image at `url` on disk, fetched now if it isn't yet; null when it can't be had. */
  async get(url: string): Promise<Fetched | null> {
    if (!/^https?:\/\//i.test(url)) return null;
    const id = createHash("sha1").update(url).digest("hex").slice(0, 24);
    const path = join(this.dir, id);
    const kept = await readKept(path);
    if (kept) {
      void touch(path, `${path}.json`);
      if (Date.now() - kept.at > FRESH_MS) void this.load(url, path, kept);
      return { path, type: kept.type };
    }
    return this.load(url, path);
  }

  private load(url: string, path: string, kept?: Kept): Promise<Fetched | null> {
    let job = this.pending.get(path);
    if (!job) {
      job = this.slot(() => this.fetch(url, path, kept))
        .catch(() => null)
        .finally(() => this.pending.delete(path));
      this.pending.set(path, job);
    }
    return job;
  }

  private async slot<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= PARALLEL) await new Promise<void>((r) => this.waiting.push(r));
    else this.active++;
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }

  private async fetch(url: string, path: string, kept?: Kept): Promise<Fetched | null> {
    const headers: Record<string, string> = { accept: "image/avif,image/webp,image/*" };
    if (kept?.etag) headers["if-none-match"] = kept.etag;
    if (kept?.modified) headers["if-modified-since"] = kept.modified;
    const signal = AbortSignal.timeout(20_000);
    let res: Response | null = null;
    let at = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const pinned = await this.pin(at);
      if (!pinned) return null;
      res = await this.fetcher(pinned.url, {
        headers: { ...headers, ...(pinned.host ? { host: pinned.host } : {}) },
        redirect: "manual",
        signal,
        ...(pinned.host ? { tls: { serverName: pinned.host.replace(/:\d+$/, "") } } : {}),
      } as RequestInit);
      const to = res.headers.get("location");
      if (res.status < 300 || res.status >= 400 || res.status === 304 || !to) break;
      await res.body?.cancel().catch(() => {});
      at = new URL(to, at).href;
      res = null;
    }
    if (!res) return null;
    if (res.status === 304 && kept) {
      await writeFile(`${path}.json`, JSON.stringify({ ...kept, at: Date.now() }));
      return { path, type: kept.type };
    }
    if (!res.ok) return null;
    if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) return null;
    const bytes = await readCapped(res, MAX_BYTES);
    if (!bytes) return null;
    const type = rasterType(bytes);
    if (!type) return null;
    await mkdir(this.dir, { recursive: true });
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, path);
    const meta: Kept = { type, at: Date.now() };
    const etag = res.headers.get("etag");
    const modified = res.headers.get("last-modified");
    if (etag) meta.etag = etag;
    if (modified) meta.modified = modified;
    await writeFile(`${path}.json`, JSON.stringify(meta));
    this.written += bytes.length;
    if (this.written > 64 * 1024 ** 2) {
      this.written = 0;
      void trim(this.dir, this.maxBytes);
    }
    return { path, type };
  }

  /**
   * An http(s) URL whose host resolves only to public addresses, as the URL to
   * connect to: its host swapped for the address checked, with the name it had
   * (`host`) to send as the Host header and TLS server name. Null when it isn't.
   */
  private async pin(url: string): Promise<{ url: string; host?: string } | null> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host)) return isPublicAddress(host) ? { url } : null;
    const addresses = await this.resolver(host).catch(() => []);
    if (!addresses.length || !addresses.every(isPublicAddress)) return null;
    const name = u.host;
    const ip = addresses[0]!;
    u.hostname = isIP(ip) === 6 ? `[${ip}]` : ip;
    return { url: u.href, host: name };
  }
}

/** The body, or null when it's more than `max` bytes: reading stops there. */
export async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** What raster image the bytes are, by their signature; null for anything else (SVG, HTML). */
export function rasterType(b: Uint8Array): RasterType | null {
  const ascii = (o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && ascii(1, 7) === "PNG\r\n\x1a\n") return "image/png";
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
  if (ascii(4, 4) === "ftyp") {
    const box = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0);
    const brands = [ascii(8, 4)];
    for (let o = 16; o + 4 <= Math.min(box, b.length); o += 4) brands.push(ascii(o, 4));
    if (brands.includes("avif") || brands.includes("avis")) return "image/avif";
  }
  return null;
}

/**
 * Whether an address is on the public internet: not this machine, a private
 * or shared network, link-local (cloud metadata services live there),
 * multicast or reserved.
 */
export function isPublicAddress(address: string): boolean {
  const a = address.toLowerCase();
  if (isIP(a) === 4) return isPublicV4(a);
  if (isIP(a) !== 6) return false;
  // IPv4 inside IPv6 (mapped, compatible, NAT64): judged as the IPv4 address.
  const tail = /^(?:::ffff:|::ffff:0:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (tail) return isPublicV4(tail[1]!);
  const words = expandV6(a);
  if (!words) return false;
  const [w0] = words;
  if (words.every((w) => w === 0)) return false; // ::
  if (words.slice(0, 7).every((w) => w === 0) && words[7] === 1) return false; // ::1
  if (words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff) return false; // mapped, hex form
  if (words.slice(0, 4).every((w) => w === 0) && words[4] === 0xffff && words[5] === 0)
    return false; // IPv4-translated
  if (w0 === 0x64 && words[1] === 0xff9b) return false; // NAT64
  if ((w0! & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((w0! & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((w0! & 0xffc0) === 0xfec0) return false; // fec0::/10 site-local
  if ((w0! & 0xff00) === 0xff00) return false; // multicast
  if (w0 === 0x2001 && words[1] === 0x0db8) return false; // documentation
  return true;
}

function isPublicV4(a: string): boolean {
  const [p, q] = a.split(".").map(Number) as [number, number];
  if (p === 0 || p === 10 || p === 127) return false;
  if (p === 100 && q >= 64 && q <= 127) return false; // shared (CGNAT)
  if (p === 169 && q === 254) return false; // link-local, metadata
  if (p === 172 && q >= 16 && q <= 31) return false;
  if (p === 192 && q === 168) return false;
  if (p === 192 && q === 0) return false; // 192.0.0.0/24, 192.0.2.0/24
  if (p === 198 && (q === 18 || q === 19)) return false; // benchmarking
  if (p === 198 && q === 51) return false; // documentation
  if (p === 203 && q === 0) return false; // documentation
  if (p >= 224) return false; // multicast, reserved, broadcast
  return true;
}

function expandV6(a: string): number[] | null {
  const [head, tail, ...rest] = a.split("::");
  if (rest.length) return null;
  const part = (s: string | undefined) =>
    s ? s.split(":").map((w) => Number.parseInt(w, 16)) : [];
  const h = part(head);
  const t = part(tail);
  const fill = tail === undefined ? 0 : 8 - h.length - t.length;
  const words = [...h, ...Array(Math.max(0, fill)).fill(0), ...t];
  return words.length === 8 && words.every((w) => w >= 0 && w <= 0xffff) ? words : null;
}

async function readKept(path: string): Promise<Kept | null> {
  try {
    const [meta, s] = await Promise.all([readFile(`${path}.json`, "utf8"), stat(path)]);
    const kept = JSON.parse(meta) as Kept;
    // Kept before only raster images were: what the other server called it isn't trusted.
    return s.isFile() && RASTER.has(kept.type) ? kept : null;
  } catch {
    return null;
  }
}

const RASTER = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
]);
