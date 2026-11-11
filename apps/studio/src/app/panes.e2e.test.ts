/*
 * The window's side panes, resized by hand: the studio built as it ships, in a real Chromium, on
 * Ponzu Cloud in memory (fake-host.ts), with a design open so both the sidebar and the thread
 * rail are there. Dragging an edge moves its pane within its limits and the chrome with it in the
 * same frame, over the canvas's frames too; the arrow keys and a double-click move it; the toggles
 * still collapse and expand it, back to the width it was left at; a small window keeps the canvas
 * room; and the widths come back after a reload. Skips where there is no Chrome or Chromium.
 *
 * With PONZU_SHOTS set to a folder, it leaves pictures of an edge at rest, hovered, dragged and
 * focused there, in light and dark.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromiumPath, launch, type Page } from "../../scripts/visual-lib.ts";
import { PANES } from "../cloud/window/panes.ts";
import { buildApp, serve, waitUntil } from "./e2e-lib.ts";

setDefaultTimeout(120_000);

const SHOTS = process.env.PONZU_SHOTS;
const WIDTH = 1440;
const HEIGHT = 900;
/** Where the pointer takes hold of an edge, down the window. */
const GRIP_Y = 420;

describe.skipIf(!chromiumPath)("the side panes, resized by hand", () => {
  let dir: string;
  let server: ReturnType<typeof serve>;
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];

  beforeAll(async () => {
    dir = await buildApp("e2e");
    server = serve(dir);
    browser = await launch();
    page = await browser.newPage();
    await page.setViewportSize({ width: WIDTH, height: HEIGHT });
    await page.emulateMedia({ colorScheme: "light" });
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(server.url);
    await openTheDesign(page);
    await measureEachMove(page);
  });
  afterAll(async () => {
    await browser?.close();
    server?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const shoot = async (
    name: string,
    clip?: { x: number; y: number; width: number; height: number },
  ) => {
    if (!SHOTS) return;
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `${name}.png`), ...(clip ? { clip } : {}) });
  };
  /** Both themes of the window as it stands, and a close look at the edge in each. */
  const shootBoth = async (name: string, edgeX: number) => {
    if (!SHOTS) return;
    const clip = { x: edgeX - 120, y: 0, width: 240, height: 260 };
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      // Past the controls' own colour easing.
      await page.waitForTimeout(300);
      await shoot(`${name}-${theme}`);
      await shoot(`${name}-${theme}-close`, clip);
    }
    await page.emulateMedia({ colorScheme: "light" });
    await page.waitForTimeout(300);
  };

  const sidebarEdgeX = async () => box(page, "#sidebar-pane-edge").then((b) => b.x + b.width / 2);
  const railEdgeX = async () => box(page, "#thread-pane-edge").then((b) => b.x + b.width / 2);

  test("the panes open at the design's widths, the chrome's dividers on their edges", async () => {
    const g = await geometry(page);
    expect(g.sidebar).toBeCloseTo(PANES.sidebar.default, 0);
    expect(g.rail).toBeCloseTo(PANES.rail.default, 0);
    // The canvas starts where the sidebar's gutter ends, and stops where the rail's begins.
    expect(g.canvasLeft).toBeCloseTo(300, 0);
    expect(g.canvasRight).toBeCloseTo(WIDTH - 360, 0);
    // The chrome's left block ends a header gap before x 300; the right block (the rail's
    // toggle and the cluster before it) reaches back to x 1080, the rail's edge.
    expect(g.chromeLeftEnd + 4).toBeCloseTo(300, 0);
    expect(g.chromeRightStart).toBeCloseTo(WIDTH - 360, 0);
    // Each edge is a separator in tab order, named for its pane.
    for (const [id, name] of [
      ["#sidebar-pane-edge", "Resize sidebar"],
      ["#thread-pane-edge", "Resize thread"],
    ] as const) {
      const edge = page.locator(id);
      expect(await edge.getAttribute("role")).toBe("separator");
      expect(await edge.getAttribute("aria-label")).toBe(name);
      expect(await edge.getAttribute("tabindex")).toBe("0");
      expect(await edge.getAttribute("aria-orientation")).toBe("vertical");
    }
    await shootBoth("1-rest", 300);
  });

  test("the edge hints only once the pointer rests on it, with the column-resize cursor", async () => {
    const x = await sidebarEdgeX();
    const line = () =>
      page
        .locator("#sidebar-pane-edge > span")
        .evaluate((el) => getComputedStyle(el).backgroundColor);
    const NOTHING = "rgba(0, 0, 0, 0)";
    expect(
      await page.locator("#sidebar-pane-edge").evaluate((el) => getComputedStyle(el).cursor),
    ).toBe("col-resize");
    // Swept across: nothing shows.
    await page.mouse.move(x - 60, GRIP_Y);
    await page.mouse.move(x + 60, GRIP_Y, { steps: 6 });
    expect(await line()).toBe(NOTHING);
    // Resting there: the quiet line (--c-dry), after the linger.
    await page.mouse.move(x, GRIP_Y);
    await page.waitForTimeout(100);
    expect(await line()).toBe(NOTHING);
    await page.waitForTimeout(600);
    expect(await line()).toBe("rgb(201, 197, 188)");
    await shootBoth("2-hover", x);
    await page.mouse.move(x + 200, GRIP_Y);
  });

  test("dragging the sidebar's edge moves it with the pointer, the chrome in the same frame", async () => {
    const x = await sidebarEdgeX();
    await page.mouse.move(x, GRIP_Y);
    await page.mouse.down();
    // Out over the canvas's boards (frames), a step at a time: the pane follows each step.
    for (const dx of [20, 40, 60, 84]) {
      await page.mouse.move(x + dx, GRIP_Y);
      const g = await sameFrame(page);
      expect(g.sidebar).toBeCloseTo(300 + dx, 0);
      expect(g.chromeLeftEnd + 4).toBeCloseTo(g.sidebar, 1);
      expect(g.canvasLeft).toBeCloseTo(g.sidebar, 1);
    }
    // While held: the window says so (cursor, no selecting, frames let the pointer through),
    // and nothing eases.
    expect(await page.locator("[data-pane-drag]").count()).toBe(1);
    expect(await page.locator("[data-pane-motion]").count()).toBe(0);
    expect(await page.locator("#sidebar-pane-edge").getAttribute("data-separator")).toBe("active");
    expect(await page.locator("#canvas-pane").evaluate((el) => getComputedStyle(el).cursor)).toBe(
      "col-resize",
    );
    await shootBoth("3-dragging", x + 84);
    // Past its limits it stops at them.
    await page.mouse.move(x + 600, GRIP_Y, { steps: 4 });
    expect((await geometry(page)).sidebar).toBeCloseTo(PANES.sidebar.max, 0);
    await page.mouse.move(x - 200, GRIP_Y, { steps: 4 });
    expect((await geometry(page)).sidebar).toBeCloseTo(PANES.sidebar.min, 0);
    // Even out of the window.
    await page.mouse.move(-40, GRIP_Y, { steps: 2 });
    expect((await geometry(page)).sidebar).toBeCloseTo(PANES.sidebar.min, 0);
    await page.mouse.move(x + 44, GRIP_Y, { steps: 4 });
    await page.mouse.up();
    expect((await geometry(page)).sidebar).toBeCloseTo(344, 0);
    expect(await page.locator("[data-pane-drag]").count()).toBe(0);
    // Kept for this person on this computer.
    await waitUntil(async () => (await saved(page))?.sidebarWidth === 344);
    // No text was selected on the way.
    expect(await page.evaluate(() => String(window.getSelection()))).toBe("");
  });

  test("the rail's edge drags the same way, and the chrome's right block follows it", async () => {
    const before = await geometry(page);
    const x = await railEdgeX();
    await page.mouse.move(x, GRIP_Y);
    await page.mouse.down();
    for (const dx of [-30, -60, -100]) {
      await page.mouse.move(x + dx, GRIP_Y);
      const g = await sameFrame(page);
      expect(g.rail).toBeCloseTo(360 - dx, 0);
      expect(g.chromeRightStart - g.railLeft).toBeCloseTo(
        before.chromeRightStart - before.railLeft,
        1,
      );
      expect(g.canvasRight).toBeCloseTo(WIDTH - g.rail, 1);
    }
    await shootBoth("4-dragging-rail", x - 100);
    await page.mouse.up();
    await waitUntil(async () => (await saved(page))?.railWidth === 460);
  });

  test("toggled closed and open, a pane eases both ways and comes back at its width", async () => {
    const toggle = page.getByRole("button", { name: "Toggle sidebar" });
    const easing = framesOf(page, "#sidebar-pane");
    await toggle.click();
    // Easing, then closed: it passes through the widths between, frame by frame.
    expect(await page.locator("[data-pane-motion]").count()).toBe(1);
    const widths = await easing;
    expect(widths.some((w) => w > 20 && w < 300)).toBe(true);
    expect(widths.at(-1)).toBeLessThan(0.5);
    await waitUntil(async () => (await geometry(page)).sidebar < 0.5);
    await waitUntil(async () => (await page.locator("[data-pane-motion]").count()) === 0);
    const closed = await geometry(page);
    // The canvas comes to 6 from the window's edge, and the edge can't be taken hold of.
    expect(closed.canvasLeft).toBeCloseTo(6, 0);
    expect(await page.locator("#sidebar-pane-edge").getAttribute("tabindex")).toBeNull();
    await toggle.click();
    await waitUntil(async () => (await page.locator("[data-pane-motion]").count()) === 0);
    const open = await geometry(page);
    expect(open.sidebar).toBeCloseTo(344, 0);
    expect(open.chromeLeftEnd + 4).toBeCloseTo(344, 0);

    // The rail the same, with its toggle.
    const thread = page.getByRole("button", { name: "Thread" });
    await thread.click();
    // The thread stays in it as it slides away, rather than emptying first.
    expect(await page.locator("#thread-pane").textContent()).toContain("I drew the welcome screen");
    await waitUntil(async () => (await geometry(page)).rail < 0.5);
    await waitUntil(async () => (await page.locator("[data-pane-motion]").count()) === 0);
    expect((await geometry(page)).canvasRight).toBeCloseTo(WIDTH - 6, 0);
    await thread.click();
    await waitUntil(async () => (await page.locator("[data-pane-motion]").count()) === 0);
    expect((await geometry(page)).rail).toBeCloseTo(460, 0);
    // A toggle doesn't change the width that's kept.
    expect(await saved(page)).toMatchObject({ sidebarWidth: 344, railWidth: 460 });
  });

  test("an edge moves with the arrow keys, shows the focus ring, and Enter leaves the pane open", async () => {
    const edge = page.locator("#sidebar-pane-edge");
    await edge.focus();
    await page.keyboard.press("ArrowRight");
    expect((await geometry(page)).sidebar).toBeCloseTo(354, 0);
    await page.keyboard.press("Shift+ArrowLeft");
    expect((await geometry(page)).sidebar).toBeCloseTo(304, 0);
    await page.keyboard.press("ArrowLeft");
    expect((await geometry(page)).sidebar).toBeCloseTo(294, 0);
    await page.keyboard.press("Enter");
    expect((await geometry(page)).sidebar).toBeCloseTo(294, 0);
    await waitUntil(async () => (await saved(page))?.sidebarWidth === 294);
    expect(await edge.evaluate((el) => el.matches(":focus-visible"))).toBe(true);
    await shootBoth("5-focus", await sidebarEdgeX());
    // The rail's edge moves the way the arrow points too: left widens it.
    await page.locator("#thread-pane-edge").focus();
    await page.keyboard.press("ArrowLeft");
    expect((await geometry(page)).rail).toBeCloseTo(470, 0);
    await waitUntil(async () => (await saved(page))?.railWidth === 470);
  });

  test("double-clicking an edge returns its pane to the design's width", async () => {
    const x = await sidebarEdgeX();
    await page.mouse.dblclick(x, GRIP_Y);
    expect((await geometry(page)).sidebar).toBeCloseTo(PANES.sidebar.default, 0);
    await page.mouse.dblclick(await railEdgeX(), GRIP_Y);
    expect((await geometry(page)).rail).toBeCloseTo(PANES.rail.default, 0);
    await waitUntil(async () => {
      const ui = await saved(page);
      return ui?.sidebarWidth === 300 && ui.railWidth === 360;
    });
  });

  test("a small window keeps the canvas its room, and gives the panes theirs back", async () => {
    // Both panes as wide as they go: the keys stop at the limit.
    await page.locator("#sidebar-pane-edge").focus();
    for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowRight");
    await page.locator("#thread-pane-edge").focus();
    for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowLeft");
    const wide = await geometry(page);
    expect(wide.sidebar).toBeCloseTo(PANES.sidebar.max, 0);
    expect(wide.rail).toBeCloseTo(PANES.rail.max, 0);

    await page.setViewportSize({ width: 1100, height: HEIGHT });
    await waitUntil(async () => (await geometry(page)).canvasWidth >= 400 - 0.5);
    const small = await geometry(page);
    expect(small.sidebar).toBeGreaterThanOrEqual(PANES.sidebar.min - 0.5);
    expect(small.rail).toBeGreaterThanOrEqual(PANES.rail.min - 0.5);
    expect(small.chromeLeftEnd + 4).toBeCloseTo(small.sidebar, 0);
    await shoot("6-small-window");

    await page.setViewportSize({ width: WIDTH, height: HEIGHT });
    await waitUntil(async () => {
      const g = await geometry(page);
      return Math.abs(g.sidebar - PANES.sidebar.max) < 1 && Math.abs(g.rail - PANES.rail.max) < 1;
    });
    // What a small window did is not what's kept.
    expect(await saved(page)).toMatchObject({
      sidebarWidth: PANES.sidebar.max,
      railWidth: PANES.rail.max,
    });
  });

  test("the widths come back after a reload", async () => {
    await page.locator("#sidebar-pane-edge").focus();
    for (let i = 0; i < 9; i++) await page.keyboard.press("ArrowLeft");
    await waitUntil(async () => (await saved(page))?.sidebarWidth === 330);
    await page.reload();
    await openTheDesign(page);
    const g = await geometry(page);
    expect(g.sidebar).toBeCloseTo(330, 0);
    expect(g.rail).toBeCloseTo(PANES.rail.max, 0);
    expect(g.chromeLeftEnd + 4).toBeCloseTo(330, 0);
    expect(errors).toEqual([]);
  });
});

/** Signs in and through the first run (the team is set up already) to its design. */
async function openTheDesign(page: Page) {
  await page.getByRole("button", { name: "Continue with GitHub" }).click();
  await page.getByRole("heading", { name: "Where do you design?" }).waitFor();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("heading", { name: "Connect Claude" }).waitFor();
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("Paste the code from claude.ai").fill("k7Hq2-Rw9xT-pL4mZ#state");
  await page.getByRole("button", { name: "Connect" }).click();
  await page.getByRole("button", { name: "Start designing" }).click();
  const row = page.getByRole("button", { name: /Onboarding flow/ });
  await row.waitFor();
  if ((await page.locator("[data-artboard-host]").count()) === 0) await row.click();
  await page.locator('[data-board-name][title="Welcome"]').waitFor();
  await page.locator("#thread").waitFor();
  await waitUntil(async () => (await page.locator("[data-pane-motion]").count()) === 0);
}

async function box(page: Page, selector: string) {
  const found = await page.locator(selector).boundingBox();
  if (!found) throw new Error(`No ${selector}`);
  return found;
}

/** Where the panes, the canvas and the chrome's blocks are, as laid out now. */
function geometry(page: Page) {
  return page.evaluate(measure);
}

/**
 * The same, read in the task that handled the last pointer move, before the browser could paint
 * anything: the chrome must already be where the pane is, with nothing left to catch up on.
 */
async function sameFrame(page: Page): Promise<ReturnType<typeof measure>> {
  const moves = await page.evaluate("window.__moves");
  if (!Array.isArray(moves) || !moves.length) throw new Error("No pointer move was measured.");
  return moves.at(-1);
}

/** Measures the window after each pointer move, once React has drawn what it set off. */
function measureEachMove(page: Page) {
  return page.evaluate(`
    window.__moves = [];
    window.__measure = ${measure.toString()};
    document.addEventListener("pointermove", () =>
      queueMicrotask(() => window.__moves.push(window.__measure())),
    );
  `);
}

function measure() {
  const rect = (selector: string) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`No ${selector}`);
    return el.getBoundingClientRect();
  };
  const header = document.querySelector("header")!;
  const canvas = rect("#canvas-pane main");
  // A pane's width takes in its gutter, the edge (the sidebar's 8, the rail's 10).
  const sidebar = rect("#sidebar-pane").width;
  const rail = rect("#thread-pane").width;
  const railEdge = rect("#thread-pane-edge");
  return {
    sidebar: sidebar > 0.5 ? sidebar + 8 : 0,
    rail: rail > 0.5 ? rail + 10 : 0,
    railLeft: railEdge.left,
    canvasLeft: canvas.left,
    canvasRight: canvas.right,
    canvasWidth: canvas.width,
    chromeLeftEnd: header.firstElementChild!.getBoundingClientRect().right,
    chromeRightStart: header.lastElementChild!.getBoundingClientRect().left,
  };
}

/** An element's width at each frame for the next 400ms, from now. */
function framesOf(page: Page, selector: string): Promise<number[]> {
  return page.evaluate(
    (selector) =>
      new Promise<number[]>((done) => {
        const widths: number[] = [];
        const start = performance.now();
        const tick = () => {
          widths.push(document.querySelector(selector)!.getBoundingClientRect().width);
          if (performance.now() - start < 400) requestAnimationFrame(tick);
          else done(widths);
        };
        requestAnimationFrame(tick);
      }),
    selector,
  );
}

/** What the window keeps for Maya between launches. */
function saved(page: Page): Promise<{ sidebarWidth?: number; railWidth?: number } | null> {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith("ponzu.ui."));
    return key ? JSON.parse(localStorage.getItem(key)!) : null;
  });
}
