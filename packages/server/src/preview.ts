import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Doc, type PreviewTheme, previewArtboard } from "@ponzu/core";
import type { Renderer } from "@ponzu/render";

export { type PreviewTheme, previewArtboard } from "@ponzu/core";

/**
 * Where a design keeps its canvas preview. The Mac app's Quick Look extension
 * shows it as the file's icon in Finder, and ponzu.design/gh puts it on a
 * design's share card, so git keeps the two previews and ignores the rest.
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

/** The folder's .gitignore: everything but the previews, which travel with the design. */
export const PREVIEW_GITIGNORE = "*\n!.gitignore\n!preview.png\n!preview-dark.png\n";

export const previewFile = (theme: PreviewTheme) =>
  theme === "dark" ? PREVIEW_DARK_FILE : PREVIEW_FILE;

/** The preview renders at 2x. */
const SCALE = 2;

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
  await writeFile(join(dir, ".gitignore"), PREVIEW_GITIGNORE);
  // Dark first: the light file's date is the preview's version (catalog.ts).
  for (const theme of ["dark", "light"] as const) {
    const out = await renderer.render({
      artboard: previewArtboard(doc, theme)!,
      tokens: doc.tokens,
      scale: SCALE,
      colorScheme: theme,
      assetBase,
      thumbnail: true,
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
