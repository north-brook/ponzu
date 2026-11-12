/*
 * Drawing the cloud gallery in headless Chromium: build it, serve it, screenshot a composition,
 * draw one of the mockup's own boards, and compare two pictures. Used by `scripts/visual.ts`
 * and by the gallery's tests. Playwright comes from @ponzu/render, which already depends on it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type ChromiumOptions, findChromium } from "@ponzu/render/chromium";
import type { Composition, Rect } from "../src/cloud/gallery/compositions.ts";
import { prebuilt } from "./prebuilt.ts";

export type Page = Parameters<NonNullable<ChromiumOptions["preparePage"]>>[0];
export interface Browser {
  newPage(options?: object): Promise<Page>;
  close(): Promise<void>;
}

export const STUDIO = resolve(import.meta.dir, "..");
export const REFERENCES = join(STUDIO, "src/cloud/gallery/references");

/**
 * The compositions ponzu.design shows (`visual.ts shots`), drawn with their text, in light and
 * dark, at twice the size, into apps/web/public/product as `<id>-<theme>.png`.
 */
export const SITE_SHOTS = [
  "thread-in-the-right-rail",
  "pull-request-tab",
  "together-on-a-canvas",
  "team-sidebar",
  "create",
] as const;

/**
 * The shots whose main pane is the open canvas: drawn with its boards (the gallery's `&boards`),
 * and refused if the boards don't draw, so the site never shows an empty canvas.
 */
export const SITE_BOARDS: ReadonlySet<string> = new Set([
  "thread-in-the-right-rail",
  "together-on-a-canvas",
  "team-sidebar",
]);

/** Where the shots go unless `--out` says otherwise. */
export const SITE_PRODUCT = resolve(STUDIO, "../web/public/product");

/** The scale the site's shots are drawn at: sharp on a retina screen. */
export const SITE_SCALE = 2;

export const chromiumPath = findChromium();

export async function launch(): Promise<Browser> {
  if (!chromiumPath) throw new Error("No Chrome or Chromium found (set PONZU_CHROMIUM).");
  const { chromium } = (await import(
    Bun.resolveSync("playwright-core", dirname(Bun.resolveSync("@ponzu/render/chromium", STUDIO)))
  )) as { chromium: { launch(o: object): Promise<Browser> } };
  return chromium.launch({ executablePath: chromiumPath, headless: true });
}

/**
 * Builds the gallery (gallery.html and what it imports) into a fresh directory: a copy of the
 * one built before the tests, when PONZU_PREBUILT_STUDIO names it (scripts/prebuilt.ts).
 */
export async function buildGallery(): Promise<{ dir: string; dispose(): void }> {
  const ready = prebuilt("gallery");
  if (ready) return { dir: ready, dispose: () => rmSync(ready, { recursive: true, force: true }) };
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
 * menu or popover trigger) pressed like a person would. The picture is drawn at the page's
 * device scale, which is set when the page is made (`browser.newPage({ deviceScaleFactor })`).
 */
export async function shootComposition(
  page: Page,
  base: string,
  composition: Composition,
  theme: Theme,
  options: { hideText?: boolean; boards?: boolean } = {},
): Promise<Buffer> {
  await prepare(page, composition.width, composition.height, theme);
  const boards = options.boards ? "&boards" : "";
  await page.goto(`${base}/gallery.html?board=${composition.id}&theme=${theme}${boards}`);
  await page.waitForFunction(() => (window as { galleryReady?: boolean }).galleryReady === true);
  await settle(page);
  if (options.boards) await boardsDrawn(page);
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
 * One of the mockup's boards (an artboard file of a .design folder) at its size, with the
 * mockup's tokens. Dark swaps the board's `.ui-light` for `.ui-dark`; colors a board writes as
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

/**
 * The canvas's boards (gallery `&boards`) drawn and still: each board's shadow root has its
 * content and the pictures in it, and nothing on the canvas has moved for ten frames running.
 * Fails after five seconds, rather than taking a half-drawn picture.
 */
async function boardsDrawn(page: Page) {
  const still = await page.evaluate(async () => {
    const root = document.querySelector(".pz-root");
    if (!root) return false;
    const hosts = () => [...root.querySelectorAll("*")].filter((el) => el.shadowRoot);
    const pose = () =>
      [...root.querySelectorAll<HTMLElement>("*")]
        .map((el) => el.style.transform)
        .filter(Boolean)
        .join("|");
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const deadline = performance.now() + 5_000;
    let last = "";
    let same = 0;
    while (performance.now() < deadline) {
      await frame();
      const drawn = hosts();
      const ready =
        drawn.length > 0 && drawn.every((el) => (el.shadowRoot?.childNodes.length ?? 0) > 0);
      const now = ready ? pose() : "";
      same = ready && now === last ? same + 1 : 0;
      last = now;
      if (same >= 10) {
        const images = drawn.flatMap((el) => [...el.shadowRoot!.querySelectorAll("img")]);
        await Promise.all(images.map((i) => i.decode().catch(() => {})));
        return true;
      }
    }
    return false;
  });
  if (!still) throw new Error("The canvas's boards didn't draw and settle in five seconds.");
}

async function settle(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((i) => i.decode().catch(() => {})));
    // An avatar, and a canvas's preview, draw their picture only once it has loaded
    // (ui/avatar.tsx, sidebar/canvas-preview.tsx).
    const loading = ["avatar", "canvas-preview"]
      .map((slot) => `[data-slot="${slot}"][data-status="loading"]`)
      .join(", ");
    for (let tries = 0; tries < 100; tries++) {
      if (!document.querySelector(loading)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}

/**
 * What the page paints, as lines a person can read in a diff: every piece of text with its color,
 * weight, size and family; every icon with its color and stroke; every picture and which file it
 * shows (so a theme's own picture, like a comment's dark one, is checked exactly); every ground
 * and shadow. Computed styles don't depend on the machine's fonts or GPU, so these catch on any
 * machine what a picture with its text hidden can't: a changed text or icon color, a wrong weight
 * or size, the other theme's picture.
 */
export async function paintedStyles(page: Page): Promise<string> {
  return page.evaluate(() => {
    const lines: string[] = [];
    const clip = (s: string) => (s.length > 40 ? `${s.slice(0, 39)}…` : s);
    // A built file without the hash the build adds; an inlined one by its type and a hash of it.
    const source = (src: string) => {
      if (!src.startsWith("data:")) {
        return (src.split(/[?#]/)[0]!.split("/").pop() ?? "").replace(/-[\w-]{8}(\.\w+)$/, "$1");
      }
      let h = 0x811c9dc5;
      for (let i = 0; i < src.length; i++) h = Math.imul(h ^ src.charCodeAt(i), 0x01000193);
      return `${src.slice(5, src.search(/[;,]/))} ${(h >>> 0).toString(16).padStart(8, "0")}`;
    };
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
      if (el instanceof HTMLImageElement) {
        lines.push(`image ${name(el)} ${source(el.currentSrc || el.src)}${opacity}`);
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

/** Whether the app's faces loaded: without them, text measures differently. */
export async function fontsLoaded(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const faces = [
      '500 13px "Inter"',
      'italic 400 13px "Inter"',
      '600 34px "Funnel Display"',
      '11px "IBM Plex Mono"',
    ];
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
  /** The main pane's edges. */
  left: number;
  right: number;
  /** The divider before the tabs, and the one at the rail's edge. */
  divider: number;
  railDivider: number;
  /** The first page tab, and the thread toggle. */
  tab: number;
  thread: number;
  /** The canvas's name in the chrome: its room's width, and how opaque it is. */
  title: number;
  titleOpacity: number;
  /** The name's own width inside its room: set once, not re-cut as the room moves. */
  titleText: number;
  /** The first board on the canvas, where there is one: where it is on screen. */
  boardX: number;
  boardY: number;
}

/** A transition a toggle started on something that moves with a pane: the clock it eased on. */
export interface Clock {
  /** What eased: `#sidebar-pane`, `main`, `[data-chrome-title]`, `header > div:first-child`… */
  target: string;
  property: string;
  /** In ms. */
  duration: number;
  delay: number;
  easing: string;
}

/** A toggle pressed: where things were, frame by frame, and the clocks that moved them. */
export interface Toggle {
  frames: Frame[];
  clocks: Clock[];
}

/**
 * Presses `selector` and records every frame painted until the panes have rested (the window no
 * longer wears `data-pane-motion`, and two frames more). Measured in a ResizeObserver on the
 * main pane made after the page's own: where a frame is painted, after the canvas has answered
 * its pane's resize. How many frames that is depends on the machine: assert what holds in each
 * one, never how many there were. The clocks are every transition the press started on what
 * moves with a pane (the panels and `pane-motion`, cloud.css), caught as they are made.
 */
export function sampleToggle(page: Page, selector: string): Promise<Toggle> {
  return toggle(page, selector, 0);
}

/**
 * Presses `selector` and walks its easing on the easing's own clock rather than the machine's.
 * Every transition the press starts on what moves with a pane is caught as it is made, before a
 * frame is drawn, and held (at a playback rate of 0, so it still runs as far as the window can
 * tell); then all are set together to `steps + 1` times evenly spaced over the pane's own
 * transition, start to end, with a frame measured at each (`t` is that time, in ms); then they
 * finish, and a last frame is measured at rest. The same frames on any machine, however few it
 * would have painted. Layout only: nothing a ResizeObserver does in answer (the canvas's camera)
 * has run in the frames between.
 */
export function stepToggle(page: Page, selector: string, steps = 20): Promise<Toggle> {
  return toggle(page, selector, steps);
}

/**
 * Sends from the create page with `press` and holds everything the send set moving (the
 * composer's travel, the thread's pane opening, the hero leaving) where it starts, before a frame
 * is drawn, as `stepToggle` does: then `seekSend` puts them all at a share of the travel, and
 * `releaseSend` lets them finish. Says how long the travel is, in ms (0 if nothing travelled).
 */
export async function holdSend(page: Page, press: () => Promise<void>): Promise<number> {
  await page.evaluate(() => {
    const w = window as unknown as { heldSend: Animation[]; holdingSend: MutationObserver };
    w.heldSend = [];
    const catchAll = () => {
      for (const a of document.getAnimations()) {
        if (w.heldSend.includes(a) || a.playState === "finished") continue;
        // What turns for as long as it is shown (the working slice) is no part of the send.
        if (!Number.isFinite(Number(a.effect?.getComputedTiming().endTime))) continue;
        a.playbackRate = 0;
        w.heldSend.push(a);
      }
    };
    w.holdingSend = new MutationObserver(catchAll);
    w.holdingSend.observe(document.documentElement, {
      subtree: true,
      attributes: true,
      childList: true,
    });
  });
  await press();
  return page.evaluate(
    () =>
      new Promise<number>((resolve) =>
        setTimeout(() => {
          const w = window as unknown as { heldSend: Animation[]; holdingSend: MutationObserver };
          for (const a of document.getAnimations()) {
            if (w.heldSend.includes(a) || a.playState === "finished") continue;
            // What turns for as long as it is shown (the working slice) is no part of the send.
            if (!Number.isFinite(Number(a.effect?.getComputedTiming().endTime))) continue;
            a.playbackRate = 0;
            w.heldSend.push(a);
          }
          w.holdingSend.disconnect();
          const flight = w.heldSend.find((a) => a.id === "composer-flight");
          resolve(flight ? Number(flight.effect!.getComputedTiming().duration) : 0);
        }),
      ),
  );
}

/** Puts everything `holdSend` holds at `share` (0 to 1) of the travel's length. */
export function seekSend(page: Page, share: number): Promise<void> {
  return page.evaluate((share) => {
    const held = (window as unknown as { heldSend: Animation[] }).heldSend;
    const travel = held.find((a) => a.id === "composer-flight");
    const length = travel ? Number(travel.effect!.getComputedTiming().duration) : 0;
    for (const a of held) {
      if (a.playState === "idle") continue;
      const own = Number(a.effect!.getComputedTiming().endTime);
      a.currentTime = Math.min(length * share, own);
    }
  }, share);
}

/** Lets what `holdSend` holds run to its end. */
export function releaseSend(page: Page): Promise<void> {
  return page.evaluate(() => {
    for (const a of (window as unknown as { heldSend: Animation[] }).heldSend) {
      if (a.playState === "idle") continue;
      a.playbackRate = 1;
      if (a.playState !== "finished") a.finish();
    }
  });
}

/** A box on screen, in px. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where the travelling composer and its home are, in one frame. */
export interface SendFrame {
  surface: Box | null;
  attach: Box | null;
  send: Box | null;
  /** The thread's composer card, where it rests. */
  home: Box | null;
  /** How many travelling cards there are: one, while it travels. */
  surfaces: number;
}

export function sendFrame(page: Page): Promise<SendFrame> {
  return page.evaluate(() => {
    const r = (el: Element | null) => {
      if (!el) return null;
      const { x, y, width, height } = el.getBoundingClientRect();
      return { x, y, width, height };
    };
    return {
      surface: r(document.querySelector('[data-flight="surface"]')),
      attach: r(document.querySelector('[data-flight="attach"]')),
      send: r(document.querySelector('[data-flight="send"]')),
      home: r(document.querySelector("#thread [data-composer-card]")),
      surfaces: document.querySelectorAll('[data-flight="surface"]').length,
    };
  });
}

function toggle(page: Page, selector: string, steps: number): Promise<Toggle> {
  return page.evaluate(
    ([selector, steps]) =>
      new Promise<Toggle>((resolve, reject) => {
        const main = document.querySelector("main")!;
        const win = document.querySelector("header")!.parentElement!;
        const x = (el: Element | null | undefined) => el?.getBoundingClientRect().left ?? NaN;
        const dividers = () => document.querySelectorAll("header [data-chrome-divider]");
        const frames: Frame[] = [];
        const measure = (t = performance.now()) => {
          const box = main.getBoundingClientRect();
          const title = document.querySelector("[data-chrome-title]");
          const all = dividers();
          const board = document.querySelector("[data-artboard-host]")?.getBoundingClientRect();
          frames.push({
            t,
            left: box.left,
            right: box.right,
            divider: x(all[0]),
            railDivider: x(all[1]),
            tab: x(document.querySelector('header [role="tab"]')),
            thread: x(document.querySelector('header [aria-controls="thread"]')),
            title: title?.getBoundingClientRect().width ?? NaN,
            titleOpacity: title ? Number(getComputedStyle(title).opacity) : NaN,
            titleText: title?.firstElementChild?.getBoundingClientRect().width ?? NaN,
            boardX: board?.left ?? NaN,
            boardY: board?.top ?? NaN,
          });
        };

        type Transition = Animation & { transitionProperty: string };
        const clocks = new Map<Transition, Clock>();
        const name = (el: Element) => {
          if (el.id) return `#${el.id}`;
          for (const attr of ["data-chrome-title", "data-chrome-rail"]) {
            if (el.hasAttribute(attr)) return `[${attr}]`;
          }
          const tag = el.tagName.toLowerCase();
          const parent = el.parentElement;
          if (parent?.tagName === "HEADER") {
            const i = [...parent.children].indexOf(el);
            return `header > ${tag}${i === 0 ? ":first-child" : `:nth-child(${i + 1})`}`;
          }
          return tag;
        };
        /** Every new transition on what moves with a pane: noted, and held when stepping. */
        const catchClocks = () => {
          for (const animation of win.getAnimations({ subtree: true })) {
            if (!("transitionProperty" in animation)) continue;
            const a = animation as Transition;
            const target = (a.effect as KeyframeEffect | null)?.target;
            if (clocks.has(a) || !(target instanceof Element)) continue;
            if (!target.matches("[data-panel], .pane-motion")) continue;
            if (steps) a.playbackRate = 0;
            const timing = a.effect!.getComputedTiming();
            clocks.set(a, {
              target: name(target),
              property: a.transitionProperty,
              duration: Number(timing.duration),
              delay: Number(timing.delay ?? 0),
              easing: String(timing.easing),
            });
          }
        };
        // The press's changes land in its own task and the microtasks after it, before a frame:
        // looked at after each, so every transition is caught before it can have moved.
        const mo = new MutationObserver(catchClocks);
        mo.observe(win, { subtree: true, attributes: true, childList: true });
        const ro = new ResizeObserver(() => measure());
        // Whether the press has marked the window as easing yet. React renders the press in a
        // microtask after the click, so the mark comes after it, however briefly it stays.
        let marked = win.hasAttribute("data-pane-motion");
        const mark = new MutationObserver(() => {
          if (win.hasAttribute("data-pane-motion")) marked = true;
        });
        mark.observe(win, { attributes: true, attributeFilter: ["data-pane-motion"] });

        const rest = (end: number | null) => {
          const since = performance.now();
          const wait = () => {
            // Rested: the mark has come and gone again.
            if (!marked || win.hasAttribute("data-pane-motion")) {
              if (performance.now() - since > 10_000) {
                mo.disconnect();
                ro.disconnect();
                mark.disconnect();
                reject(
                  new Error(
                    marked
                      ? "The window still wears data-pane-motion 10s on."
                      : "The press never marked the window with data-pane-motion.",
                  ),
                );
              } else setTimeout(wait, 16);
              return;
            }
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                mo.disconnect();
                ro.disconnect();
                mark.disconnect();
                measure(end ?? performance.now());
                resolve({ frames, clocks: [...clocks.values()] });
              }),
            );
          };
          wait();
        };

        if (!steps) {
          measure();
          ro.observe(main);
        }
        (document.querySelector(selector) as HTMLElement).click();
        catchClocks();
        if (!steps) {
          rest(null);
          return;
        }
        setTimeout(() => {
          catchClocks();
          mo.disconnect();
          // Only those still live: one a later change replaced (cancelled) must stay gone.
          const live = new Set(win.getAnimations({ subtree: true }));
          const held = [...clocks.keys()].filter((a) => live.has(a));
          const panel = held.find((a) =>
            ((a.effect as KeyframeEffect).target as Element).matches("[data-panel]"),
          );
          const end = panel ? Number(panel.effect!.getComputedTiming().duration) : 0;
          for (let i = 0; panel && i <= steps; i++) {
            const t = (end * i) / steps;
            for (const a of held) a.currentTime = t;
            measure(t);
          }
          for (const a of held) {
            a.playbackRate = 1;
            if (a.playState !== "finished" && a.playState !== "idle") a.finish();
          }
          rest(end);
        });
      }),
    [selector, steps] as const,
  );
}

/** Where one piece of the chrome is in a frame of an arrival, and how opaque it is drawn. */
export interface Piece {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Its own opacity times every ancestor's: what the eye gets. */
  opacity: number;
}

/** A frame of an arrival: every piece of the chrome by its name (`button[Merge]`, `img[Sam]`…). */
export interface ArrivalFrame {
  t: number;
  pieces: Record<string, Piece>;
}

/** An animation an arrival made, by name, with its timing. */
export interface ArrivalClock {
  id: string;
  duration: number;
  delay: number;
  easing: string;
}

/**
 * Delivers a late answer in the gallery (`window.galleryArrive(part)`, which renders in one
 * commit) and walks the movement it starts on its own clock rather than the machine's, as
 * `stepToggle` does for a pane: every animation the arrival made (arrival.tsx names them
 * `arrival-…`) is held, then all are set together to `steps + 1` times evenly spaced from the
 * start to the end of the longest, with a frame measured at each. `before` is the frame just
 * before the answer; the last frame is at rest, once they have finished and what that does
 * (a piece that left, gone) has landed. `animations` are those that ran: none under reduced
 * motion, or where nothing needed to move.
 */
export function stepArrival(
  page: Page,
  part: string,
  steps = 20,
): Promise<{ before: ArrivalFrame; frames: ArrivalFrame[]; animations: ArrivalClock[] }> {
  return page.evaluate(
    ([part, steps]) => {
      const header = document.querySelector("header")!;
      const measure = (t: number): ArrivalFrame => {
        const pieces: Record<string, Piece> = {};
        const els = header.querySelectorAll<HTMLElement>(
          'button, [role="img"], [role="tab"], [data-chrome-divider], [data-chrome-title] > * > *',
        );
        for (const el of els) {
          // Not the room held for an action (unseen), and not the tooltips' own.
          if (el.closest('[aria-hidden="true"]') && !el.matches("[data-chrome-divider]")) continue;
          const label =
            el.getAttribute("aria-label") ??
            (el.textContent?.trim() || (el.hasAttribute("data-chrome-divider") ? "divider" : ""));
          let key = `${el.getAttribute("role") ?? el.tagName.toLowerCase()}[${label}]`;
          while (key in pieces) key += "'";
          const box = el.getBoundingClientRect();
          let opacity = 1;
          for (let at: Element | null = el; at; at = at.parentElement) {
            opacity *= Number(getComputedStyle(at).opacity);
          }
          pieces[key] = { x: box.x, y: box.y, width: box.width, height: box.height, opacity };
        }
        return { t, pieces };
      };
      const before = measure(-1);
      const known = new Set(document.getAnimations());
      (window as { galleryArrive?: (part: string) => void }).galleryArrive!(part);
      const made = document
        .getAnimations()
        .filter((a) => !known.has(a) && a.id.startsWith("arrival"));
      for (const a of made) a.pause();
      const timings = made.map((a) => a.effect!.getComputedTiming());
      const end = Math.max(0, ...timings.map((t) => Number(t.endTime)));
      const frames: ArrivalFrame[] = [];
      for (let i = 0; made.length && i <= steps; i++) {
        const t = (end * i) / steps;
        // Each held inside its own run, its last step a hair before its end.
        made.forEach((a, j) => {
          a.currentTime = Math.min(t, Number(timings[j]!.endTime) - 0.01);
        });
        frames.push(measure(t));
      }
      const animations = made.map((a, j) => ({
        id: a.id,
        duration: Number(timings[j]!.duration),
        delay: Number(timings[j]!.delay ?? 0),
        easing: String(timings[j]!.easing),
      }));
      for (const a of made) a.finish();
      return Promise.all(made.map((a) => a.finished.catch(() => {})))
        .then(() => new Promise((rest) => setTimeout(rest)))
        .then(() => {
          frames.push(measure(end));
          return { before, frames, animations };
        });
    },
    [part, steps] as const,
  );
}
