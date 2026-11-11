/*
 * The window's chrome and panes in a real Chromium, frame by frame: the sidebar and the rail
 * open and close on one clock, the chrome over them moves on it too, ⌘B and ⌘J work from
 * anywhere, and a click never leaves a ring. Skips where there is no Chrome or Chromium.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  type Browser,
  buildGallery,
  chromiumPath,
  type Frame,
  launch,
  type Page,
  sampleToggle,
  serve,
} from "../../../scripts/visual-lib.ts";

setDefaultTimeout(60_000);

/** How far along the move each frame is, by `key`, from the first frame to the last. */
function progress(frames: Frame[], key: keyof Frame): number[] {
  const from = frames[0]![key];
  const to = frames.at(-1)![key];
  return frames.map((f) => (f[key] - from) / (to - from));
}

/** The largest distance between `key` and where the pane's clock says it should be. */
function drift(frames: Frame[], clock: number[], key: keyof Frame): number {
  const from = frames[0]![key];
  const to = frames.at(-1)![key];
  return Math.max(...frames.map((f, i) => Math.abs(f[key] - (from + (to - from) * clock[i]!))));
}

/** From the first frame that moved to the first that rested, in ms. */
function duration(frames: Frame[], key: keyof Frame): number {
  const end = frames.at(-1)![key];
  const start = frames.findIndex((f) => f[key] !== frames[0]![key]);
  const rest = frames.findIndex((f, i) => i >= start && Math.abs(f[key] - end) < 0.01);
  return frames[rest]!.t - frames[start - 1]!.t;
}

describe.skipIf(!chromiumPath)("the window's panes and chrome", () => {
  let built: Awaited<ReturnType<typeof buildGallery>>;
  let server: ReturnType<typeof serve>;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    built = await buildGallery();
    server = serve(built.dir);
    browser = await launch();
    page = await browser.newPage();
  });
  afterAll(async () => {
    await browser?.close();
    server?.stop();
    built?.dispose();
  });

  const open = async (board: string, motion: "reduce" | "no-preference" = "reduce") => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: motion });
    await page.goto(`${server.url}/gallery.html?board=${board}&theme=light`);
    await page.waitForFunction(() => (window as { galleryReady?: boolean }).galleryReady === true);
  };
  const SIDEBAR = 'button[aria-controls="sidebar"]';
  const THREAD = 'button[aria-controls="thread"]';

  test("each pane opens and closes on one clock, and the chrome moves on it within a pixel", async () => {
    await open("team-sidebar", "no-preference");
    const times: number[] = [];
    for (const state of ["closing", "opening"]) {
      const sidebar = await sampleToggle(page, SIDEBAR);
      const clock = progress(sidebar, "left");
      // Many frames between, not a jump.
      expect(sidebar.filter((_, i) => clock[i]! > 0.05 && clock[i]! < 0.95).length).toBeGreaterThan(
        4,
      );
      expect(drift(sidebar, clock, "divider")).toBeLessThanOrEqual(1);
      expect(drift(sidebar, clock, "tab")).toBeLessThanOrEqual(1);
      expect(drift(sidebar, clock, "title")).toBeLessThanOrEqual(1);
      // The name is set once and only clipped by its room: never re-cut frame by frame.
      // (Within half a pixel: the name's face can finish loading as it first shows.)
      const widths = sidebar.map((f) => f.titleText);
      expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(0.5);
      // The right side holds still.
      expect(drift(sidebar, clock, "thread")).toBe(0);
      expect(drift(sidebar, clock, "right")).toBe(0);
      times.push(duration(sidebar, "left"));

      const rail = await sampleToggle(page, THREAD);
      const railClock = progress(rail, "right");
      expect(
        rail.filter((_, i) => railClock[i]! > 0.05 && railClock[i]! < 0.95).length,
      ).toBeGreaterThan(4);
      // The cluster's divider keeps to the cluster, which holds still at the window's edge.
      expect(drift(rail, railClock, "railDivider")).toBe(0);
      expect(drift(rail, railClock, "left")).toBe(0);
      expect(drift(rail, railClock, "tab")).toBe(0);
      expect(drift(rail, railClock, "thread")).toBe(0);
      times.push(duration(rail, "right"));
      if (state === "opening") {
        // Open, the tabs' divider is on the sidebar's edge.
        const last = rail.at(-1)!;
        expect(Math.abs(last.divider - last.left)).toBeLessThanOrEqual(1);
      }
    }
    // Left and right, opening and closing, take the same time: within a frame.
    expect(Math.max(...times) - Math.min(...times)).toBeLessThanOrEqual(20);
  });

  test("with reduced motion a pane is open or closed from the next frame", async () => {
    await open("team-sidebar");
    for (const selector of [SIDEBAR, THREAD]) {
      const frames = await sampleToggle(page, selector);
      const moved = frames.filter(
        (f) => f.left !== frames[0]!.left || f.right !== frames[0]!.right,
      );
      expect(new Set(moved.map((f) => `${f.left} ${f.right}`)).size).toBe(1);
    }
  });

  test("collapsed, the name sits before the divider; open, the divider is on the sidebar's edge", async () => {
    await open("sidebar-collapsed");
    const at = () =>
      page.evaluate(() => {
        const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
        return {
          toggle: r('button[aria-controls="sidebar"]').right,
          title: r("[data-chrome-title]"),
          divider: r("header [data-chrome-divider]").left,
          tab: r('header [role="tab"]').left,
          main: r("main").left,
        };
      });
    const closed = await at();
    expect(await page.textContent("[data-chrome-title]")).toBe("Quieter shop hero");
    expect(closed.title.left).toBeGreaterThanOrEqual(closed.toggle);
    expect(closed.divider).toBeGreaterThanOrEqual(closed.title.right - 1);
    expect(closed.tab).toBeGreaterThan(closed.divider);
    await page.click(SIDEBAR);
    const opened = await at();
    expect(opened.title.width).toBe(0);
    expect(opened.divider).toBe(opened.main);
    // The create page: nothing past the toggle, and no divider.
    await open("create");
    expect(await page.$$eval("header [data-chrome-divider]", (els) => els.length)).toBe(0);
  });

  test("⌘B toggles the sidebar from the window and from a composer, ⌘J the rail", async () => {
    await open("thread-in-the-right-rail");
    const expanded = (s: string) => page.getAttribute(s, "aria-expanded");
    expect(await expanded(SIDEBAR)).toBe("true");
    await page.keyboard.press("Meta+b");
    expect(await expanded(SIDEBAR)).toBe("false");
    await page.click("#thread textarea");
    await page.keyboard.type("Make it");
    await page.keyboard.press("Meta+b");
    expect(await expanded(SIDEBAR)).toBe("true");
    expect(await page.inputValue("#thread textarea")).toBe("Make it");
    await page.keyboard.press("Control+b");
    expect(await expanded(SIDEBAR)).toBe("false");
    await page.keyboard.press("Meta+j");
    expect(await expanded(THREAD)).toBe("false");
    await page.keyboard.press("Meta+j");
    expect(await expanded(THREAD)).toBe("true");
  });

  test("⌘B and ⌘J leave the panes alone under a menu, and while a row's name is edited", async () => {
    await open("team-sidebar");
    const expanded = (s: string) => page.getAttribute(s, "aria-expanded");
    await page.click('#sidebar button[aria-label^="Workspace:"]');
    await page.waitForSelector("[role=menu]");
    await page.keyboard.press("Meta+b");
    await page.keyboard.press("Meta+j");
    expect(await expanded(SIDEBAR)).toBe("true");
    expect(await expanded(THREAD)).toBe("true");
    expect(await page.$("[role=menu]")).not.toBeNull();
    await page.keyboard.press("Escape");
    await page.waitForSelector("[role=menu]", { state: "detached" });

    await page.click("#sidebar [aria-current]", { button: "right" });
    await page.click('[role=menuitem]:has-text("Rename")');
    await page.waitForSelector('input[aria-label="Design name"]');
    await page.waitForSelector("[role=menu]", { state: "detached" });
    await page.keyboard.press("Meta+b");
    expect(await expanded(SIDEBAR)).toBe("true");
    expect(await page.$('input[aria-label="Design name"]')).not.toBeNull();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Meta+b");
    expect(await expanded(SIDEBAR)).toBe("false");
  });

  test("after a click on a toolbar control, the canvas's keys light no ring and press nothing", async () => {
    await open("team-sidebar");
    const state = () =>
      page.evaluate(() => {
        const el = document.activeElement as HTMLElement;
        return {
          ring: el.matches(":focus-visible:not([data-quiet-focus])"),
          sidebar: document
            .querySelector('[aria-controls="sidebar"]')!
            .getAttribute("aria-expanded"),
          thread: document.querySelector('[aria-controls="thread"]')!.getAttribute("aria-expanded"),
        };
      });
    for (const selector of [SIDEBAR, THREAD, 'header [role="tab"]:nth-child(2)']) {
      await page.click(selector);
      const after = await state();
      expect(after.ring).toBe(false);
      for (const key of ["c", "Space", "Escape", "Enter", "ArrowLeft"]) {
        await page.keyboard.press(key);
        expect(await state()).toEqual(after);
      }
    }
  });

  test("a click leaves no ring on any control; the keyboard brings it back", async () => {
    await open("team-sidebar");
    const ring = () =>
      page.evaluate(() => {
        const el = document.activeElement as HTMLElement;
        return {
          name: el.getAttribute("aria-label") ?? el.textContent?.trim(),
          // What focus-ring (cloud.css) draws on.
          ring: el.matches(":focus-visible:not([data-quiet-focus])"),
        };
      });
    for (const selector of [
      SIDEBAR,
      THREAD,
      'header [role="tab"]:nth-child(2)',
      'button[aria-label="New page"]',
    ]) {
      await page.click(selector);
      expect((await ring()).ring).toBe(false);
      // Keys that Chromium counts as the keyboard's, though no focus moved: still none.
      await page.keyboard.press("Shift");
      expect((await ring()).ring).toBe(false);
      await page.mouse.move(700, 600);
      // Focus a click handed on (a pane re-rendering, a popup giving it back) is quiet too.
      await page.evaluate((s) => {
        const el = document.querySelector<HTMLElement>(s)!;
        el.blur();
        el.focus();
      }, selector);
      expect((await ring()).ring).toBe(false);
    }
    // A click leaves focus where it was; Tab moves it on and rings where it lands, and reaches
    // the toggles.
    await page.click(SIDEBAR);
    await page.keyboard.press("Tab");
    expect((await ring()).ring).toBe(true);
    let reached = await ring();
    for (let i = 0; i < 60 && reached.name !== "Toggle sidebar"; i++) {
      await page.keyboard.press("Shift+Tab");
      reached = await ring();
    }
    expect(reached).toEqual({ name: "Toggle sidebar", ring: true });
  });
});
