import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Artboard, Doc, PElement } from "@ponzu/core";
import type { Renderer } from "@ponzu/render";

/**
 * Where a design keeps its canvas preview. The Mac app's Quick Look extension
 * shows it as the file's icon in Finder. The folder ignores itself in git.
 */
export const PREVIEW_DIR = ".ponzu";
export const PREVIEW_FILE = `${PREVIEW_DIR}/preview.png`;
/** The same preview on the dark canvas, for the studio in dark mode. */
export const PREVIEW_DARK_FILE = `${PREVIEW_DIR}/preview-dark.png`;

/**
 * How previews are drawn. A preview from an older version is redrawn and gets
 * a new URL: version 1 drew without the design's assets/ images.
 */
export const PREVIEW_VERSION = 2;
const VERSION_FILE = `${PREVIEW_DIR}/version`;

export type PreviewTheme = "light" | "dark";

export const previewFile = (theme: PreviewTheme) =>
  theme === "dark" ? PREVIEW_DARK_FILE : PREVIEW_FILE;

/** The long side of the preview in CSS px; it renders at 2x. */
const SIZE = 512;
const SCALE = 2;
/** The canvas in each theme (packages/react/src/styles.css), so the preview reads as it. */
const CANVAS = { light: "#f3f3f1", dark: "#121212" };
/** The artboard edge on each canvas, at 1 preview px. */
const EDGE = {
  light: (u: number) => `0 0 0 ${u}px rgba(0,0,0,0.08), 0 ${2 * u}px ${6 * u}px rgba(0,0,0,0.08)`,
  dark: (u: number) => `0 0 0 ${u}px rgba(255,255,255,0.08)`,
};

const px = (v: string | undefined, fallback: number) =>
  v && /px$/.test(v) ? Number.parseFloat(v) || fallback : fallback;

/**
 * The first page laid out like the canvas, scaled to fit, as one artboard a
 * Renderer can shoot. Null when the page has nothing on it.
 */
export function previewArtboard(doc: Doc, theme: PreviewTheme = "light"): Artboard | null {
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
      "box-shadow": EDGE[theme](1 / fit),
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
      background: CANVAS[theme],
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

/**
 * Renders the preview, light and dark, into the design folder. With nothing to
 * draw, removes any old preview so Finder falls back to the document icon.
 * False then. `assetBase` is where the renderer loads the design's assets/ from.
 */
export async function writePreview(
  root: string,
  doc: Doc,
  renderer: Renderer,
  assetBase?: string,
): Promise<boolean> {
  const files = [PREVIEW_DARK_FILE, PREVIEW_FILE].map((f) => join(root, f));
  if (!previewArtboard(doc)) {
    if (!files.some((f) => existsSync(f))) return false;
    await Promise.all(files.map((f) => rm(f, { force: true })));
    await touch(root);
    return false;
  }
  const dir = join(root, PREVIEW_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".gitignore"), "*\n");
  // Dark first: the light file's date is the preview's version (catalog.ts).
  for (const theme of ["dark", "light"] as const) {
    const out = await renderer.render({
      artboard: previewArtboard(doc, theme)!,
      tokens: doc.tokens,
      scale: SCALE,
      colorScheme: theme,
      assetBase,
    });
    // Write then rename, so Finder never reads half an image.
    const file = join(root, previewFile(theme));
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, out.bytes);
    await rename(tmp, file);
  }
  await writeFile(join(root, VERSION_FILE), `${PREVIEW_VERSION}\n`);
  await touch(root);
  return true;
}

/** Whether the preview on disk was drawn the way this version draws them. */
export async function previewCurrent(root: string): Promise<boolean> {
  const v = await readFile(join(root, VERSION_FILE), "utf8").catch(() => "");
  return Number.parseInt(v, 10) === PREVIEW_VERSION;
}

/**
 * Finder keys its icon cache on the package's own modification date, which a
 * write two levels down doesn't change.
 */
async function touch(root: string): Promise<void> {
  const now = new Date();
  await utimes(root, now, now);
}

/**
 * Whether either preview is missing, older than anything else in the design,
 * or drawn by an older version.
 */
export async function previewStale(root: string): Promise<boolean> {
  if (!(await previewCurrent(root))) return true;
  let made: number;
  try {
    const dates = await Promise.all(
      [PREVIEW_FILE, PREVIEW_DARK_FILE].map(async (f) => (await stat(join(root, f))).mtimeMs),
    );
    made = Math.min(...dates);
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
      if (e.isDirectory()) {
        if (await newer(p)) return true;
        continue;
      }
      // A file saved away mid-walk, or a dangling symlink, says nothing.
      const changed = await stat(p).then(
        (s) => s.mtimeMs,
        () => 0,
      );
      if (changed > made) return true;
    }
    return false;
  };
  return newer(root);
}
