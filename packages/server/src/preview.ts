import { mkdir, readdir, rename, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Artboard, Doc, PElement } from "@ponzu/core";
import type { Renderer } from "@ponzu/render";

/**
 * Where a design keeps its canvas preview. The Mac app's Quick Look extension
 * shows it as the file's icon in Finder. The folder ignores itself in git.
 */
export const PREVIEW_DIR = ".ponzu";
export const PREVIEW_FILE = `${PREVIEW_DIR}/preview.png`;

/** The long side of the preview in CSS px; it renders at 2x. */
const SIZE = 512;
const SCALE = 2;
/** Light canvas color from the studio, so the preview reads as the canvas. */
const CANVAS = "#f3f3f1";

const px = (v: string | undefined, fallback: number) =>
  v && /px$/.test(v) ? Number.parseFloat(v) || fallback : fallback;

/**
 * The first page laid out like the canvas, scaled to fit, as one artboard a
 * Renderer can shoot. Null when the page has nothing on it.
 */
export function previewArtboard(doc: Doc): Artboard | null {
  const boards = doc.pages[0]?.artboards ?? [];
  if (!boards.length) return null;
  const rects = boards.map((ab) => ({
    ab,
    x: ab.x,
    y: ab.y,
    w: px(ab.root.style.width, 1440),
    h: px(ab.root.style.height, 900),
  }));
  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.w));
  const bottom = Math.max(...rects.map((r) => r.y + r.h));
  // A margin of canvas around the artboards, and an icon-friendly shape:
  // no wider than 16:10 and no taller than 3:4.
  const pad = Math.max(right - left, bottom - top) * 0.06;
  let w = right - left + pad * 2;
  let h = bottom - top + pad * 2;
  if (w / h > 1.6) h = w / 1.6;
  if (h / w > 4 / 3) w = h * 0.75;
  const fit = SIZE / Math.max(w, h);
  const offsetX = (w - (right - left)) / 2 - left;
  const offsetY = (h - (bottom - top)) / 2 - top;

  const children: PElement[] = rects.map(({ ab, x, y }) => ({
    ...ab.root,
    attrs: { "data-artboard": "", ...ab.root.attrs },
    name: ab.name,
    style: {
      ...ab.root.style,
      position: "absolute",
      left: `${x + offsetX}px`,
      top: `${y + offsetY}px`,
      margin: "0",
      "box-shadow": `0 0 0 ${1 / fit}px rgba(0,0,0,0.08), 0 ${2 / fit}px ${6 / fit}px rgba(0,0,0,0.08)`,
    },
  }));
  const root: PElement = {
    kind: "el",
    id: "preview_canvas",
    tag: "div",
    attrs: {},
    style: {
      width: `${Math.round(w * fit)}px`,
      height: `${Math.round(h * fit)}px`,
      background: CANVAS,
    },
    children: [
      {
        kind: "el",
        id: "preview_boards",
        tag: "div",
        attrs: {},
        style: {
          position: "absolute",
          left: "0",
          top: "0",
          width: `${w}px`,
          height: `${h}px`,
          transform: `scale(${fit})`,
          "transform-origin": "0 0",
        },
        children,
      },
    ],
  };
  return { id: "preview_canvas", name: doc.name, x: 0, y: 0, root };
}

/** Renders the preview into the design folder. False when there was nothing to draw. */
export async function writePreview(root: string, doc: Doc, renderer: Renderer): Promise<boolean> {
  const artboard = previewArtboard(doc);
  if (!artboard) return false;
  const out = await renderer.render({ artboard, tokens: doc.tokens, scale: SCALE });
  const dir = join(root, PREVIEW_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".gitignore"), "*\n");
  // Write then rename, so Finder never reads half an image.
  const file = join(root, PREVIEW_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, out.bytes);
  await rename(tmp, file);
  // Finder keys its icon cache on the package's own modification date, which
  // a write two levels down doesn't change.
  const now = new Date();
  await utimes(root, now, now);
  return true;
}

/** Whether the preview is missing or older than anything else in the design. */
export async function previewStale(root: string): Promise<boolean> {
  let made: number;
  try {
    made = (await stat(join(root, PREVIEW_FILE))).mtimeMs;
  } catch {
    return true;
  }
  const newer = async (dir: string): Promise<boolean> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory() ? await newer(p) : (await stat(p)).mtimeMs > made) return true;
    }
    return false;
  };
  return newer(root);
}
