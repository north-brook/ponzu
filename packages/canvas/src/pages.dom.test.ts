import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ChromiumOptions, findChromium } from "@ponzu/render/chromium";

/*
 * Dragging page tabs along the bar to reorder them, in a real browser with a
 * real mouse. The source echoes each edit a moment later, as `ponzu serve`
 * does over its socket, so a drop that drew its tab back meanwhile shows.
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
import { emptyDoc } from "@ponzu/core";
import { Canvas } from "./Canvas.tsx";
import { MemorySource } from "./connection.ts";

class Echoing extends MemorySource {
  apply(op) {
    window.pzSent.push(op);
    setTimeout(() => super.apply(op), ${ECHO});
  }
}

window.pzMount = (names) => {
  const doc = emptyDoc("Pages");
  for (const name of names) doc.pages.push({ id: "pg_" + name, name, artboards: [] });
  window.pzSent = [];
  const source = new Echoing(doc);
  window.pzSource = source;
  createRoot(document.getElementById("host")).render(createElement(Canvas, { source }));
};
`;

describe.skipIf(!chromium)("reordering pages in Chromium", () => {
  let browser: Browser;
  let page: Page;
  let code: string;
  let css: string;

  beforeAll(async () => {
    const dir = import.meta.dir;
    const entry = join(dir, ".pages-entry.tsx");
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
    const out = join(tmpdir(), `pz-pages-${process.pid}.css`);
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

  const mount = async (names: string[]) => {
    page = await browser.newPage();
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.setContent(
      "<!doctype html><div id=host style='position:fixed;inset:0;display:flex'></div>",
    );
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: code, type: "module" });
    await page.waitForFunction(() => "pzMount" in window);
    await page.evaluate((n) => (window as any).pzMount(n), names);
    await page.waitForFunction(() => document.querySelectorAll("[data-page-tab]").length > 0);
  };

  /** A tab's box on screen. */
  const box = (name: string) =>
    page.evaluate((name) => {
      const r = document.querySelector(`[data-page-tab="${name}"]`)!.getBoundingClientRect();
      return { left: r.left, width: r.width, y: r.top + r.height / 2 };
    }, name);

  /** The tabs in the order the bar draws them, left to right, once they've slid there. */
  const drawn = async () => {
    await new Promise((r) => setTimeout(r, 250));
    return page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("[data-page-tab]")]
        .map((el) => ({ name: el.dataset.pageTab!, left: el.getBoundingClientRect().left }))
        .sort((a, b) => a.left - b.left)
        .map((t) => t.name),
    );
  };
  const docOrder = () =>
    page.evaluate(() =>
      (window as any).pzSource.getState().doc.pages.map((p: { name: string }) => p.name),
    );
  const sent = () => page.evaluate(() => (window as any).pzSent as unknown[]);
  const active = () =>
    page.evaluate(
      () =>
        document.querySelector<HTMLElement>('[data-page-tab][aria-current="page"]')?.dataset
          .pageTab,
    );

  /** Grabs a tab and drags it until its middle is `dx` screen px along, leaving the button down. */
  const dragBy = async (name: string, dx: number, steps = 8) => {
    const b = await box(name);
    const x = b.left + b.width / 2;
    await page.mouse.move(x, b.y);
    await page.mouse.down();
    for (let i = 1; i <= steps; i++) await page.mouse.move(x + (i * dx) / steps, b.y);
  };

  /** Each frame's left edge of a tab, for `ms` from now. */
  const watchLeft = (name: string, ms: number) =>
    page.evaluate(
      ([name, ms]) =>
        new Promise<number[]>((resolve) => {
          const xs: number[] = [];
          const end = performance.now() + (ms as number);
          const tick = () => {
            const el = document.querySelector(`[data-page-tab="${name}"]`);
            if (el) xs.push(el.getBoundingClientRect().left);
            if (performance.now() < end) requestAnimationFrame(tick);
            else resolve(xs);
          };
          tick();
        }),
      [name, ms] as const,
    );

  test("Escape puts a dragged tab back; a tab dragged past the others moves its page there, and stays put on the way", async () => {
    await mount(["One", "Two", "Three"]);
    const one = await box("One");
    const three = await box("Three");
    await dragBy("Three", one.left - three.left);
    expect(await drawn()).toEqual(["Three", "One", "Two"]);
    await page.keyboard.press("Escape");
    expect(await drawn()).toEqual(["One", "Two", "Three"]);
    await page.mouse.up();
    // That drag sent nothing: the one move sent below is the only one.
    const start = await box("One");
    const end = await box("Three");
    await dragBy("One", end.left + end.width - (start.left + start.width));
    // The others made room while it's held.
    expect(await drawn()).toEqual(["Two", "Three", "One"]);
    const watch = watchLeft("One", ECHO * 2);
    await page.mouse.up();
    const xs = await watch;
    // It never went back to the start before the document caught up.
    expect(Math.min(...xs)).toBeGreaterThan(start.left + start.width);
    expect(await docOrder()).toEqual(["Two", "Three", "One"]);
    expect(await drawn()).toEqual(["Two", "Three", "One"]);
    expect(await sent()).toEqual([{ op: "page.move", id: "pg_One", index: 2 }]);
    // Where it was dropped is where the reordered bar draws it.
    expect(Math.round((await box("One")).left)).toBe(Math.round(xs.at(-1)!));
    // The page on screen was the first; it stays on screen now that another is.
    expect(await active()).toBe("One");
    await page.close();
  });

  test("dropping a tab doesn't open its page; clicking one does", async () => {
    await mount(["One", "Two", "Three"]);
    expect(await active()).toBe("One");
    const two = await box("Two");
    const three = await box("Three");
    await dragBy("Two", three.left + three.width - (two.left + two.width));
    await page.mouse.up();
    await page.waitForFunction(
      () => (window as any).pzSource.getState().doc.pages[2].name === "Two",
    );
    expect(await active()).toBe("One");
    const b = await box("Three");
    await page.mouse.click(b.left + b.width / 2, b.y);
    expect(await active()).toBe("Three");
    await page.close();
  });
});
