/*
 * Drawing the cloud gallery in headless Chromium: build it, serve it, screenshot a composition,
 * draw one of the design's own boards, and compare two pictures. Used by `scripts/visual.ts`
 * and by the gallery's tests. Playwright comes from @ponzu/render, which already depends on it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type ChromiumOptions, findChromium } from "@ponzu/render/chromium";
import type { Composition, Rect } from "../src/cloud/gallery/compositions.ts";

export type Page = Parameters<NonNullable<ChromiumOptions["preparePage"]>>[0];
export interface Browser {
  newPage(options?: object): Promise<Page>;
  close(): Promise<void>;
}

export const STUDIO = resolve(import.meta.dir, "..");
export const REFERENCES = join(STUDIO, "src/cloud/gallery/references");

export const chromiumPath = findChromium();

export async function launch(): Promise<Browser> {
  if (!chromiumPath) throw new Error("No Chrome or Chromium found (set PONZU_CHROMIUM).");
  const { chromium } = (await import(
    Bun.resolveSync("playwright-core", dirname(Bun.resolveSync("@ponzu/render/chromium", STUDIO)))
  )) as { chromium: { launch(o: object): Promise<Browser> } };
  return chromium.launch({ executablePath: chromiumPath, headless: true });
}

/** Builds the gallery (gallery.html and what it imports) into a fresh directory. */
export async function buildGallery(): Promise<{ dir: string; dispose(): void }> {
  const dir = mkdtempSync(join(tmpdir(), "ponzu-gallery-"));
  const build = Bun.spawn(["bunx", "vite", "build", "--mode", "gallery", "--outDir", dir], {
    cwd: STUDIO,
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await build.exited) !== 0) {
    const err = await new Response(build.stderr).text();
    throw new Error(`The gallery didn't build:\n${err}`);
  }
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Serves a directory on a free local port. */
export function serve(dir: string): { url: string; stop(): void } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname);
      const file = Bun.file(join(dir, path === "/" ? "gallery.html" : path));
      return (await file.exists())
        ? new Response(file)
        : new Response("Not found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

export type Theme = "light" | "dark";

/** Pins the scheme and stills motion, so a picture is the settled state. */
async function prepare(page: Page, width: number, height: number, theme: Theme) {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
}

/** Text drawn transparent, keeping its layout: what a reference compares across machines. */
const HIDE_TEXT =
  "*, *::placeholder { -webkit-text-fill-color: transparent !important; caret-color: transparent !important; }";

/**
 * A gallery composition at its size: fonts loaded, images decoded, and its `open` control (a
 * menu or popover trigger) pressed like a person would.
 */
export async function shootComposition(
  page: Page,
  base: string,
  composition: Composition,
  theme: Theme,
  options: { hideText?: boolean } = {},
): Promise<Buffer> {
  await prepare(page, composition.width, composition.height, theme);
  await page.goto(`${base}/gallery.html?board=${composition.id}&theme=${theme}`);
  await page.waitForFunction(() => (window as { galleryReady?: boolean }).galleryReady === true);
  await settle(page);
  if (composition.open) {
    await page.click(composition.open);
    await page.waitForTimeout(250);
  }
  if (options.hideText) await page.addStyleTag({ content: HIDE_TEXT });
  // The pointer rests out of the way, so nothing shows a hover.
  await page.mouse.move(composition.width - 1, composition.height - 1);
  return page.screenshot({ animations: "disabled", caret: "hide" });
}

/**
 * One of the design's boards (an artboard file of a .design folder) at its size, with the
 * design's tokens. Dark swaps the board's `.ui-light` for `.ui-dark`; colors a board writes as
 * literals stay light.
 */
export async function shootBoard(
  page: Page,
  designDir: string,
  board: string,
  size: { width: number; height: number },
  theme: Theme,
  scratch: string,
): Promise<Buffer> {
  await prepare(page, size.width, size.height, theme);
  let html = await Bun.file(join(designDir, "pages", board)).text();
  if (theme === "dark") html = html.replaceAll('class="ui-light"', 'class="ui-dark"');
  const base = `file://${resolve(designDir)}/`;
  const doc = `<!doctype html><html><head><meta charset="utf-8"><base href="${base}"><link rel="stylesheet" href="tokens.css"><style>body{margin:0;font-family:var(--font-sans)}${ARTBOARD_BASE}</style></head><body>${html}</body></html>`;
  const file = join(scratch, `${board.replaceAll("/", "_")}.html`);
  await Bun.write(file, doc);
  await page.goto(`file://${file}`);
  await settle(page);
  await page.mouse.move(size.width - 1, size.height - 1);
  return page.screenshot({ animations: "disabled", caret: "hide" });
}

// packages/render's ARTBOARD_BASE_CSS, which the canvas draws boards with.
const ARTBOARD_BASE = `[data-artboard]{display:flex;flex-direction:column;position:relative;overflow:hidden;box-sizing:border-box;background:#fff;color:#000}[data-artboard] *,[data-artboard] *::before,[data-artboard] *::after{box-sizing:border-box}`;

async function settle(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((i) => i.decode().catch(() => {})));
    // An avatar draws its picture only once it has loaded (ui/avatar.tsx).
    for (let tries = 0; tries < 100; tries++) {
      if (!document.querySelector('[data-slot="avatar"][data-status="loading"]')) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}

/**
 * What the page paints, as lines a person can read in a diff: every piece of text with its color,
 * weight, size and family; every icon with its color and stroke; every ground and shadow. Computed
 * styles don't depend on the machine's fonts or GPU, so these catch on any machine what a
 * picture with its text hidden can't: a changed text or icon color, a wrong weight or size.
 */
export async function paintedStyles(page: Page): Promise<string> {
  return page.evaluate(() => {
    const lines: string[] = [];
    const clip = (s: string) => (s.length > 40 ? `${s.slice(0, 39)}…` : s);
    const name = (el: Element) => {
      const label = el.closest("[aria-label]")?.getAttribute("aria-label");
      return `${el.tagName.toLowerCase()}${label ? `[${clip(label)}]` : ""}`;
    };
    for (const el of document.body.querySelectorAll("*")) {
      if (el.closest("svg") && el.tagName.toLowerCase() !== "svg") continue;
      if (!el.getClientRects().length) continue;
      const css = getComputedStyle(el);
      if (css.visibility !== "visible") continue;
      const opacity = css.opacity === "1" ? "" : ` opacity ${css.opacity}`;
      if (el.tagName.toLowerCase() === "svg") {
        const shape = el.querySelector("path, circle, rect, line, polyline");
        const stroke = shape ? ` stroke ${getComputedStyle(shape).strokeWidth}` : "";
        const size = `${el.getAttribute("width")}×${el.getAttribute("height")}`;
        lines.push(`icon ${name(el)} ${size} ${css.color}${stroke}${opacity}`);
        continue;
      }
      const own = [...el.childNodes]
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent ?? "")
        .join("")
        .trim();
      if (own) {
        const family = css.fontFamily.split(",")[0]!.replaceAll('"', "");
        lines.push(
          `text "${clip(own)}" ${css.color} ${css.fontWeight} ${css.fontSize} ${family}${opacity}`,
        );
      }
      const ground = css.backgroundColor === "rgba(0, 0, 0, 0)" ? "" : ` ${css.backgroundColor}`;
      // Tailwind composes its shadows with empty layers; they paint nothing.
      const layers = css.boxShadow.replaceAll(/rgba\(0, 0, 0, 0\) 0px 0px 0px 0px(, )?/g, "");
      const shadow = layers === "none" || !layers ? "" : ` shadow ${layers}`;
      if (ground || shadow) lines.push(`ground ${name(el)}${ground}${shadow}`);
    }
    return `${lines.join("\n")}\n`;
  });
}

/** Whether the app's three families loaded: without them, text measures differently. */
export async function fontsLoaded(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const faces = ['500 13px "Inter"', '600 34px "Funnel Display"', '11px "IBM Plex Mono"'];
    const loaded = await Promise.all(faces.map((f) => document.fonts.load(f).catch(() => [])));
    return loaded.every((list) => list.length > 0);
  });
}

export interface Difference {
  /** Share of pixels that differ, 0 to 1. */
  changed: number;
  /** The same, leaving out the masked rects. */
  changedOutsideMasks: number;
  /** The second picture, faded, with what differs in red. */
  image: Buffer;
}

/**
 * Compares two same-sized PNGs in the page's canvas. A pixel differs when any channel is more
 * than `tolerance` (0 to 255) apart.
 */
export async function compare(
  page: Page,
  a: Buffer,
  b: Buffer,
  masks: Rect[] = [],
  tolerance = 16,
): Promise<Difference> {
  const result = await page.evaluate(
    async ({ a, b, masks, tolerance }) => {
      const load = async (src: string) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        return img;
      };
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      const width = Math.max(ia.width, ib.width);
      const height = Math.max(ia.height, ib.height);
      const pixels = (img: HTMLImageElement) => {
        const c = new OffscreenCanvas(width, height);
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, width, height).data;
      };
      const pa = pixels(ia);
      const pb = pixels(ib);
      const out = new OffscreenCanvas(width, height);
      const octx = out.getContext("2d")!;
      const diff = octx.createImageData(width, height);
      const masked = (x: number, y: number) =>
        masks.some((m) => x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height);
      let changed = 0;
      let changedOutside = 0;
      let outside = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          const differs =
            Math.abs(pa[i]! - pb[i]!) > tolerance ||
            Math.abs(pa[i + 1]! - pb[i + 1]!) > tolerance ||
            Math.abs(pa[i + 2]! - pb[i + 2]!) > tolerance;
          const inMask = masked(x, y);
          if (!inMask) outside++;
          if (differs) {
            changed++;
            if (!inMask) changedOutside++;
          }
          const grey = 255 - (255 - (pb[i]! + pb[i + 1]! + pb[i + 2]!) / 3) * 0.25;
          diff.data[i] = differs ? 230 : grey;
          diff.data[i + 1] = differs ? 40 : grey;
          diff.data[i + 2] = differs ? 40 : grey;
          diff.data[i + 3] = 255;
        }
      }
      octx.putImageData(diff, 0, 0);
      const blob = await out.convertToBlob({ type: "image/png" });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return {
        changed: changed / (width * height),
        changedOutsideMasks: outside ? changedOutside / outside : 0,
        image: btoa(binary),
      };
    },
    {
      a: `data:image/png;base64,${a.toString("base64")}`,
      b: `data:image/png;base64,${b.toString("base64")}`,
      masks,
      tolerance,
    },
  );
  return { ...result, image: Buffer.from(result.image, "base64") };
}

/** Where things are in one frame, after layout and the canvas's own resize handling. */
export interface Frame {
  t: number;
  /** The canvas pane's edges. */
  left: number;
  right: number;
  /** The divider before the tabs, and the one at the rail's edge. */
  divider: number;
  railDivider: number;
  /** The first page tab, and the thread toggle. */
  tab: number;
  thread: number;
  /** The design's name in the chrome: its room's width, and how opaque it is. */
  title: number;
  titleOpacity: number;
  /** The first board on the canvas, where there is one: where it is on screen. */
  boardX: number;
  boardY: number;
}

/**
 * Presses `selector` and records every frame until things have rested. Measured in a
 * ResizeObserver on the canvas pane made after the page's own: where a frame is painted, after
 * the canvas has answered its pane's resize.
 */
export function sampleToggle(page: Page, selector: string): Promise<Frame[]> {
  return page.evaluate(
    (selector) =>
      new Promise<Frame[]>((resolve) => {
        const main = document.querySelector("main")!;
        const x = (el: Element | null | undefined) => el?.getBoundingClientRect().left ?? NaN;
        const dividers = () => document.querySelectorAll("header [data-chrome-divider]");
        const frames: Frame[] = [];
        const measure = () => {
          const box = main.getBoundingClientRect();
          const title = document.querySelector("[data-chrome-title]");
          const all = dividers();
          const board = document.querySelector("[data-artboard-host]")?.getBoundingClientRect();
          frames.push({
            t: performance.now(),
            left: box.left,
            right: box.right,
            divider: x(all[0]),
            railDivider: x(all[1]),
            tab: x(document.querySelector('header [role="tab"]')),
            thread: x(document.querySelector('header [aria-controls="thread"]')),
            title: title?.getBoundingClientRect().width ?? NaN,
            titleOpacity: title ? Number(getComputedStyle(title).opacity) : NaN,
            boardX: board?.left ?? NaN,
            boardY: board?.top ?? NaN,
          });
        };
        const ro = new ResizeObserver(measure);
        measure();
        ro.observe(main);
        (document.querySelector(selector) as HTMLElement).click();
        setTimeout(() => {
          ro.disconnect();
          measure();
          resolve(frames);
        }, 700);
      }),
    selector,
  );
}
