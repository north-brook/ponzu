import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { dirname } from "node:path";
import { type ChromiumOptions, findChromium } from "@ponzu/render/chromium";
import { ARRIVE_LAG_MS } from "./arrive.ts";
import { bundle, canvasCss } from "./dom-lib.ts";

/*
 * An empty canvas's first board, in a real browser: the view waits at 100% where the board will
 * land, the board arrives with the view's own arrival (frame, then sheet), and nothing jumps:
 * the zoom reads 100% throughout, the camera doesn't move once the board is on screen, and
 * nothing yuzu is drawn anywhere but round the board's own place.
 */

type Page = Parameters<NonNullable<ChromiumOptions["preparePage"]>>[0];
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };
const { chromium: playwright } = (await import(
  Bun.resolveSync(
    "playwright-core",
    dirname(Bun.resolveSync("@ponzu/render/chromium", import.meta.dir)),
  )
)) as { chromium: { launch(o: object): Promise<Browser> } };
const chromium = findChromium();
setDefaultTimeout(30_000);

const ENTRY = `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { emptyDoc, parseArtboardFile } from "@ponzu/core";
import { Canvas } from "./Canvas.tsx";
import { MemorySource } from "./connection.ts";

/** Ops an agent makes, heard by onOp as the cloud source tells them. */
class Agent extends MemorySource {
  ops = new Set();
  onOp(l) { this.ops.add(l); return () => this.ops.delete(l); }
  agent(op) {
    for (const l of this.ops) l(op, { kind: "agent", name: "Claude" }, this.getState().doc);
    this.apply(op);
  }
}

window.pzMount = () => {
  const doc = emptyDoc("First");
  doc.pages.push({ id: "pg_a", name: "Page 1", artboards: [] });
  const source = new Agent(doc);
  window.pzSource = source;
  createRoot(document.getElementById("host")).render(createElement(Canvas, { source }));
};

window.pzCreate = (x, y) => {
  const { artboard } = parseArtboardFile(
    '<section data-artboard data-id="ab_card" data-name="Hello card" style="width:320px;height:200px;background:#fff6b3"><h1>Hello</h1></section>',
    { id: "ab_card", name: "Hello card" },
  );
  window.pzLanded = performance.now();
  window.pzSource.agent({ op: "artboard.create", page: "pg_a", index: 0, artboard: { ...artboard, x, y } });
};

/**
 * Where the frame's draw starts on performance.now()'s clock, however late it mounts: when the
 * draw was set going, less how far into it that was. Read as it's set, so it's never later than
 * the start the canvas asked for.
 */
const time = Object.getOwnPropertyDescriptor(Animation.prototype, "currentTime");
Object.defineProperty(Animation.prototype, "currentTime", {
  ...time,
  set(t) {
    if (this.effect?.target?.matches("svg rect[pathLength]")) window.pzDrawFrom ??= performance.now() - t;
    time.set.call(this, t);
  },
});

/**
 * Every frame from now until the board's frame has drawn and faded: the zoom, where the board and
 * its frame are, and how far into its draw the frame is, on its animation's own time.
 */
window.pzWatch = () => {
  const frames = [];
  window.pzFrames = frames;
  const step = () => {
    const zoom = [...document.querySelectorAll("button, span")].map((e) => e.textContent).find((t) => /^\\d+%$/.test(t ?? ""));
    const sheet = document.querySelector("[data-pz-board]");
    const frame = document.querySelector("svg rect[pathLength]");
    const draw = frame?.getAnimations()[0];
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
    frames.push({
      zoom,
      sheet: box(sheet),
      frame: frame ? { ...box(frame.ownerSVGElement), dash: getComputedStyle(frame).strokeDashoffset, opacity: getComputedStyle(frame).opacity, t: draw?.currentTime ?? null, done: draw?.playState === "finished" } : null,
    });
    window.pzDone = !!frames.at(-1).frame?.done || frames.length >= 240;
    if (!window.pzDone) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
};

/** The frame's draw, held at \`t\` ms in: how much of the line is still undrawn there. */
window.pzDashAt = (t) => {
  const frame = document.querySelector("svg rect[pathLength]");
  const draw = frame.getAnimations()[0];
  draw.pause();
  draw.currentTime = t;
  return getComputedStyle(frame).strokeDashoffset;
};
`;

/**
 * Waits for the canvas to come to rest: a zoom shown, and the zoom, every board's place and the
 * count of finite animations still running (none) the same over four frames in a row. A wait on
 * the camera, not on time: a slow machine changes how long it takes, never what it finds.
 */
const settled = (page: Page) =>
  page.waitForFunction(
    () => {
      const w = window as any;
      const zoom = [...document.querySelectorAll("button, span")]
        .map((e) => e.textContent)
        .find((t) => /^\d+%$/.test(t ?? ""));
      const boards = [...document.querySelectorAll("[data-pz-board]")].map((el) => {
        const r = el.getBoundingClientRect();
        return `${r.left},${r.top},${r.width},${r.height}`;
      });
      const moving = document
        .getAnimations()
        .filter(
          (a) => a.playState === "running" && a.effect?.getComputedTiming().endTime !== Infinity,
        ).length;
      const now = `${zoom}|${boards.join(";")}|${moving}`;
      if (moving === 0 && now === w.pzRest?.last) w.pzRest.same++;
      else w.pzRest = { last: now, same: 0 };
      return zoom !== undefined && w.pzRest.same >= 3;
    },
    undefined,
    { polling: "raf" },
  );

describe.skipIf(!chromium)("an empty canvas's first board in Chromium", () => {
  let browser: Browser;
  let page: Page;
  let code: string;
  let css: string;

  beforeAll(async () => {
    [code, css] = await Promise.all([
      bundle("first-board", ENTRY, { "process.env.NODE_ENV": '"production"' }),
      canvasCss(),
    ]);
    browser = await playwright.launch({ executablePath: chromium!, headless: true });
  });
  afterAll(() => browser?.close());

  test("waits at 100% and the board arrives where the camera already is", async () => {
    page = await browser.newPage();
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.setContent(
      "<!doctype html><div id=host style='position:fixed;inset:0;display:flex'></div>",
    );
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: code, type: "module" });
    await page.waitForFunction(() => "pzMount" in window);
    await page.evaluate(() => (window as any).pzMount());
    await settled(page);
    await page.evaluate(() => (window as any).pzWatch());
    // A few frames of the empty page are watched before the board lands.
    await page.waitForFunction(() => (window as any).pzFrames.length >= 6);
    await page.evaluate(() => (window as any).pzCreate(0, 0));
    await page.waitForFunction(() => (window as any).pzDone);
    const frames = (await page.evaluate(() => (window as any).pzFrames)) as {
      zoom?: string;
      sheet: { x: number; y: number; w: number; h: number } | null;
      frame: {
        x: number;
        y: number;
        dash: string;
        opacity: string;
        t: number | null;
        done: boolean;
      } | null;
    }[];
    // Before and after, at 100%: the empty page waited where the board fits.
    expect(frames.map((f) => f.zoom)).toEqual(frames.map(() => "100%"));
    // From its first frame on screen until its frame has drawn and faded, the board stays put: no
    // camera move after it lands.
    const placed = frames.filter((f) => f.sheet);
    expect(placed.at(-1)!.frame?.done).toBe(true);
    expect(new Set(placed.map((f) => `${f.sheet!.x},${f.sheet!.y}`)).size).toBe(1);
    // The frame that draws it in is round the board's own place, from its first frame, and draws
    // on to the end.
    const sheet = placed[0]!.sheet!;
    for (const f of placed) expect(f.frame).toMatchObject({ x: sheet.x - 4, y: sheet.y - 4 });
    expect(Number.parseFloat(placed.at(-1)!.frame!.dash)).toBeLessThan(5);
    // It starts drawing only a beat after the board landed (less a hair for floating point),
    // however late it mounts, and nothing of it is drawn until then.
    const { landed, from } = await page.evaluate(() => ({
      landed: (window as any).pzLanded as number,
      from: (window as any).pzDrawFrom as number,
    }));
    expect(from - landed).toBeGreaterThanOrEqual(ARRIVE_LAG_MS - 0.001);
    for (const f of placed) if (f.frame!.t! <= 0) expect(f.frame!.dash).toBe("100px");
    expect(await page.evaluate(() => (window as any).pzDashAt(0))).toBe("100px");
    // Nothing of it is drawn before the board is there.
    expect(frames.filter((f) => !f.sheet).every((f) => f.frame === null)).toBe(true);
    await page.close();
  });

  test("deleting a page's last board and undoing it leaves the camera where the person put it", async () => {
    page = await browser.newPage();
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.setContent(
      "<!doctype html><div id=host style='position:fixed;inset:0;display:flex'></div>",
    );
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: code, type: "module" });
    await page.waitForFunction(() => "pzMount" in window);
    await page.evaluate(() => (window as any).pzMount());
    await settled(page);
    await page.evaluate(() => (window as any).pzCreate(0, 0));
    await page.waitForFunction(() => document.querySelector("[data-pz-board]") !== null);
    await settled(page);
    const camera = () =>
      page.evaluate(() => {
        const zoom = [...document.querySelectorAll("button, span")]
          .map((e) => e.textContent)
          .find((t) => /^\d+%$/.test(t ?? ""));
        const r = document.querySelector("[data-pz-board]")?.getBoundingClientRect();
        return { zoom, at: r ? `${Math.round(r.left)},${Math.round(r.top)}` : null };
      });
    // The person zooms in and pans away from where the board landed.
    await page.mouse.move(600, 400);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -60);
    await page.keyboard.up("Control");
    await page.waitForFunction(() =>
      [...document.querySelectorAll("button, span")].some(
        (e) => /^\d+%$/.test(e.textContent ?? "") && e.textContent !== "100%",
      ),
    );
    await settled(page);
    const zoomed = await camera();
    await page.mouse.wheel(240, 160);
    await page.waitForFunction((at) => {
      const r = document.querySelector("[data-pz-board]")!.getBoundingClientRect();
      return `${Math.round(r.left)},${Math.round(r.top)}` !== at;
    }, zoomed.at);
    await settled(page);
    const before = await camera();
    expect(before.zoom).not.toBe("100%");
    await page.evaluate(() =>
      (window as any).pzSource.apply({ op: "artboard.delete", id: "ab_card" }),
    );
    await page.waitForFunction(() => document.querySelector("[data-pz-board]") === null);
    await settled(page);
    const empty = await camera();
    expect(empty.at).toBeNull();
    expect(empty.zoom).toBe(before.zoom);
    await page.evaluate(() => (window as any).pzSource.undo());
    await page.waitForFunction(() => document.querySelector("[data-pz-board]") !== null);
    await settled(page);
    expect(await camera()).toEqual(before);
    await page.close();
  });
});
