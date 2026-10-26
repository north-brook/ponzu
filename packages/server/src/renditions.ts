import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { RENDITION_WIDTHS } from "@ponzu/render";
import { defaultCacheDir, touch, trim } from "./cache.ts";

/**
 * Smaller copies of big images, for a canvas that shows them small. A
 * 4000 px photo in a 300 px slot otherwise costs its full download, decode
 * and texture memory, and a page of them stalls the canvas for seconds. Only
 * the canvas asks for these (`?w=`); screenshots, exports and agents' tools
 * load the originals.
 *
 * A copy is one of {@link RENDITION_WIDTHS} wide and keeps the original's
 * size as its natural size, so it drops in for the original anywhere
 * (`<img>`, CSS backgrounds, `image-set()`, SVG `<image>`) without moving
 * anything, and the canvas never needs to know an image's size to ask:
 * - An opaque image becomes a JPEG that carries the original's size in EXIF
 *   (PixelXDimension and PixelYDimension, with a resolution to match), which
 *   Chromium lays out at that size.
 * - An image with transparency becomes a WebP inside an SVG of the
 *   original's size.
 * Animated images would lose their frames, so they have no copies. They, and
 * images already about as small as the copy, serve as they are.
 *
 * Copies are made with Bun's own codecs (no native modules, any platform) on
 * first ask, and kept on disk outside the design, in ~/.ponzu/cache.
 */

/**
 * Headers every image copy, picture and loop goes out with: it's only ever
 * an image or a video, never a page that could run script on Ponzu's origin.
 * A transparent copy is an SVG drawing a data: WebP, which it may load.
 */
export const MEDIA_HEADERS = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; img-src data:; sandbox",
} as const;

/** The copy width for a request: the step at or above it, or null for the original. */
export function renditionWidth(w: number, original: number): number | null {
  if (!Number.isFinite(w) || w <= 0) return null;
  const step = RENDITION_WIDTHS.find((s) => s >= w);
  // A copy within 20% of the original saves too little to be worth a re-encode.
  return step && step < original * 0.8 ? step : null;
}

/** An original on disk, or its bytes, and a version that changes with its content. */
export interface ImageSource {
  path?: string;
  bytes?: Uint8Array;
  v: string;
}

interface Meta {
  w: number;
  h: number;
  opaque: boolean;
}

/** Originals whose size and kind are remembered. */
const META_CAP = 4000;
/**
 * Originals bigger than this many pixels aren't decoded to make copies: a few
 * hundred bytes of PNG can claim 65535 × 65535, gigabytes once decoded. They
 * serve as they are, and the browser can refuse them itself.
 */
export const MAX_PIXELS = 100_000_000;

export interface Rendition {
  bytes: Uint8Array;
  type: "image/jpeg" | "image/svg+xml";
}

export interface RenditionsOptions {
  /** Cache folder. Default ~/.ponzu/cache. */
  dir?: string;
  /** Copies are trimmed to about this many bytes, least recently used first. Default 2 GB. */
  maxBytes?: number;
}

export class Renditions {
  readonly dir: string;
  /** The folder's budget on disk. */
  readonly maxBytes: number;
  /** What's been read about each original, most recently used last; capped. */
  private meta = new Map<string, Promise<Meta | null>>();
  private pending = new Map<string, Promise<Rendition | null>>();
  private jobs = 0;
  private waiting: (() => void)[] = [];
  private readonly maxJobs = Math.max(2, Math.floor(availableParallelism() / 2));
  private written = 0;
  private sweeping = false;

  constructor(opts: RenditionsOptions = {}) {
    this.dir = join(opts.dir ?? defaultCacheDir(), "renditions");
    this.maxBytes = opts.maxBytes ?? 2 * 1024 ** 3;
  }

  /** Whether this Bun can make copies. Without it, every image serves as it is. */
  static available(): boolean {
    return typeof (Bun as { Image?: unknown }).Image === "function";
  }

  /**
   * A copy of `src` about `width` px wide, or null to serve the original: it
   * isn't a still image, it's already about that small, or this Bun can't
   * resize.
   */
  async get(src: ImageSource, width: number): Promise<Rendition | null> {
    if (!Renditions.available()) return null;
    const id = sourceId(src);
    let m = this.meta.get(id);
    if (m) this.meta.delete(id);
    else m = readMeta(src);
    this.meta.set(id, m);
    if (this.meta.size > META_CAP) this.meta.delete(this.meta.keys().next().value!);
    const meta = await m;
    if (!meta) return null;
    const w = renditionWidth(width, meta.w);
    if (!w) return null;
    const type = meta.opaque ? "image/jpeg" : "image/svg+xml";
    const file = (step: number) => join(this.dir, `${id}-${step}.${meta.opaque ? "jpg" : "svg"}`);
    const out = file(w);
    try {
      const bytes = new Uint8Array(await readFile(out));
      void touch(out);
      return { bytes, type };
    } catch {}
    let job = this.pending.get(out);
    if (!job) {
      job = this.make(src, meta, w, out, file)
        .then((bytes): Rendition => ({ bytes, type }))
        .catch(() => null)
        .finally(() => this.pending.delete(out));
      this.pending.set(out, job);
    }
    return job;
  }

  private async make(
    src: ImageSource,
    m: Meta,
    w: number,
    out: string,
    file: (step: number) => string,
  ): Promise<Uint8Array> {
    await this.slot();
    try {
      // From a JPEG copy at least twice as big when there is one: a 12k
      // image takes over a second to decode, its 2048 copy a few ms.
      let input: string | Uint8Array = src.path ?? src.bytes!;
      if (m.opaque) {
        for (const step of RENDITION_WIDTHS) {
          if (step >= w * 2 && (await exists(file(step)))) {
            input = file(step);
            break;
          }
        }
      }
      const h = Math.max(1, Math.round((m.h * w) / m.w));
      const img = new Bun.Image(input).resize(w, h, { fit: "fill" });
      const bytes = m.opaque
        ? withSize(await img.jpeg({ quality: 88 }).bytes(), w, h, m.w, m.h)
        : inSvg(await img.webp({ quality: 90 }).bytes(), m.w, m.h);
      await mkdir(this.dir, { recursive: true });
      const tmp = `${out}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile(tmp, bytes);
      await rename(tmp, out);
      this.written += bytes.length;
      if (this.written > 64 * 1024 ** 2) {
        this.written = 0;
        void this.sweep();
      }
      return bytes;
    } finally {
      this.release();
    }
  }

  /** Half the cores at a time: a page of big photos would otherwise start hundreds at once. */
  private slot(): Promise<void> {
    if (this.jobs >= this.maxJobs) return new Promise((r) => this.waiting.push(r));
    this.jobs++;
    return Promise.resolve();
  }

  private release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.jobs--;
  }

  /** Trim the copies to 80% of their budget, least recently used first. */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      await trim(this.dir, this.maxBytes);
    } finally {
      this.sweeping = false;
    }
  }
}

/** A file on disk as a source: its version is its size and modification time. */
export async function fileSource(path: string): Promise<ImageSource | null> {
  const s = await stat(path).catch(() => null);
  if (!s?.isFile()) return null;
  return { path, v: `${s.size.toString(36)}-${Math.floor(s.mtimeMs).toString(36)}` };
}

function sourceId(src: ImageSource): string {
  const h = createHash("sha1");
  if (src.path) h.update(src.path);
  else h.update(src.bytes!);
  return h.update(`\0${src.v}`).digest("hex").slice(0, 24);
}

async function readMeta(src: ImageSource): Promise<Meta | null> {
  try {
    const head = src.bytes ?? (await headerOf(src.path!));
    const kind = imageKind(head);
    if (!kind.known || kind.animated) return null;
    // Oriented size: what a browser shows, and what the copy will be.
    const md = await new Bun.Image(src.path ?? src.bytes!).metadata();
    if (!(md.width > 0 && md.height > 0) || md.width * md.height > MAX_PIXELS) return null;
    return { w: md.width, h: md.height, opaque: kind.opaque };
  } catch {
    return null;
  }
}

/**
 * Enough of a file to judge it by: the first 64 KB, or for a PNG every chunk
 * up to its first image data, which a big text or ICC chunk can push past that
 * (a tRNS after it would be missed).
 */
async function headerOf(path: string): Promise<Uint8Array> {
  const file = Bun.file(path);
  let head = await file.slice(0, 1 << 16).bytes();
  if (String.fromCharCode(...head.subarray(1, 4)) !== "PNG") return head;
  const v = () => new DataView(head.buffer, head.byteOffset, head.byteLength);
  let o = 8;
  for (;;) {
    if (o + 8 > head.length) {
      if (head.length >= file.size || head.length >= 1 << 24) return head;
      head = await file.slice(0, Math.min(file.size, Math.max(o + 8, head.length * 2))).bytes();
      continue;
    }
    if (String.fromCharCode(...head.subarray(o + 4, o + 8)) === "IDAT") return head;
    o += 12 + v().getUint32(o);
  }
}

/**
 * What a file's header says about it: a format copies are made from (JPEG,
 * PNG, WebP, GIF), whether it's surely opaque (a JPEG, a PNG with no alpha
 * channel or transparent colour, a WebP without alpha) and whether it's
 * animated (APNG, animated WebP, any GIF).
 */
export function imageKind(head: Uint8Array): {
  known: boolean;
  opaque: boolean;
  animated: boolean;
} {
  const ascii = (o: number, n: number) => String.fromCharCode(...head.subarray(o, o + n));
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff)
    return { known: true, opaque: true, animated: false };
  if (ascii(1, 3) === "PNG") {
    const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const colorType = head[25] ?? 6;
    let opaque = colorType === 0 || colorType === 2 || colorType === 3;
    let animated = false;
    let o = 8;
    while (o + 8 <= head.length) {
      const type = ascii(o + 4, 4);
      if (type === "acTL") animated = true;
      if (type === "tRNS") opaque = false;
      if (type === "IDAT") break;
      o += 12 + v.getUint32(o);
    }
    return { known: true, opaque, animated };
  }
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const chunk = ascii(12, 4);
    if (chunk === "VP8X") {
      const flags = head[20] ?? 0;
      return { known: true, opaque: (flags & 0x10) === 0, animated: (flags & 0x02) !== 0 };
    }
    if (chunk === "VP8L")
      return { known: true, opaque: ((head[24] ?? 0) & 0x10) === 0, animated: false };
    return { known: true, opaque: chunk === "VP8 ", animated: false };
  }
  // A GIF may animate, and its first frame is all a copy could hold.
  if (ascii(0, 3) === "GIF") return { known: true, opaque: false, animated: true };
  return { known: false, opaque: false, animated: false };
}

/**
 * A JPEG that says it stands for a `W`×`H` original. Chromium shows a JPEG at
 * its EXIF PixelX/YDimension when its X/YResolution are in that proportion to
 * its pixels, so the copy lays out exactly like the original.
 */
function withSize(jpg: Uint8Array, w: number, h: number, W: number, H: number): Uint8Array {
  const tiff = new Uint8Array(108);
  const v = new DataView(tiff.buffer);
  tiff.set([0x4d, 0x4d, 0, 0x2a]);
  v.setUint32(4, 8);
  let p = 8;
  const entry = (tag: number, type: number, value: number) => {
    v.setUint16(p, tag);
    v.setUint16(p + 2, type);
    v.setUint32(p + 4, 1);
    if (type === 3) v.setUint16(p + 8, value);
    else v.setUint32(p + 8, value);
    p += 12;
  };
  // IFD0: XResolution and YResolution (rationals at 62 and 70), ResolutionUnit, the Exif IFD at 78.
  v.setUint16(p, 4);
  p += 2;
  entry(0x011a, 5, 62);
  entry(0x011b, 5, 70);
  entry(0x0128, 3, 2);
  entry(0x8769, 4, 78);
  v.setUint32(p, 0);
  v.setUint32(62, 72 * w);
  v.setUint32(66, W);
  v.setUint32(70, 72 * h);
  v.setUint32(74, H);
  // Exif IFD: PixelXDimension, PixelYDimension.
  p = 78;
  v.setUint16(p, 2);
  p += 2;
  entry(0xa002, 4, W);
  entry(0xa003, 4, H);
  v.setUint32(p, 0);
  const id = new TextEncoder().encode("Exif\0\0");
  const len = 2 + id.length + tiff.length;
  const out = new Uint8Array(jpg.length + 4 + id.length + tiff.length);
  out.set(jpg.subarray(0, 2));
  out.set([0xff, 0xe1, len >> 8, len & 255], 2);
  out.set(id, 6);
  out.set(tiff, 6 + id.length);
  out.set(jpg.subarray(2), 6 + id.length + tiff.length);
  return out;
}

/**
 * A WebP wrapped in an SVG the size of the original: an image with
 * transparency has no JPEG to carry its size, and an SVG's width and height
 * are its natural size wherever it's drawn.
 */
function inSvg(webp: Uint8Array, W: number, H: number): Uint8Array {
  const data = Buffer.from(webp).toString("base64");
  return new TextEncoder().encode(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><image width="${W}" height="${H}" preserveAspectRatio="none" href="data:image/webp;base64,${data}"/></svg>`,
  );
}

async function exists(p: string): Promise<boolean> {
  return (await stat(p).catch(() => null)) !== null;
}
