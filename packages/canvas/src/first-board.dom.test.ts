import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ChromiumOptions, findChromium } from "@ponzu/render/chromium";

/*
 * An empty design's first board, in a real browser: the canvas waits at 100% where the board will
 * land, the board arrives with the canvas's own arrival (frame, then sheet), and nothing jumps:
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
  window.pzSource.agent({ op: "artboard.create", page: "pg_a", index: 0, artboard: { ...artboard, x, y } });
};

/** Every frame from now: the zoom, the plane's transform, and where the board and its frame are. */
window.pzWatch = () => {
  const frames = [];
  window.pzFrames = frames;
  const step = () => {
    const zoom = [...document.querySelectorAll("button, span")].map((e) => e.textContent).find((t) => /^\\d+%$/.test(t ?? ""));
    const sheet = document.querySelector("[data-pz-board]");
    const frame = document.querySelector("svg rect[pathLength]");
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
    frames.push({
      zoom,
      sheet: box(sheet),
      frame: frame ? { ...box(frame.ownerSVGElement), dash: getComputedStyle(frame).strokeDashoffset, opacity: getComputedStyle(frame).opacity } : null,
    });
    if (frames.length < 120) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
};
`;

describe.skipIf(!chromium)("an empty design's first board in Chromium", () => {
  let browser: Browser;
  let page: Page;
  let code: string;
  let css: string;

  beforeAll(async () => {
    const dir = import.meta.dir;
    const entry = join(dir, ".first-board-entry.tsx");
    await Bun.write(entry, ENTRY);
    const built = await Bun.build({
      entrypoints: [entry],
      target: "browser",
      format: "esm",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    await Bun.file(entry).delete();
    if (!built.success) throw new AggregateError(built.logs, "bundle failed");
    code = await built.outputs[0]!.text();
    const out = join(tmpdir(), `pz-first-${process.pid}.css`);
    const tw = Bun.spawnSync(
      [join(dir, "../node_modules/.bin/tailwindcss"), "-i", join(dir, "styles.css"), "-o", out],
      { stderr: "pipe" },
    );
    if (tw.exitCode !== 0) throw new Error(tw.stderr.toString());
    css = await Bun.file(out).text();
    await Bun.file(out).delete();
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
    await new Promise((r) => setTimeout(r, 300));
    await page.evaluate(() => (window as any).pzWatch());
    await new Promise((r) => setTimeout(r, 100));
    await page.evaluate(() => (window as any).pzCreate(0, 0));
    await page.waitForFunction(() => (window as any).pzFrames.length >= 120);
    const frames = (await page.evaluate(() => (window as any).pzFrames)) as {
      zoom?: string;
      sheet: { x: number; y: number; w: number; h: number } | null;
      frame: { x: number; y: number; dash: string; opacity: string } | null;
    }[];
    // Before and after, at 100%: the empty page waited where the board fits.
    expect(frames.map((f) => f.zoom)).toEqual(frames.map(() => "100%"));
    // From its first frame on screen the board stays put: no camera move after it lands.
    const placed = frames.filter((f) => f.sheet);
    expect(placed.length).toBeGreaterThan(60);
    expect(new Set(placed.map((f) => `${f.sheet!.x},${f.sheet!.y}`)).size).toBe(1);
    // The frame that draws it in is round the board's own place, from its first frame, and it
    // starts drawing only after the board landed, then draws on.
    const sheet = placed[0]!.sheet!;
    for (const f of placed) expect(f.frame).toMatchObject({ x: sheet.x - 4, y: sheet.y - 4 });
    expect(placed[0]!.frame!.dash).toBe("100px");
    expect(Number.parseFloat(placed.at(-1)!.frame!.dash)).toBeLessThan(5);
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
    await new Promise((r) => setTimeout(r, 200));
    await page.evaluate(() => (window as any).pzCreate(0, 0));
    await new Promise((r) => setTimeout(r, 600));
    // The person zooms in and pans away from where the board landed.
    await page.mouse.move(600, 400);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -60);
    await page.keyboard.up("Control");
    await new Promise((r) => setTimeout(r, 300));
    await page.mouse.wheel(240, 160);
    await new Promise((r) => setTimeout(r, 300));
    const camera = () =>
      page.evaluate(() => {
        const zoom = [...document.querySelectorAll("button, span")]
          .map((e) => e.textContent)
          .find((t) => /^\d+%$/.test(t ?? ""));
        const r = document.querySelector("[data-pz-board]")?.getBoundingClientRect();
        return { zoom, at: r ? `${Math.round(r.left)},${Math.round(r.top)}` : null };
      });
    const before = await camera();
    expect(before.zoom).not.toBe("100%");
    await page.evaluate(() =>
      (window as any).pzSource.apply({ op: "artboard.delete", id: "ab_card" }),
    );
    await new Promise((r) => setTimeout(r, 200));
    const empty = await camera();
    expect(empty.at).toBeNull();
    expect(empty.zoom).toBe(before.zoom);
    await page.evaluate(() => (window as any).pzSource.undo());
    await new Promise((r) => setTimeout(r, 300));
    expect(await camera()).toEqual(before);
    await page.close();
  });
});
