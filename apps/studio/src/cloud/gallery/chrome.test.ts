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
  // Within a layout unit (1/64px) of where it ends: the panes are laid out as shares of the
  // window, and the last unit can land with the easing's end rather than its last frame.
  const rest = frames.findIndex((f, i) => i >= start && Math.abs(f[key] - end) <= 1 / 64 + 0.001);
  return frames[rest]!.t - frames[start - 1]!.t;
}

/** The longest time between two frames while the pane moved, in ms. */
function gap(frames: Frame[]): number {
  const moving = frames.slice(1, -1);
  return Math.max(0, ...moving.slice(1).map((f, i) => f.t - moving[i]!.t));
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
    // The panes' clock slowed to a second, so even a busy machine (CI) draws many frames of each
    // move; the hover clock with it, in proportion (the name's fade).
    await page.addStyleTag({
      content: ":root { --dur-pane: 1000ms !important; --dur-hover: 545ms !important; }",
    });
    const times: number[] = [];
    const gaps: number[] = [];
    for (const state of ["closing", "opening"]) {
      const sidebar = await sampleToggle(page, SIDEBAR);
      const clock = progress(sidebar, "left");
      // Frames between, not a jump (a busy CI machine draws fewer of them).
      expect(
        sidebar.filter((_, i) => clock[i]! > 0.05 && clock[i]! < 0.95).length,
      ).toBeGreaterThanOrEqual(5);
      gaps.push(gap(sidebar));
      expect(drift(sidebar, clock, "divider")).toBeLessThanOrEqual(1);
      expect(drift(sidebar, clock, "tab")).toBeLessThanOrEqual(1);
      expect(drift(sidebar, clock, "title")).toBeLessThanOrEqual(1);
      // The name is set once and only clipped by its room: never re-cut frame by frame.
      // (Within half a pixel: the name's face can finish loading as it first shows.)
      const widths = sidebar.map((f) => f.titleText);
      expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(0.5);
      // The right side holds still.
      // (Within a layout unit, 1/64px: the panes are laid out as shares of the window.)
      expect(drift(sidebar, clock, "thread")).toBeLessThanOrEqual(1 / 64);
      expect(drift(sidebar, clock, "right")).toBeLessThanOrEqual(1 / 64);
      expect(drift(sidebar, clock, "railDivider")).toBeLessThanOrEqual(1 / 64);
      times.push(duration(sidebar, "left"));

      const rail = await sampleToggle(page, THREAD);
      const railClock = progress(rail, "right");
      expect(
        rail.filter((_, i) => railClock[i]! > 0.05 && railClock[i]! < 0.95).length,
      ).toBeGreaterThanOrEqual(5);
      gaps.push(gap(rail));
      // The rail's divider is on the canvas's right edge (its pixel the canvas's last) in every
      // frame, until the edge passes where the divider rests with the rail closed, 12 before
      // the toggle; there it holds.
      const rest = Math.max(...rail.map((f) => f.railDivider + 1));
      const off = rail.map((f) => f.railDivider + 1 - Math.min(f.right, rest));
      expect(Math.max(...off.map(Math.abs))).toBeLessThanOrEqual(1);
      expect(drift(rail, railClock, "left")).toBeLessThanOrEqual(1 / 64);
      expect(drift(rail, railClock, "tab")).toBeLessThanOrEqual(1 / 64);
      expect(drift(rail, railClock, "thread")).toBeLessThanOrEqual(1 / 64);
      times.push(duration(rail, "right"));
      if (state === "opening") {
        // Open, the tabs' divider is on the sidebar's edge.
        const last = rail.at(-1)!;
        expect(Math.abs(last.divider - last.left)).toBeLessThanOrEqual(1);
      }
    }
    // Left and right run on one clock: everything that moves with a pane has the same duration
    // and easing while a toggle eases (`data-pane-motion`; at any other time, a drag included,
    // nothing eases). The panes themselves are the resizable panels.
    const clocks = await page.evaluate(() => {
      const frame = document.querySelector("header")!.parentElement!;
      frame.setAttribute("data-pane-motion", "");
      const read = [
        "#sidebar-pane",
        "#thread-pane",
        "main",
        "header > div:first-child",
        "[data-chrome-title]",
        "[data-chrome-rail]",
      ].map((s) => {
        const cs = getComputedStyle(document.querySelector(s)!);
        return `${cs.transitionDuration.split(",")[0]} ${cs.transitionTimingFunction.split(",")[0]}`;
      });
      frame.removeAttribute("data-pane-motion");
      return read;
    });
    expect(new Set(clocks).size).toBe(1);
    // And measured, they take the same time: within a frame at either end. Only where the machine
    // drew frames steadily; a busy one (CI) can stall long enough to say nothing.
    if (Math.max(...gaps) <= 34) {
      expect(Math.max(...times) - Math.min(...times)).toBeLessThanOrEqual(
        2 * Math.max(10, ...gaps),
      );
    }
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
    expect(Math.abs(opened.divider - opened.main)).toBeLessThanOrEqual(1 / 64);
    // The create page: nothing past the toggle, and no divider.
    await open("create");
    expect(await page.$$eval("header [data-chrome-divider]", (els) => els.length)).toBe(0);
  });

  /** The right side of the chrome, as boxes. */
  const rightSide = () =>
    page.evaluate(() => {
      const box = (el: Element | null | undefined) => {
        const b = el!.getBoundingClientRect();
        return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
      };
      const header = document.querySelector("header")!;
      const rail = header.querySelector("[data-chrome-rail]")!;
      // The cluster is the block's sibling before the 12 between them.
      const cluster = rail.previousElementSibling?.previousElementSibling;
      const tabs = header.querySelector('[role="tablist"]')!.parentElement!.parentElement!;
      const plus = header.querySelector('button[aria-label="New page"]');
      return {
        width: window.innerWidth,
        main: box(document.querySelector("main")),
        divider: box(rail.querySelector("[data-chrome-divider]")),
        toggle: box(header.querySelector('[aria-controls="thread"]')),
        cluster: cluster ? box(cluster) : null,
        clusterHeight: cluster ? cluster.getBoundingClientRect().height : 0,
        tabsEnd: Math.max(box(tabs).right, plus ? box(plus).right : 0),
        overflow: header.scrollWidth - header.clientWidth,
      };
    });

  test("the right side mirrors the left: [people] [action] | … [toggle], the divider on the canvas's edge", async () => {
    const cases: [string, "open" | "closed", { width: number; height: number }?][] = [
      ["team-sidebar", "open"],
      ["thread-in-the-right-rail", "open"],
      ["crowded-chrome", "open"],
      ["sidebar-collapsed", "closed"],
      ["crowded-chrome-closed", "closed"],
      // The pull request tab leaves the rail as it was: open here, closed in the other board.
      ["pull-request-tab", "open"],
      ["pull-request-rail-closed", "closed"],
      ["min-window", "open", { width: 1100, height: 640 }],
      ["min-window-collapsed", "open", { width: 1100, height: 640 }],
      ["crowded-chrome-min-window", "open", { width: 1100, height: 640 }],
    ];
    for (const [board, rail, size] of cases) {
      await open(board);
      if (size) {
        await page.setViewportSize(size);
        // The panels lay themselves out again for the new width (fitPanes) a frame or so after
        // it, and write the rail's width (with its 10 of gutter) to `--pane-rail`: measured once
        // the two agree, so a pane or a variable stuck at the wrong width still fails.
        await page.waitForFunction(
          () => {
            const rail = document.querySelector("#thread-pane")!.getBoundingClientRect().width;
            const frame = document.querySelector("header")!.parentElement!;
            const width = Number.parseFloat(
              getComputedStyle(frame).getPropertyValue("--pane-rail"),
            );
            return Math.abs(rail + 10 - width) <= 1 / 64;
          },
          undefined,
          { timeout: 2000 },
        );
      }
      const at = await rightSide();
      // The toggle 10 from the window's edge, always.
      expect(at.toggle.right).toBe(at.width - 10);
      if (rail === "open") {
        // The divider's pixel is the canvas's last column, as the left one's is its first
        // (within a layout unit, 1/64px: the panes are laid out as shares of the window).
        expect(Math.abs(at.divider.right - at.main.right)).toBeLessThanOrEqual(1 / 64);
      } else {
        // Divider, 12, toggle, together at the window's edge.
        expect(at.toggle.left - at.divider.right).toBe(12);
      }
      if (at.cluster) {
        // The cluster ends 12 before the divider, on one line, whole.
        expect(at.divider.left - at.cluster.right).toBe(12);
        expect(at.clusterHeight).toBe(28);
        // The page tabs give way before it: never under it.
        expect(at.tabsEnd).toBeLessThanOrEqual(at.cluster.left);
      }
      expect(at.overflow).toBe(0);
    }
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

  /** Every element on the page whose focus ring shows, by name. */
  const rings = () =>
    page.evaluate(() =>
      [...document.querySelectorAll(":focus-visible:not([data-quiet-focus])")]
        .filter((el) => !el.matches("input, textarea"))
        .map((el) => el.getAttribute("aria-label") ?? el.textContent?.trim()),
    );

  test("a shortcut, or a modifier held for one, never lights a control", async () => {
    await open("thread-in-the-right-rail");
    // The founder's case: Search (and its tip) after ⌘K and Escape, with ⌘ and ⌥ held after.
    await page.click("#thread textarea");
    await page.keyboard.press("Meta+k");
    await page.waitForSelector('input[role="combobox"]');
    await page.keyboard.press("Escape");
    await page.waitForSelector('input[role="combobox"]', { state: "detached" });
    // Search gives focus back where ⌘K found it: the composer.
    await page.waitForFunction(() => document.activeElement?.tagName === "TEXTAREA");
    for (const key of ["Meta", "Alt", "Shift", "Control"]) {
      await page.keyboard.down(key);
      await new Promise((r) => setTimeout(r, 300));
      expect(await rings()).toEqual([]);
      await page.keyboard.up(key);
    }
    // A click on a control that keeps its focus (a design's row), then shortcuts, Return and
    // the modifiers: quiet throughout, and no tip.
    await page.click('#sidebar [data-design-row="dsn_pricing"]');
    for (const key of ["Meta", "Alt", "Meta+j", "Meta+j", "Meta+b", "Meta+b", "Enter", "Space"]) {
      await page.keyboard.press(key);
      expect(await rings()).toEqual([]);
    }
    expect(await page.$('[data-slot="tooltip-content"]')).toBeNull();
    // A click on Search takes no focus; Escape gives it back where it was, which was nowhere.
    await page.click('#sidebar button[aria-label="Search"]');
    await page.waitForSelector('input[role="combobox"]');
    await page.keyboard.press("Escape");
    await page.waitForSelector('input[role="combobox"]', { state: "detached" });
    await page.keyboard.down("Meta");
    expect(await rings()).toEqual([]);
    await page.keyboard.up("Meta");
    // Focus our own code moves after a key (a row back from renaming) is quiet too.
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('[data-design-row="dsn_pricing"]')!.focus();
    });
    expect(await rings()).toEqual([]);
  });

  test("keyboard navigation rings where it lands, and keeps it where focus comes back", async () => {
    await open("thread-in-the-right-rail");
    await page.click("#thread textarea");
    // Shift-Tab back from the composer until Search.
    let name: string | null | undefined;
    for (let i = 0; i < 60 && name !== "Search"; i++) {
      await page.keyboard.press("Shift+Tab");
      name = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    }
    expect(await rings()).toEqual(["Search"]);
    // Holding ⌘ changes nothing; Return opens search, Escape brings the ring back on Search.
    await page.keyboard.down("Meta");
    expect(await rings()).toEqual(["Search"]);
    await page.keyboard.up("Meta");
    await page.keyboard.press("Enter");
    await page.waitForSelector('input[role="combobox"]');
    await page.keyboard.press("Escape");
    await page.waitForSelector('input[role="combobox"]', { state: "detached" });
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("aria-label") === "Search",
    );
    expect(await rings()).toEqual(["Search"]);
    // Arrows in the design list move the ring with them.
    await page.focus('[data-design-row="dsn_quieter"]');
    await page.keyboard.press("ArrowDown");
    expect((await rings()).length).toBe(1);
    expect(
      await page.evaluate(() => document.activeElement?.getAttribute("data-design-row")),
    ).not.toBe("dsn_quieter");
  });

  test("a popover the keyboard opens rings where it puts focus; one a click opens doesn't", async () => {
    await open("team-sidebar");
    const share = 'header button[aria-label="Share"]';
    const inside = () =>
      page.evaluate(() => {
        const el = document.activeElement!;
        return {
          inPopover: !!el.closest("[data-radix-popper-content-wrapper]"),
          ring: el.matches(":focus-visible:not([data-quiet-focus])"),
        };
      });
    // Tab to Share and press Return: the popover's first control is the keyboard's.
    await page.mouse.click(700, 500);
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press("Tab");
      if (await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Share"))
        break;
    }
    expect(await rings()).toEqual(["Share"]);
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => !!document.activeElement?.closest("[data-radix-popper-content-wrapper]"),
    );
    expect(await inside()).toEqual({ inPopover: true, ring: true });
    // Escape gives focus back to Share, ringed.
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("aria-label") === "Share",
    );
    expect(await rings()).toEqual(["Share"]);
    // Opened by a click, it's quiet inside and after, whatever is held.
    await page.click(share);
    await page.waitForFunction(
      () => !!document.activeElement?.closest("[data-radix-popper-content-wrapper]"),
    );
    expect(await inside()).toEqual({ inPopover: true, ring: false });
    await page.keyboard.press("Escape");
    await page.keyboard.down("Meta");
    expect(await rings()).toEqual([]);
    await page.keyboard.up("Meta");
    // A moment after a press, focus our own code moves is quiet again.
    await new Promise((r) => setTimeout(r, 700));
    await page.evaluate(() =>
      document.querySelector<HTMLElement>('[aria-label="Filter"]')!.focus(),
    );
    expect(await rings()).toEqual([]);
  });
});
