#!/usr/bin/env bun
/**
 * The files Ponzu's emails load from this site (apps/web/public/email), made from the apps' own
 * sources so they never drift:
 *
 * - tile-96.png: the yuzu tile, 96 pixels square, which an email shows at 32. The slice's six
 *   segments (@ponzu/canvas/slice, the drawing every app uses) in ink on a yuzu rounded square,
 *   drawn here point by point, so the file comes out the same on any machine with no browser or
 *   image library. A self-contained tile reads the same on white, in a mail app's dark theme and
 *   under Gmail's or Outlook's inversion, so it has no dark twin. Clients cache images, so if
 *   the art ever changes, the file gets a new name.
 * - funnel-display-600.woff2: the Latin subset of Funnel Display that the apps embed, byte for
 *   byte, for the mail apps that load a web font (Apple Mail and iOS Mail). It is under the SIL
 *   Open Font License, whose text goes beside it.
 *
 *   bun apps/web/scripts/email-assets.ts           write them
 *   bun apps/web/scripts/email-assets.ts --check   exit 1 if what is committed is not what this draws
 *
 * email-assets.test.ts runs the check.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { SLICE, SLICE_STROKE } from "@ponzu/canvas/slice";

const ROOT = join(import.meta.dir, "..", "..", "..");
export const EMAIL_DIR = join(ROOT, "apps", "web", "public", "email");
const FONTS = join(ROOT, "apps", "studio", "src", "cloud", "styles", "fonts");

/** The published names, which the emails link to as https://ponzu.design/email/<name>. */
export const TILE = "tile-96.png";
export const FONT = "funnel-display-600.woff2";
export const FONT_LICENSE = "OFL-FunnelDisplay.txt";
export const FONT_SOURCE = join(FONTS, "funnel-display-latin.woff2");
const FONT_LICENSE_SOURCE = join(FONTS, FONT_LICENSE);

/** The tile's size in pixels, and how it is drawn. */
export const TILE_SIZE = 96;
const RADIUS = TILE_SIZE * 0.22;
/** The slice's 64-unit grid, 60 pixels across, in the middle of the tile. */
const SCALE = 60 / 64;
const OFFSET = (TILE_SIZE - 64 * SCALE) / 2;
/** Samples per pixel along each side, for smooth edges. */
const SAMPLES = 8;
const YUZU = [0xff, 0xc8, 0x1e] as const;
const INK = [0x11, 0x11, 0x10] as const;

type Point = [number, number];

/** A segment's outline as points: its two lines, and its arc as many short lines. */
function outline(d: string): Point[] {
  const tokens = d.match(/[MLAZ]|-?\d*\.?\d+/g) ?? [];
  const points: Point[] = [];
  let i = 0;
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    const command = tokens[i++];
    if (command === "M" || command === "L") points.push([num(), num()]);
    else if (command === "A") {
      const r = num();
      num(); // ry, the same as rx: a circle
      num(); // rotation
      const large = num();
      const sweep = num();
      const end: Point = [num(), num()];
      points.push(...arc(points.at(-1)!, end, r, large === 1, sweep === 1));
    } else if (command !== "Z") throw new Error(`email-assets: no ${command} in a slice path`);
  }
  return points;
}

/** A circular arc from `a` to `b`, as SVG draws it, without its first point. */
function arc(a: Point, b: Point, r: number, large: boolean, sweep: boolean): Point[] {
  const [mx, my] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const half = Math.hypot(dx, dy) / 2;
  const h = Math.sqrt(Math.max(0, r * r - half * half));
  // The centre is on the chord's perpendicular, on the side the flags choose.
  const side = large === sweep ? -1 : 1;
  const [cx, cy] = [mx - (side * h * dy) / (2 * half), my + (side * h * dx) / (2 * half)];
  const start = Math.atan2(a[1] - cy, a[0] - cx);
  let delta = Math.atan2(b[1] - cy, b[0] - cx) - start;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  const steps = 96;
  return Array.from({ length: steps }, (_, k) => {
    const t = start + (delta * (k + 1)) / steps;
    return [cx + r * Math.cos(t), cy + r * Math.sin(t)] as Point;
  });
}

function inside(polygon: Point[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Whether (x, y) is within `reach` of the outline: the stroke, with its round joins. */
function near(polygon: Point[], x: number, y: number, reach: number): boolean {
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ax, ay] = polygon[j]!;
    const [bx, by] = polygon[i]!;
    const [vx, vy] = [bx - ax, by - ay];
    const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy)));
    if (Math.hypot(x - ax - t * vx, y - ay - t * vy) <= reach) return true;
  }
  return false;
}

function inTile(x: number, y: number): boolean {
  const cx = Math.min(Math.max(x, RADIUS), TILE_SIZE - RADIUS);
  const cy = Math.min(Math.max(y, RADIUS), TILE_SIZE - RADIUS);
  return Math.hypot(x - cx, y - cy) <= RADIUS;
}

/** The tile's pixels, RGBA, row by row. */
export function drawTile(): Uint8Array {
  const segments = SLICE.map((d) => {
    const points = outline(d);
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const pad = SLICE_STROKE / 2;
    return {
      points,
      box: [
        Math.min(...xs) - pad,
        Math.min(...ys) - pad,
        Math.max(...xs) + pad,
        Math.max(...ys) + pad,
      ],
    };
  });
  const reach = SLICE_STROKE / 2;
  const pixels = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
  for (let py = 0; py < TILE_SIZE; py++) {
    for (let px = 0; px < TILE_SIZE; px++) {
      let tile = 0;
      let ink = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = px + (sx + 0.5) / SAMPLES;
          const y = py + (sy + 0.5) / SAMPLES;
          if (!inTile(x, y)) continue;
          tile++;
          // The sample on the slice's 64-unit grid.
          const [u, v] = [(x - OFFSET) / SCALE, (y - OFFSET) / SCALE];
          const on = segments.some(
            ({ points, box }) =>
              u >= box[0]! &&
              u <= box[2]! &&
              v >= box[1]! &&
              v <= box[3]! &&
              (inside(points, u, v) || near(points, u, v, reach)),
          );
          if (on) ink++;
        }
      }
      const at = (py * TILE_SIZE + px) * 4;
      if (tile === 0) continue;
      for (let c = 0; c < 3; c++) {
        pixels[at + c] = Math.round((ink * INK[c]! + (tile - ink) * YUZU[c]!) / tile);
      }
      pixels[at + 3] = Math.round((255 * tile) / (SAMPLES * SAMPLES));
    }
  }
  return pixels;
}

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  const typed = new TextEncoder().encode(type);
  out.set(typed, 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** An 8-bit RGBA PNG of `pixels`, each row unfiltered. */
export function encodePng(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const parts = [
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * A PNG this script wrote, read back: its size and RGBA pixels. Only what encodePng writes (8-bit
 * RGBA, unfiltered rows) is read; anything else throws, so a file someone re-saved elsewhere is
 * told apart from the script's.
 */
export function decodePng(file: Uint8Array): { width: number; height: number; pixels: Uint8Array } {
  if (!SIGNATURE.every((b, i) => file[i] === b)) throw new Error("not a PNG");
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  const data: Uint8Array[] = [];
  while (at < file.length) {
    const length = view.getUint32(at);
    const type = new TextDecoder().decode(file.subarray(at + 4, at + 8));
    const body = file.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      if (body[8] !== 8 || body[9] !== 6 || body[12] !== 0) throw new Error("not 8-bit RGBA");
    } else if (type === "IDAT") data.push(body);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    if (raw[row] !== 0) throw new Error("a filtered row");
    pixels.set(raw.subarray(row + 1, row + 1 + width * 4), y * width * 4);
  }
  return { width, height, pixels };
}

/** What differs between the committed files and what this script makes; empty when none. */
export function problems(dir = EMAIL_DIR): string[] {
  const found: string[] = [];
  const tile = join(dir, TILE);
  if (!existsSync(tile)) found.push(`${TILE} is missing`);
  else {
    const read = decodePng(readFileSync(tile));
    if (read.width !== TILE_SIZE || read.height !== TILE_SIZE) {
      found.push(`${TILE} is ${read.width}×${read.height}, not ${TILE_SIZE}×${TILE_SIZE}`);
    } else if (!Buffer.from(read.pixels).equals(Buffer.from(drawTile()))) {
      found.push(`${TILE} is not what the script draws`);
    }
  }
  for (const [name, source] of [
    [FONT, FONT_SOURCE],
    [FONT_LICENSE, FONT_LICENSE_SOURCE],
  ] as const) {
    const file = join(dir, name);
    if (!existsSync(file)) found.push(`${name} is missing`);
    else if (!readFileSync(file).equals(readFileSync(source))) {
      found.push(`${name} is not the apps' copy`);
    }
  }
  return found;
}

if (import.meta.main) {
  if (process.argv.includes("--check")) {
    const found = problems();
    for (const problem of found) console.error(problem);
    process.exit(found.length ? 1 : 0);
  }
  mkdirSync(EMAIL_DIR, { recursive: true });
  writeFileSync(join(EMAIL_DIR, TILE), encodePng(drawTile(), TILE_SIZE, TILE_SIZE));
  writeFileSync(join(EMAIL_DIR, FONT), readFileSync(FONT_SOURCE));
  writeFileSync(join(EMAIL_DIR, FONT_LICENSE), readFileSync(FONT_LICENSE_SOURCE));
  console.log(`wrote ${TILE}, ${FONT} and ${FONT_LICENSE} in apps/web/public/email`);
}
