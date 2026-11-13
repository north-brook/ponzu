import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type ChromiumOptions, findChromium } from "@ponzu/render/chromium";
import { launchChromium, type TestChromium } from "@ponzu/render/testing";
import { bundle, canvasCss } from "./dom-lib.ts";

/*
 * The footer's controls in a real browser. With page tabs in the footer, the tools and the zoom
 * share one bar at the bottom right. Without them (the Mac app's canvas, whose chrome has the
 * tabs), the tools stand at the bottom left and the zoom alone at the bottom right, each 10 px
 * in from the pane's edges as the boards draw them, and they still do what they did.
 */

type Page = Parameters<NonNullable<ChromiumOptions["preparePage"]>>[0];
const chromium = findChromium();
setDefaultTimeout(30_000);

const ENTRY = `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { emptyDoc, parseArtboardFile } from "@ponzu/core";
import { Canvas } from "./Canvas.tsx";
import { MemorySource } from "./connection.ts";

window.pzMount = (props) => {
  const doc = emptyDoc("Controls");
  const { artboard } = parseArtboardFile(
    '<section data-artboard data-id="ab_a" data-name="Home" style="width:400px;height:300px"></section>',
    { id: "ab_a", name: "Home" },
  );
  doc.pages.push({ id: "pg_a", name: "Home", artboards: [artboard] });
  createRoot(document.getElementById("host")).render(
    createElement(Canvas, { source: new MemorySource(doc), ...props }),
  );
};
`;

describe.skipIf(!chromium)("the canvas's controls in Chromium", () => {
  let browser: TestChromium;
  let page: Page;
  let code: string;
  let css: string;

  beforeAll(async () => {
    [code, css] = await Promise.all([
      bundle("controls", ENTRY, { "process.env.NODE_ENV": '"production"' }),
      canvasCss(),
    ]);
    browser = await launchChromium(chromium!);
  });
  afterAll(() => browser?.close());

  const mount = async (props: Record<string, unknown>) => {
    page = await browser.newPage();
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.setContent(
      "<!doctype html><div id=host style='position:fixed;inset:0;display:flex'></div>",
    );
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: code, type: "module" });
    await page.waitForFunction(() => "pzMount" in window);
    await page.evaluate((p) => (window as any).pzMount(p), props);
    await page.waitForSelector('[role="toolbar"]');
  };

  /** Each toolbar: its name, its box, and the names of the controls in it. */
  const bars = () =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[role="toolbar"]')].map((el) => {
        const r = el.getBoundingClientRect();
        return {
          name: el.getAttribute("aria-label"),
          left: r.left,
          right: innerWidth - r.right,
          bottom: innerHeight - r.bottom,
          controls: [...el.querySelectorAll("button")].map((b) => b.getAttribute("aria-label")),
        };
      }),
    );
  const checked = () =>
    page.evaluate(() =>
      document.querySelector('[role="toolbar"] [aria-checked="true"]')?.getAttribute("aria-label"),
    );
  const percent = () =>
    page.evaluate(() => document.querySelector('[aria-label="Zoom to fit"]')!.textContent);

  test("without page tabs, the tools stand bottom left and the zoom alone bottom right, and do what they did", async () => {
    await mount({ pageBar: false });
    const [tools, zoom, ...rest] = await bars();
    expect(rest).toEqual([]);
    expect(tools).toMatchObject({
      name: "Tools",
      left: 10,
      bottom: 10,
      controls: ["Select", "Hand", "Comment"],
    });
    expect(zoom).toMatchObject({
      name: "Zoom",
      right: 10,
      bottom: 10,
      controls: ["Zoom out", "Zoom to fit", "Zoom in"],
    });
    // Each its own frosted surface: 12 round, 4 in, its own shadow.
    const look = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[role="toolbar"]')].map((el) => {
        const s = getComputedStyle(el);
        return [s.borderRadius, s.padding, s.boxShadow !== "none"];
      }),
    );
    expect(look).toEqual([
      ["12px", "4px", true],
      ["12px", "4px", true],
    ]);

    // Apart, the tools and the zoom do what they did.
    expect(await checked()).toBe("Select");
    // Clicks and the shortcuts both pick a tool; the comment tool stays armed.
    await page.click('[aria-label="Hand"]');
    expect(await checked()).toBe("Hand");
    await page.keyboard.press("c");
    expect(await checked()).toBe("Comment");
    await page.keyboard.press("v");
    expect(await checked()).toBe("Select");
    await page.click('[aria-label="Comment"]');
    expect(await checked()).toBe("Comment");

    const fit = await percent();
    await page.click('[aria-label="Zoom in"]');
    await page.waitForFunction(
      (was) => document.querySelector('[aria-label="Zoom to fit"]')!.textContent !== was,
      fit,
    );
    const zoomedIn = await percent();
    expect(Number.parseInt(zoomedIn!, 10)).toBeGreaterThan(Number.parseInt(fit!, 10));
    await page.click('[aria-label="Zoom out"]');
    await page.click('[aria-label="Zoom out"]');
    await page.waitForFunction(
      (was) =>
        Number.parseInt(document.querySelector('[aria-label="Zoom to fit"]')!.textContent!, 10) <
        Number.parseInt(was, 10),
      fit!,
    );
    // The percentage fits the page again.
    await page.click('[aria-label="Zoom to fit"]');
    await page.waitForFunction(
      (was) => document.querySelector('[aria-label="Zoom to fit"]')!.textContent === was,
      fit,
    );

    // A tool's tip names it with its shortcut.
    await page.hover('[aria-label="Hand"]');
    const tip = await page.waitForSelector('[data-slot="tip"]');
    expect((await tip.textContent())?.replace(/\s+/g, "")).toBe("HandH");
  });

  test("beside page tabs, the tools and the zoom keep one bar at the bottom right", async () => {
    await mount({});
    const all = await bars();
    expect(all.map((b) => b.name)).toEqual(["Pages", "Controls"]);
    expect(all[1]).toMatchObject({
      right: 10,
      bottom: 10,
      controls: ["Select", "Hand", "Comment", "Zoom out", "Zoom to fit", "Zoom in"],
    });
  });
});
