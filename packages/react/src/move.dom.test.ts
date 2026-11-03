import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ChromiumOptions, findChromium } from "@ponzu/render/chromium";

/*
 * Dragging artboards by their titles, in a real browser with a real mouse.
 * The source echoes each edit a moment later, as `ponzu serve` does over its
 * socket, so a drop that drew its board back where it was meanwhile shows.
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

/** Milliseconds the source takes to echo an edit. */
const ECHO = 400;

const ENTRY = `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { emptyDoc, parseArtboardFile } from "@ponzu/core";
import { Canvas } from "./Canvas.tsx";
import { MemorySource } from "./connection.ts";

class Echoing extends MemorySource {
  apply(op) {
    // A lost connection: the edit never comes back.
    if (window.pzLost) return;
    setTimeout(() => super.apply(op), ${ECHO});
  }
}

window.pzMount = (boards) => {
  const doc = emptyDoc("Moves");
  const artboards = boards.map(([id, x, y]) => {
    const { artboard } = parseArtboardFile(
      '<section data-artboard data-id="' + id + '" data-name="' + id + '" style="width:200px;height:200px"></section>',
      { id, name: id },
    );
    return { ...artboard, x, y };
  });
  doc.pages.push({ id: "pg_a", name: "Page", artboards });
  const source = new Echoing(doc);
  window.pzSource = source;
  const host = document.getElementById("host");
  createRoot(host).render(createElement(Canvas, { source }));
};
`;

describe.skipIf(!chromium)("moving artboards in Chromium", () => {
  let browser: Browser;
  let page: Page;
  let code: string;
  let css: string;

  beforeAll(async () => {
    const dir = import.meta.dir;
    const entry = join(dir, ".move-entry.tsx");
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
    // The canvas's own stylesheet: unstyled, its plane and boards don't lay out.
    const out = join(tmpdir(), `pz-move-${process.pid}.css`);
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

  /** A fresh canvas with these boards, as [id, x, y]. */
  const mount = async (boards: [string, number, number][]) => {
    page = await browser.newPage();
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.setContent(
      "<!doctype html><div id=host style='position:fixed;inset:0;display:flex'></div>",
    );
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: code, type: "module" });
    await page.waitForFunction(() => "pzMount" in window);
    await page.evaluate((b) => (window as any).pzMount(b), boards);
    await page.waitForFunction(() => document.querySelectorAll("[data-board-name]").length > 0);
  };

  /** Where a board's title is drawn, in page px, read from its style. */
  const drawnAt = (id: string) =>
    page.evaluate((id) => {
      const el = document.querySelector(`[data-board-name][title="${id}"]`)!.parentElement!
        .parentElement as HTMLElement;
      const n = (s: string) => Number(/\*\s*(-?[\d.]+)px/.exec(s)?.[1]);
      return { x: n(el.style.left), y: n(el.style.top) };
    }, id);

  /** Where the document has a board. */
  const docAt = (id: string) =>
    page.evaluate((id) => {
      const ab = (window as any).pzSource
        .getState()
        .doc.pages[0].artboards.find((a: any) => a.id === id);
      return { x: ab.x, y: ab.y };
    }, id);

  /** The screen point of a board's title, to grab it by. */
  const titlePoint = (id: string) =>
    page.evaluate((id) => {
      const r = document.querySelector(`[data-board-name][title="${id}"]`)!.getBoundingClientRect();
      return { x: r.left + Math.min(r.width / 2, 8), y: r.top + r.height / 2 };
    }, id);

  /** Camera zoom: screen px per page px. */
  const zoom = () =>
    page.evaluate(() => {
      const el = document.querySelector("[data-board-name]")!.parentElement!.parentElement!;
      return Number.parseFloat(getComputedStyle(el).getPropertyValue("--z")) || 1;
    });

  /** Every x a board's title is drawn at, frame by frame, for `ms` from now. */
  const watchX = (id: string, ms: number) =>
    page.evaluate(
      ([id, ms]) =>
        new Promise<number[]>((resolve) => {
          const el = document.querySelector(`[data-board-name][title="${id}"]`)!.parentElement!
            .parentElement as HTMLElement;
          const xs: number[] = [];
          const end = performance.now() + (ms as number);
          const tick = () => {
            xs.push(Number(/\*\s*(-?[\d.]+)px/.exec(el.style.left)?.[1]));
            if (performance.now() < end) requestAnimationFrame(tick);
            else resolve(xs);
          };
          tick();
        }),
      [id, ms] as const,
    );

  /** Grabs a board by its title and drags it by (dx, dy) page px, leaving the button down. */
  const dragBy = async (id: string, dx: number, dy = 0, steps = 5) => {
    const z = await zoom();
    const p = await titlePoint(id);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    for (let i = 1; i <= steps; i++)
      await page.mouse.move(p.x + (i * dx * z) / steps, p.y + (i * dy * z) / steps);
  };

  /** Waits until the document has a board at x. */
  const docReaches = (id: string, x: number) =>
    page.waitForFunction(
      ([id, x]) =>
        (window as any).pzSource.getState().doc.pages[0].artboards.find((a: any) => a.id === id)
          .x === x,
      [id, x] as const,
    );

  test("a dropped board stays where it was dropped while the move is on its way", async () => {
    await mount([["ab_a", 0, 0]]);
    await dragBy("ab_a", 300, 0, 10);
    const dropped = await drawnAt("ab_a");
    expect(dropped.x).toBeGreaterThan(250);
    // Watch every frame from the drop until well after the echo.
    const watch = watchX("ab_a", ECHO * 2);
    await page.mouse.up();
    const xs = await watch;
    expect(Math.min(...xs)).toBe(dropped.x);
    expect(await docAt("ab_a")).toEqual({ x: dropped.x, y: 0 });
    expect(await drawnAt("ab_a")).toEqual({ x: dropped.x, y: 0 });
    await page.close();
  });

  test("dragging another board doesn't let a drop on its way go", async () => {
    await mount([
      ["ab_a", 0, 0],
      ["ab_b", 0, 600],
    ]);
    await dragBy("ab_a", 300);
    const dropped = (await drawnAt("ab_a")).x;
    await page.mouse.up();
    const watch = watchX("ab_a", ECHO * 2);
    await dragBy("ab_b", 500);
    await page.mouse.up();
    expect(Math.min(...(await watch))).toBe(dropped);
    await docReaches("ab_a", dropped);
    await page.close();
  });

  test("a board dropped twice holds its second drop through the first one's echo", async () => {
    await mount([["ab_a", 0, 0]]);
    await dragBy("ab_a", 300);
    await page.mouse.up();
    // Grabbed again before the first move comes back, and dropped further on.
    await dragBy("ab_a", 300);
    const second = (await drawnAt("ab_a")).x;
    expect(second).toBeGreaterThan(550);
    const watch = watchX("ab_a", ECHO * 2);
    await page.mouse.up();
    expect(Math.min(...(await watch))).toBe(second);
    await docReaches("ab_a", second);
    expect(await drawnAt("ab_a")).toEqual({ x: second, y: 0 });
    await page.close();
  });

  test("a drop whose move never comes back goes back to where the document has it", async () => {
    await mount([["ab_a", 0, 0]]);
    await page.evaluate(() => {
      (window as any).pzLost = true;
    });
    await dragBy("ab_a", 300);
    const dropped = (await drawnAt("ab_a")).x;
    await page.mouse.up();
    expect((await drawnAt("ab_a")).x).toBe(dropped);
    // Held for two seconds, then the document's position shows.
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-board-name][title="ab_a"]')!.parentElement!
          .parentElement as HTMLElement;
        return /\*\s*0px/.test(el.style.left);
      },
      undefined,
      { timeout: 4000 },
    );
    await page.close();
  });

  test("a release right after the last move drops where that move put the board", async () => {
    await mount([["ab_a", 0, 0]]);
    await dragBy("ab_a", 100);
    const z = await zoom();
    // The last move and the release in one task: nothing renders between them.
    await page.evaluate((z) => {
      const title = document.querySelector('[data-board-name][title="ab_a"]')!;
      const r = title.getBoundingClientRect();
      const at = { clientX: r.left + 8 + 200 * z, clientY: r.top + r.height / 2 };
      const opts = { bubbles: true, pointerId: 1, pointerType: "mouse", isPrimary: true, ...at };
      title.dispatchEvent(new PointerEvent("pointermove", { ...opts, buttons: 1 }));
      title.dispatchEvent(new PointerEvent("pointerup", { ...opts, button: 0 }));
    }, z);
    await docReaches("ab_a", 300);
    await page.close();
  });

  test("shift holds a drag to the axis it went furthest along", async () => {
    await mount([["ab_a", 0, 0]]);
    const z = await zoom();
    const p = await titlePoint("ab_a");
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.keyboard.down("Shift");
    for (let i = 1; i <= 10; i++)
      await page.mouse.move(p.x + (i * 400 * z) / 10, p.y + (i * 90 * z) / 10);
    const held = await drawnAt("ab_a");
    expect(held.y).toBe(0);
    expect(held.x).toBeGreaterThan(350);
    // Letting go of shift mid-drag frees the other axis at once.
    await page.keyboard.up("Shift");
    expect((await drawnAt("ab_a")).y).toBeGreaterThan(60);
    await page.keyboard.down("Shift");
    await page.mouse.up();
    await page.keyboard.up("Shift");
    await page.waitForFunction(() => {
      const ab = (window as any).pzSource.getState().doc.pages[0].artboards[0];
      return ab.x !== 0;
    });
    expect((await docAt("ab_a")).y).toBe(0);
    await page.close();
  });

  test("a board dragged near another's edge snaps to it", async () => {
    await mount([
      ["ab_a", 0, 0],
      ["ab_b", 400, 300],
    ]);
    const z = await zoom();
    const p = await titlePoint("ab_a");
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    // To x 397: three short of b's left edge.
    for (let i = 1; i <= 10; i++) await page.mouse.move(p.x + (i * 397 * z) / 10, p.y);
    expect((await drawnAt("ab_a")).x).toBe(400);
    // ⌘ lets it go where the pointer is.
    await page.keyboard.down("Meta");
    await page.mouse.move(p.x + 397 * z + 0.1, p.y);
    expect((await drawnAt("ab_a")).x).toBeCloseTo(397, 0);
    await page.keyboard.up("Meta");
    await page.mouse.move(p.x + 397 * z, p.y);
    await page.mouse.up();
    await page.waitForFunction(() => {
      const ab = (window as any).pzSource.getState().doc.pages[0].artboards[0];
      return ab.x !== 0;
    });
    expect((await docAt("ab_a")).x).toBe(400);
    await page.close();
  });
});
