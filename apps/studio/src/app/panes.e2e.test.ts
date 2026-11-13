/*
 * The window's side panes, resized by hand: the studio built as it ships, in a real Chromium, on
 * Ponzu Cloud in memory (fake-host.ts), with a canvas open so both the sidebar and the thread
 * rail are there. Dragging an edge moves its pane within its limits and the chrome with it in the
 * same frame, over the canvas's frames too; the arrow keys and a double-click move it; the toggles
 * still collapse and expand it, back to the width it was left at; a small window keeps the main
 * pane room; and the widths come back after a reload. Skips where there is no Chrome or Chromium.
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
    // Signed in past setup: the first run is app.e2e's and the slow-answer walks'.
    await page.goto(`${server.url}?as=returning`);
    await openTheCanvas(page);
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

  test("the panes open at the mockup's widths, the chrome's dividers on their edges", async () => {
    const g = await geometry(page);
    expect(g.sidebar).toBeCloseTo(PANES.sidebar.default, 0);
    expect(g.rail).toBeCloseTo(PANES.rail.default, 0);
    // The canvas starts where the sidebar's gutter ends, and stops where the rail's begins.
    expect(g.mainLeft).toBeCloseTo(300, 0);
    expect(g.mainRight).toBeCloseTo(WIDTH - 360, 0);
    // The chrome's left block ends a header gap before x 300; the rail's divider is on x 1080,
    // the rail's edge, its pixel the canvas's last column.
    expect(g.chromeLeftEnd + 4).toBeCloseTo(300, 0);
    expect(g.railDividerRight).toBeCloseTo(WIDTH - 360, 1);
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
    await atRest(page);
    const x = await sidebarEdgeX();
    const line = () =>
      page
        .locator("#sidebar-pane-edge > span")
        .evaluate((el) => getComputedStyle(el).backgroundColor);
    const NOTHING = "rgba(0, 0, 0, 0)";
    expect(
      await page.locator("#sidebar-pane-edge").evaluate((el) => getComputedStyle(el).cursor),
    ).toBe("col-resize");
    // The line waits out the linger on the page's own clock, held here where it starts: how long
    // the pointer's moves take to arrive (a busy machine's round trips can outlast the 300 ms)
    // then changes nothing, and the linger is stepped through as the product times it.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Animation.enable");
    await cdp.send("Animation.setPlaybackRate", { playbackRate: 0 });
    try {
      // Swept across, however long it was over the edge on the way: nothing shows.
      await page.mouse.move(x - 60, GRIP_Y);
      await page.mouse.move(x + 60, GRIP_Y, { steps: 6 });
      expect(await line()).toBe(NOTHING);
      // Resting there: the quiet line (--c-dry), after the linger and not before.
      await page.mouse.move(x, GRIP_Y);
      const linger = () =>
        page.locator("#sidebar-pane-edge > span").evaluate((el) => {
          const fade = el
            .getAnimations()
            .find(
              (a) =>
                (a as Animation & { transitionProperty?: string }).transitionProperty ===
                "background-color",
            );
          if (!fade) return null;
          const { delay, duration } = fade.effect!.getComputedTiming();
          return { delay: Number(delay), duration: Number(duration) };
        });
      await waitUntil(async () => (await linger()) !== null);
      const { delay, duration } = (await linger())!;
      const tokens = await page.evaluate(() => {
        const css = getComputedStyle(document.documentElement);
        const ms = (name: string) => {
          const value = css.getPropertyValue(name).trim();
          return Number.parseFloat(value) * (/\ds$/.test(value) ? 1000 : 1);
        };
        return { linger: ms("--dur-linger"), hover: ms("--dur-hover") };
      });
      expect(delay).toBe(tokens.linger);
      expect(duration).toBe(tokens.hover);
      const at = (ms: number) =>
        page.locator("#sidebar-pane-edge > span").evaluate((el, ms) => {
          for (const a of el.getAnimations()) a.currentTime = ms;
        }, ms);
      await at(delay - 1);
      expect(await line()).toBe(NOTHING);
      await at(delay + duration);
      expect(await line()).toBe("rgb(201, 197, 188)");
    } finally {
      await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 });
      await cdp.detach();
    }
    expect(await line()).toBe("rgb(201, 197, 188)");
    // On the canvas's side of the gutter, under the chrome's divider: never in the gutter's
    // middle, a few pixels off it.
    const drawn = await box(page, "#sidebar-pane-edge > span");
    const main = await box(page, "#main-pane main");
    expect(drawn.x + drawn.width).toBeCloseTo(main.x, 0);
    await shootBoth("2-hover", x);
    await page.mouse.move(x + 200, GRIP_Y);
  });

  test("dragging the sidebar's edge moves it with the pointer, the chrome in the same frame", async () => {
    await atRest(page);
    const x = await sidebarEdgeX();
    await page.mouse.move(x, GRIP_Y);
    await page.mouse.down();
    // Out over the canvas's boards (frames), a step at a time: the pane follows each step.
    for (const dx of [20, 40, 60, 84]) {
      await page.mouse.move(x + dx, GRIP_Y);
      const g = await sameFrame(page);
      expect(g.sidebar).toBeCloseTo(300 + dx, 0);
      expect(g.chromeLeftEnd + 4).toBeCloseTo(g.sidebar, 1);
      expect(g.mainLeft).toBeCloseTo(g.sidebar, 1);
    }
    // While held: the window says so (cursor, no selecting, frames let the pointer through),
    // and nothing eases.
    expect(await page.locator("[data-pane-drag]").count()).toBe(1);
    expect(await page.locator("[data-pane-motion]").count()).toBe(0);
    expect(await page.locator("#sidebar-pane-edge").getAttribute("data-separator")).toBe("active");
    expect(await page.locator("#main-pane").evaluate((el) => getComputedStyle(el).cursor)).toBe(
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

  test("the rail's edge drags the same way, and the chrome's divider follows it", async () => {
    await atRest(page);
    const before = await geometry(page);
    const x = await railEdgeX();
    await page.mouse.move(x, GRIP_Y);
    await page.mouse.down();
    for (const dx of [-30, -60, -100]) {
      await page.mouse.move(x + dx, GRIP_Y);
      const g = await sameFrame(page);
      expect(g.rail).toBeCloseTo(360 - dx, 0);
      expect(g.railDividerRight - g.railLeft).toBeCloseTo(
        before.railDividerRight - before.railLeft,
        1,
      );
      expect(g.mainRight).toBeCloseTo(WIDTH - g.rail, 1);
      // On the canvas's edge, in the same frame as the pane.
      expect(g.railDividerRight).toBeCloseTo(g.mainRight, 1);
    }
    await shootBoth("4-dragging-rail", x - 100);
    await page.mouse.up();
    await waitUntil(async () => (await saved(page))?.railWidth === 460);
  });

  test("toggled closed and open, a pane eases both ways and comes back at its width", async () => {
    await atRest(page);
    // Widths of the person's own, not the mockup's, to come back to: set by keys, as by hand.
    await page.locator("#sidebar-pane-edge").focus();
    await page.keyboard.press("Shift+ArrowRight");
    await page.locator("#thread-pane-edge").focus();
    await page.keyboard.press("Shift+ArrowLeft");
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const sidebarWidth = PANES.sidebar.default + 50;
    const railWidth = PANES.rail.default + 50;
    await waitUntil(async () => {
      const ui = await saved(page);
      return ui?.sidebarWidth === sidebarWidth && ui.railWidth === railWidth;
    });
    const toggle = page.getByRole("button", { name: "Toggle sidebar" });
    const easing = await watchEasing(page);
    await toggle.click();
    // Easing, then closed: the window wore the mark, and its panel eased on the panes' clock,
    // rather than jumping. Both are caught as they happen, not looked for afterwards: the mark
    // is on for --dur-pane, which a busy machine's round trip can outlast.
    const ms = await page.evaluate(() => {
      // The build may write it in seconds (".22s").
      const value = getComputedStyle(document.documentElement).getPropertyValue("--dur-pane");
      return Number.parseFloat(value) * (/\ds\s*$/.test(value) ? 1000 : 1);
    });
    expect(ms).toBeGreaterThan(0);
    // Read once the panel has closed, so every transition it started has been seen.
    await waitUntil(async () => (await geometry(page)).sidebar < 0.5);
    await waitUntil(async () => (await page.locator("[data-pane-motion]").count()) === 0);
    const eased = await easing();
    expect(eased.marked).toBe(true);
    expect(eased.transitions).toContainEqual({
      target: "sidebar-pane",
      property: "flex-grow",
      ms,
    });
    const closed = await geometry(page);
    // The canvas comes to 6 from the window's edge, and the edge can't be taken hold of.
    expect(closed.mainLeft).toBeCloseTo(6, 0);
    expect(await page.locator("#sidebar-pane-edge").getAttribute("tabindex")).toBeNull();
    await toggle.click();
    await waitUntil(async () => (await page.locator("[data-pane-motion]").count()) === 0);
    const open = await geometry(page);
    expect(open.sidebar).toBeCloseTo(sidebarWidth, 0);
    expect(open.chromeLeftEnd + 4).toBeCloseTo(sidebarWidth, 0);

    // The rail the same, with its toggle.
    const thread = page.getByRole("button", { name: "Thread" });
    await thread.click();
    // The thread stays in it as it slides away, rather than emptying first.
    expect(await page.locator("#thread-pane").textContent()).toContain("I drew the welcome screen");
    await waitUntil(async () => (await geometry(page)).rail < 0.5);
    await waitUntil(async () => (await page.locator("[data-pane-motion]").count()) === 0);
    expect((await geometry(page)).mainRight).toBeCloseTo(WIDTH - 6, 0);
    await thread.click();
    await waitUntil(async () => (await page.locator("[data-pane-motion]").count()) === 0);
    expect((await geometry(page)).rail).toBeCloseTo(railWidth, 0);
    // A toggle doesn't change the width that's kept.
    expect(await saved(page)).toMatchObject({ sidebarWidth, railWidth });
  });

  test("an edge moves with the arrow keys, shows the focus ring, and Enter leaves the pane open", async () => {
    await atRest(page);
    const edge = page.locator("#sidebar-pane-edge");
    await edge.focus();
    await page.keyboard.press("ArrowRight");
    expect((await geometry(page)).sidebar).toBeCloseTo(310, 0);
    await page.keyboard.press("Shift+ArrowLeft");
    expect((await geometry(page)).sidebar).toBeCloseTo(260, 0);
    await page.keyboard.press("ArrowLeft");
    expect((await geometry(page)).sidebar).toBeCloseTo(250, 0);
    await page.keyboard.press("Enter");
    expect((await geometry(page)).sidebar).toBeCloseTo(250, 0);
    await waitUntil(async () => (await saved(page))?.sidebarWidth === 250);
    expect(await edge.evaluate((el) => el.matches(":focus-visible"))).toBe(true);
    // Reached with Tab, as the keyboard does (focus a script gave after a click stays quiet):
    // the line, in the ring's colour.
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    expect(await edge.evaluate((el) => el === document.activeElement)).toBe(true);
    await waitUntil(
      async () =>
        (await page
          .locator("#sidebar-pane-edge > span")
          .evaluate((el) => getComputedStyle(el).backgroundColor)) === "rgb(128, 124, 115)",
    );
    await shootBoth("5-focus", await sidebarEdgeX());
    // The rail's edge moves the way the arrow points too: left widens it.
    const rail = page.locator("#thread-pane-edge");
    await rail.focus();
    await page.keyboard.press("ArrowLeft");
    expect((await geometry(page)).rail).toBeCloseTo(370, 0);
    await waitUntil(async () => (await saved(page))?.railWidth === 370);
    // Read out as the pane's width, whichever side it's on (the library's own value is the
    // panel before the edge: the canvas, for the rail).
    await waitUntil(
      async () => (await rail.getAttribute("aria-valuetext")) === "Thread, 370 pixels",
    );
    // Home: the pane at its narrowest; End: at its widest. The same on both sides.
    await page.keyboard.press("Home");
    expect((await geometry(page)).rail).toBeCloseTo(PANES.rail.min, 0);
    await page.keyboard.press("End");
    expect((await geometry(page)).rail).toBeCloseTo(PANES.rail.max, 0);
    await waitUntil(async () => (await saved(page))?.railWidth === PANES.rail.max);
    await edge.focus();
    await page.keyboard.press("End");
    expect((await geometry(page)).sidebar).toBeCloseTo(PANES.sidebar.max, 0);
    await page.keyboard.press("Home");
    expect((await geometry(page)).sidebar).toBeCloseTo(PANES.sidebar.min, 0);
    await waitUntil(
      async () =>
        (await edge.getAttribute("aria-valuetext")) === `Sidebar, ${PANES.sidebar.min} pixels`,
    );
  });

  test("dragging an edge leaves focus where it was", async () => {
    await atRest(page);
    const message = page.getByRole("textbox", { name: "Message" });
    await message.click();
    await page.keyboard.type("hello");
    const x = await railEdgeX();
    await page.mouse.move(x, GRIP_Y);
    await page.mouse.down();
    await page.mouse.move(x - 20, GRIP_Y, { steps: 2 });
    await page.mouse.up();
    expect(await message.evaluate((el) => el === document.activeElement)).toBe(true);
    await page.keyboard.type("X");
    expect(await message.inputValue()).toBe("helloX");
    await message.fill("");
    // From nowhere in particular, focus doesn't stay on the edge either.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.mouse.move(x - 20, GRIP_Y);
    await page.mouse.down();
    await page.mouse.move(x, GRIP_Y, { steps: 2 });
    await page.mouse.up();
    expect(await page.evaluate(() => document.activeElement?.id ?? "")).not.toBe(
      "thread-pane-edge",
    );
  });

  test("double-clicking an edge returns its pane to the mockup's width", async () => {
    await atRest(page);
    // Both away from it first, by keys.
    await page.locator("#sidebar-pane-edge").focus();
    await page.keyboard.press("Shift+ArrowRight");
    await page.locator("#thread-pane-edge").focus();
    await page.keyboard.press("Shift+ArrowLeft");
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await waitUntil(async () => {
      const ui = await saved(page);
      return ui?.sidebarWidth === 350 && ui.railWidth === 410;
    });
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

  test("the chrome's dividers are handles for their panes too: a drag sizes one, a double click resets it", async () => {
    await atRest(page);
    const grip = async (pane: "sidebar" | "rail") => {
      const b = await box(page, `[data-chrome-grip="${pane}"]`);
      return { x: b.x + b.width / 2, y: b.y + b.height / 2, width: b.width, height: b.height };
    };
    // The sidebar's divider stands on its edge, at the canvas's first column, and takes the
    // pointer the chrome's full height, 4 either side of the hairline.
    const left = await grip("sidebar");
    expect(left.x).toBeCloseTo(300.5, 0);
    expect(left.width).toBe(9);
    expect(left.height).toBe(38);
    expect(
      await page
        .locator('[data-chrome-grip="sidebar"]')
        .evaluate((el) => getComputedStyle(el).cursor),
    ).toBe("col-resize");
    await page.mouse.move(left.x, left.y);
    await page.mouse.down();
    for (const dx of [16, 40]) {
      await page.mouse.move(left.x + dx, left.y);
      const g = await sameFrame(page);
      expect(g.sidebar).toBeCloseTo(300 + dx, 0);
      expect(g.chromeLeftEnd + 4).toBeCloseTo(g.sidebar, 1);
      expect(g.mainLeft).toBeCloseTo(g.sidebar, 1);
    }
    // Held like an edge: the cursor everywhere, nothing easing, and the pane's own limits.
    expect(await page.locator("[data-pane-drag]").count()).toBe(1);
    expect(await page.locator("[data-pane-motion]").count()).toBe(0);
    await page.mouse.move(left.x + 600, 300, { steps: 4 });
    expect((await geometry(page)).sidebar).toBeCloseTo(PANES.sidebar.max, 0);
    await page.mouse.move(left.x + 24, left.y, { steps: 4 });
    await page.mouse.up();
    expect((await geometry(page)).sidebar).toBeCloseTo(324, 0);
    expect(await page.locator("[data-pane-drag]").count()).toBe(0);
    await waitUntil(async () => (await saved(page))?.sidebarWidth === 324);
    expect(await page.evaluate(() => String(window.getSelection()))).toBe("");

    // The rail's divider, on the canvas's last column: the pointer going left widens the rail.
    const right = await grip("rail");
    expect(right.x).toBeCloseTo(WIDTH - 360 - 0.5, 0);
    await page.mouse.move(right.x, right.y);
    await page.mouse.down();
    await page.mouse.move(right.x - 50, right.y);
    const g = await sameFrame(page);
    expect(g.rail).toBeCloseTo(410, 0);
    expect(g.mainRight).toBeCloseTo(WIDTH - g.rail, 1);
    expect(g.railDividerRight).toBeCloseTo(g.mainRight, 1);
    await page.mouse.up();
    await waitUntil(async () => (await saved(page))?.railWidth === 410);

    // A double click on either puts its pane back at the mockup's width.
    const leftNow = await grip("sidebar");
    await page.mouse.dblclick(leftNow.x, leftNow.y);
    expect((await geometry(page)).sidebar).toBeCloseTo(PANES.sidebar.default, 0);
    const rightNow = await grip("rail");
    await page.mouse.dblclick(rightNow.x, rightNow.y);
    expect((await geometry(page)).rail).toBeCloseTo(PANES.rail.default, 0);
    await waitUntil(async () => {
      const ui = await saved(page);
      return ui?.sidebarWidth === 300 && ui.railWidth === 360;
    });

    // Closed, a pane's divider is only a divider.
    const toggle = page.getByRole("button", { name: "Toggle sidebar" });
    await toggle.click();
    await waitUntil(async () => (await geometry(page)).sidebar === 0);
    expect(await page.locator('[data-chrome-grip="sidebar"]').count()).toBe(0);
    expect(await page.locator('[data-chrome-grip="rail"]').count()).toBe(1);
    await toggle.click();
    await waitUntil(async () => Math.round((await geometry(page)).sidebar) === 300);
    await waitUntil(async () => (await page.locator("[data-pane-motion]").count()) === 0);
  });

  test("a small window keeps the canvas its room, and gives the panes theirs back", async () => {
    await atRest(page);
    // Both panes as wide as they go: the keys stop at the limit.
    await page.locator("#sidebar-pane-edge").focus();
    for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowRight");
    await page.locator("#thread-pane-edge").focus();
    for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowLeft");
    const wide = await geometry(page);
    expect(wide.sidebar).toBeCloseTo(PANES.sidebar.max, 0);
    expect(wide.rail).toBeCloseTo(PANES.rail.max, 0);

    await page.setViewportSize({ width: 1100, height: HEIGHT });
    await waitUntil(async () => (await geometry(page)).mainWidth >= 400 - 0.5);
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

  test("in a small window, dragging one edge stops at the canvas and leaves the other pane be", async () => {
    await atRest(page);
    await page.mouse.dblclick(await sidebarEdgeX(), GRIP_Y);
    await page.mouse.dblclick(await railEdgeX(), GRIP_Y);
    await page.setViewportSize({ width: 1100, height: HEIGHT });
    await waitUntil(
      async () => Math.abs((await geometry(page)).mainWidth - (1100 - 300 - 360)) < 1,
    );
    const before = await geometry(page);
    const x = await sidebarEdgeX();
    await page.mouse.move(x, GRIP_Y);
    await page.mouse.down();
    await page.mouse.move(x + 200, GRIP_Y, { steps: 6 });
    const held = await geometry(page);
    // Stopped where the canvas reached its 400; the rail where it was, while held too.
    expect(held.mainWidth).toBeCloseTo(400, 0);
    expect(held.rail).toBeCloseTo(before.rail, 0);
    await page.mouse.up();
    const after = await geometry(page);
    expect(after.rail).toBeCloseTo(before.rail, 0);
    expect(after.sidebar).toBeCloseTo(1100 - 400 - before.rail, 0);
    await waitUntil(async () => (await saved(page))?.sidebarWidth === Math.round(after.sidebar));
    expect((await saved(page))?.railWidth).toBe(360);
    // The keys the same way: the rail's edge pushed left goes no further than the canvas lets it.
    await page.locator("#thread-pane-edge").focus();
    await page.keyboard.press("Shift+ArrowLeft");
    const keyed = await geometry(page);
    expect(keyed.sidebar).toBeCloseTo(after.sidebar, 0);
    expect(keyed.rail).toBeCloseTo(before.rail, 0);
    // Back to the mockup's widths for what follows.
    await page.setViewportSize({ width: WIDTH, height: HEIGHT });
    await waitUntil(async () => (await geometry(page)).mainWidth > 600);
    await page.mouse.dblclick(await sidebarEdgeX(), GRIP_Y);
    await waitUntil(async () => (await saved(page))?.sidebarWidth === 300);
  });

  test("opened in a small window, wide panes share the shortfall, and widen again with it", async () => {
    await atRest(page);
    await page.evaluate(() => {
      const key = Object.keys(localStorage).find((k) => k.startsWith("ponzu.ui."))!;
      const ui = JSON.parse(localStorage.getItem(key)!);
      localStorage.setItem(key, JSON.stringify({ ...ui, sidebarWidth: 420, railWidth: 520 }));
    });
    await page.setViewportSize({ width: 1100, height: HEIGHT });
    await page.reload();
    await openTheCanvas(page);
    const small = await geometry(page);
    expect(small.mainWidth).toBeCloseTo(400, 0);
    // Each gave up some of its width, in proportion to its room above its minimum: neither
    // squeezed to it while the other kept all of its own.
    expect(small.sidebar).toBeGreaterThan(PANES.sidebar.min + 40);
    expect(small.rail).toBeGreaterThan(PANES.rail.min + 40);
    expect(small.sidebar + small.rail).toBeCloseTo(1100 - 400, 0);
    expect(small.chromeLeftEnd + 4).toBeCloseTo(small.sidebar, 0);
    await page.setViewportSize({ width: WIDTH, height: HEIGHT });
    await waitUntil(async () => {
      const g = await geometry(page);
      return Math.abs(g.sidebar - 420) < 1 && Math.abs(g.rail - 520) < 1;
    });
    expect(await saved(page)).toMatchObject({ sidebarWidth: 420, railWidth: 520 });
    expect(errors).toEqual([]);
  });
});

/** Opens the team's canvas, as its link does, for someone signed in past setup. */
async function openTheCanvas(page: Page) {
  await page.locator("#sidebar").waitFor();
  const find = () =>
    page.evaluate(
      () =>
        [...window.ponzuFake!.backend.canvases.values()].find(
          (d) => d.sequencer.doc.name === "Onboarding flow",
        )?.id ?? null,
    );
  await waitUntil(async () => (await find()) !== null);
  const canvasId = (await find())!;
  await page.evaluate((id) => window.ponzuFake!.link({ kind: "canvas", canvasId: id }), canvasId);
  await page.locator('[data-board-name][title="Welcome"]').waitFor();
  await page.locator("#thread").waitFor();
  await waitUntil(async () => (await page.locator("[data-pane-motion]").count()) === 0);
}

/**
 * The window as each test after the first starts from it: 1440 by 900, the pointer let go of
 * and on the canvas, nothing focused, both panes open at the mockup's widths and kept so, and
 * nothing easing. Where the test before left it so, this changes nothing; where one failed part
 * way, the next still starts where it should, and a failure stays its own.
 */
async function atRest(page: Page) {
  await page.mouse.up();
  await page.setViewportSize({ width: WIDTH, height: HEIGHT });
  await page.mouse.move(WIDTH / 2, HEIGHT / 2);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const still = async () => (await page.locator("[data-pane-motion]").count()) === 0;
  for (const [pane, toggle] of [
    ["sidebar", "Toggle sidebar"],
    ["rail", "Thread"],
  ] as const) {
    if ((await geometry(page))[pane] > 0.5) continue;
    await page.getByRole("button", { name: toggle }).click();
    await waitUntil(async () => (await still()) && (await geometry(page))[pane] > 0.5);
  }
  await waitUntil(still);
  for (const [pane, edge] of [
    ["sidebar", "#sidebar-pane-edge"],
    ["rail", "#thread-pane-edge"],
  ] as const) {
    if (Math.round((await geometry(page))[pane]) === PANES[pane].default) continue;
    const b = await box(page, edge);
    await page.mouse.dblclick(b.x + b.width / 2, GRIP_Y);
  }
  await page.mouse.move(WIDTH / 2, HEIGHT / 2);
  await waitUntil(async () => {
    const g = await geometry(page);
    const ui = await saved(page);
    return (
      Math.round(g.sidebar) === PANES.sidebar.default &&
      Math.round(g.rail) === PANES.rail.default &&
      ui?.sidebarWidth === PANES.sidebar.default &&
      ui.railWidth === PANES.rail.default
    );
  });
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
  const main = rect("#main-pane main");
  // A pane's width takes in its gutter, the edge (the sidebar's 8, the rail's 10).
  const sidebar = rect("#sidebar-pane").width;
  const rail = rect("#thread-pane").width;
  const railEdge = rect("#thread-pane-edge");
  return {
    sidebar: sidebar > 0.5 ? sidebar + 8 : 0,
    rail: rail > 0.5 ? rail + 10 : 0,
    railLeft: railEdge.left,
    mainLeft: main.left,
    mainRight: main.right,
    mainWidth: main.width,
    chromeLeftEnd: header.firstElementChild!.getBoundingClientRect().right,
    // The rail's divider, the chrome's last (the right side's `| … [toggle]`).
    railDividerRight: [...header.querySelectorAll("[data-chrome-divider]")]
      .at(-1)!
      .getBoundingClientRect().right,
  };
}

interface Easing {
  /** Whether the window wore `data-pane-motion` at any moment since. */
  marked: boolean;
  /** What eased, on which property, for how long. */
  transitions: { target: string; property: string; ms: number }[];
}

/**
 * Watches, from now, for the transitions the panes' panels start, and for the window's
 * `data-pane-motion`: each caught as the change that starts it lands (a MutationObserver, before
 * a frame is drawn), so none can have finished first, however few frames the machine paints or
 * however long the test's round trips take. The function it gives back stops watching and says
 * what it saw.
 */
async function watchEasing(page: Page): Promise<() => Promise<Easing>> {
  await page.evaluate(() => {
    type Seen = { target: string; property: string; ms: number };
    const seen = new Map<Animation, Seen>();
    let marked = !!document.querySelector("[data-pane-motion]");
    const look = () => {
      if (document.querySelector("[data-pane-motion]")) marked = true;
      for (const a of document.getAnimations()) {
        const target = (a.effect as KeyframeEffect | null)?.target;
        if (seen.has(a) || !("transitionProperty" in a) || !(target instanceof Element)) continue;
        if (!target.matches("[data-panel]")) continue;
        seen.set(a, {
          target: target.id,
          property: (a as Animation & { transitionProperty: string }).transitionProperty,
          ms: Number(a.effect!.getComputedTiming().duration),
        });
      }
    };
    const observer = new MutationObserver(look);
    observer.observe(document.body, { subtree: true, attributes: true, childList: true });
    (window as unknown as { easing: () => unknown }).easing = () => {
      look();
      observer.disconnect();
      return { marked, transitions: [...seen.values()] };
    };
  });
  return () => page.evaluate(() => (window as unknown as { easing: () => Easing }).easing());
}

/** What the window keeps for Maya between launches. */
function saved(page: Page): Promise<{ sidebarWidth?: number; railWidth?: number } | null> {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith("ponzu.ui."));
    return key ? JSON.parse(localStorage.getItem(key)!) : null;
  });
}
