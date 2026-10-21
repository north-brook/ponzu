import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Artboard, Doc } from "@ponzu/core";
import type { Renderer } from "@ponzu/render";
import {
  PREVIEW_DARK_FILE,
  PREVIEW_FILE,
  previewArtboard,
  previewStale,
  writePreview,
} from "./preview.ts";

const board = (id: string, x: number, y: number, width: number, height: number): Artboard => ({
  id,
  name: id,
  x,
  y,
  root: {
    kind: "el",
    id,
    tag: "section",
    attrs: {},
    style: { width: `${width}px`, height: `${height}px` },
    children: [],
  },
});

const doc = (artboards: Artboard[]): Doc => ({
  name: "Shop",
  pages: [{ id: "p1", name: "Home", artboards }],
  tokens: "",
  threads: [],
  notes: {},
});

test("lays the first page's artboards out like the canvas, scaled to fit", () => {
  const ab = previewArtboard(doc([board("a", 0, 0, 1440, 900), board("b", 1540, 0, 390, 844)]))!;
  expect(ab.root.style.width).toBe("512px");
  const [stage] = ab.root.children as [any];
  const [a, b] = stage.children;
  expect(a.attrs["data-artboard"]).toBe("");
  expect(Number.parseFloat(b.style.left) - Number.parseFloat(a.style.left)).toBe(1540);
  expect(stage.style.transform).toMatch(/^scale\(0\.\d+\)$/);
});

test("keeps an icon-friendly shape and skips empty files", () => {
  const wide = previewArtboard(doc([board("a", 0, 0, 4000, 200)]))!;
  expect(Number.parseFloat(wide.root.style.height!)).toBe(320);
  const tall = previewArtboard(doc([board("a", 0, 0, 390, 6000)]))!;
  expect(Number.parseFloat(tall.root.style.width!)).toBe(384);
  expect(previewArtboard(doc([]))).toBeNull();
});

test("draws on the dark canvas for dark mode", () => {
  const light = previewArtboard(doc([board("a", 0, 0, 800, 600)]))!;
  const dark = previewArtboard(doc([board("a", 0, 0, 800, 600)]), "dark")!;
  expect(light.root.style.background).toBe("#f3f3f1");
  expect(dark.root.style.background).toBe("#121212");
  expect(dark.root.style.width).toBe(light.root.style.width);
});

test("writes the preview, and removes it once the first page is empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "ponzu-preview-"));
  try {
    const schemes: (string | undefined)[] = [];
    const renderer = {
      render: async (req: { colorScheme?: string }) => {
        schemes.push(req.colorScheme);
        return { bytes: new Uint8Array([1, 2, 3]) };
      },
      close: async () => {},
    } as unknown as Renderer;
    expect(await writePreview(root, doc([board("a", 0, 0, 800, 600)]), renderer)).toBe(true);
    expect(existsSync(join(root, PREVIEW_FILE))).toBe(true);
    expect(existsSync(join(root, PREVIEW_DARK_FILE))).toBe(true);
    expect(schemes.sort()).toEqual(["dark", "light"]);
    expect(await readFile(join(root, ".ponzu/.gitignore"), "utf8")).toBe("*\n");

    const old = new Date(Date.now() - 60_000);
    await utimes(root, old, old);
    expect(await writePreview(root, doc([]), renderer)).toBe(false);
    expect(existsSync(join(root, PREVIEW_FILE))).toBe(false);
    expect(existsSync(join(root, PREVIEW_DARK_FILE))).toBe(false);
    // Finder only refreshes the icon when the package's own date moves.
    expect((await stat(root)).mtimeMs).toBeGreaterThan(old.getTime());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the preview is stale when missing or older than the design, and a dangling link doesn't throw", async () => {
  const root = await mkdtemp(join(tmpdir(), "ponzu-stale-"));
  try {
    await mkdir(join(root, "pages/home"), { recursive: true });
    await writeFile(join(root, "pages/home/hero.html"), "<section></section>");
    expect(await previewStale(root)).toBe(true);

    await mkdir(join(root, ".ponzu"));
    await writeFile(join(root, PREVIEW_FILE), "png");
    const old = new Date(Date.now() - 60_000);
    await utimes(join(root, "pages/home/hero.html"), old, old);
    // A design previewed before dark previews existed gets both drawn.
    expect(await previewStale(root)).toBe(true);
    await writeFile(join(root, PREVIEW_DARK_FILE), "png");
    await symlink(join(root, "gone"), join(root, "pages/home/dangling.html"));
    expect(await previewStale(root)).toBe(false);

    await writeFile(join(root, "pages/home/hero.html"), "<section>new</section>");
    const later = new Date(Date.now() + 60_000);
    await utimes(join(root, "pages/home/hero.html"), later, later);
    expect(await previewStale(root)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
