/*
 * The cloud gallery in a real Chromium: its compositions against their references (the picture
 * for layout, the painted styles for color and type), and the components' keyboard and focus
 * behaviour. Skips where there is no Chrome or Chromium.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import {
  type Browser,
  buildGallery,
  chromiumPath,
  compare,
  fontsLoaded,
  launch,
  type Page,
  paintedStyles,
  REFERENCES,
  serve,
  shootComposition,
} from "../../../scripts/visual-lib.ts";
import { COMPOSITIONS } from "./compositions.ts";

setDefaultTimeout(60_000);

/**
 * At most this share of a picture may differ from its reference. Text is hidden in both, so what
 * is left is layout, grounds, icons and shadows; this leaves room for antialiasing between GPUs
 * and operating systems, and catches a moved row or a changed ground. Small things (a text or
 * icon color, a weight) are below it: the painted styles catch those.
 */
const TOLERANCE = 0.002;

describe.skipIf(!chromiumPath)("the cloud gallery", () => {
  let built: Awaited<ReturnType<typeof buildGallery>>;
  let server: ReturnType<typeof serve>;
  let browser: Browser;
  let page: Page;
  let fonts = false;

  beforeAll(async () => {
    built = await buildGallery();
    server = serve(built.dir);
    browser = await launch();
    page = await browser.newPage();
    await page.goto(`${server.url}/gallery.html?board=team-sidebar`);
    fonts = await fontsLoaded(page);
  });
  afterAll(async () => {
    await browser?.close();
    server?.stop();
    built?.dispose();
  });

  const open = async (board: string, size = { width: 1440, height: 900 }) => {
    await page.setViewportSize(size);
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.goto(`${server.url}/gallery.html?board=${board}&theme=light`);
    await page.waitForFunction(() => (window as { galleryReady?: boolean }).galleryReady === true);
  };
  /** Waits for focus to land on the element named `name` (its label, else its text). */
  const focusOn = (name: string) =>
    page.waitForFunction(
      (name) => {
        const el = document.activeElement;
        return (el?.getAttribute("aria-label") ?? el?.textContent?.trim()) === name;
      },
      name,
      { timeout: 2000 },
    );

  for (const c of COMPOSITIONS.filter((c) => c.reference)) {
    for (const theme of ["light", "dark"] as const) {
      test(`${c.id} in ${theme} matches its reference`, async () => {
        // Without the app's fonts every line measures differently; that is the network, not us.
        if (!fonts) return console.warn("The app's fonts didn't load; references not compared.");
        const shot = await shootComposition(page, server.url, c, theme, { hideText: true });
        const reference = Buffer.from(
          await Bun.file(join(REFERENCES, `${c.id}-${theme}.png`)).arrayBuffer(),
        );
        const tool = await browser.newPage();
        const diff = await compare(tool, reference, shot);
        await tool.close();
        expect(diff.changed).toBeLessThan(TOLERANCE);
      });

      test(`${c.id} in ${theme} paints with its reference's styles`, async () => {
        await shootComposition(page, server.url, c, theme);
        const expected = await Bun.file(join(REFERENCES, `${c.id}-${theme}.styles.txt`)).text();
        expect(await paintedStyles(page)).toBe(expected);
      });
    }
  }

  test("the team menu is a keyboard menu that returns focus to its trigger", async () => {
    await open("team-sidebar");
    await page.focus('button[aria-label^="Workspace"]');
    await page.keyboard.press("Enter");
    await page.waitForSelector('[role="menu"]');
    const names = await page.$$eval('[role="menuitemradio"]', (els) =>
      els.map((e) => e.querySelector("span:not([aria-hidden])")?.textContent),
    );
    expect(names).toEqual(["Northbrook", "Fablefuel", "Personal"]);
    // Typeahead jumps to the row that starts with the letters typed, by its name alone.
    await page.keyboard.press("f");
    await page.waitForFunction(() => document.activeElement?.textContent?.endsWith("Fablefuel"));
    await page.waitForTimeout(1100);
    await page.keyboard.type("pl");
    await focusOn("Plan and usage");
    await page.keyboard.press("End");
    await focusOn("Sign out");
    await page.keyboard.press("Home");
    await focusOn("Northbrook");
    await page.keyboard.press("Escape");
    await page.waitForSelector('[role="menu"]', { state: "detached" });
    await focusOn("Workspace: Northbrook");
  });

  test("the filter narrows the list as you choose, stays open, and marks itself on", async () => {
    await open("team-sidebar");
    const rows = () => page.$$eval("[data-design-row]", (els) => els.length);
    expect(await rows()).toBe(6);
    await page.click('button[aria-label="Filter"]');
    await page.click('[role="menuitemcheckbox"]:has-text("fernwood")');
    await page.click('[role="menuitemcheckbox"]:has-text("brand")');
    // Still open: a checkbox doesn't close the menu.
    expect(await page.$('[role="menu"]')).not.toBeNull();
    expect(await rows()).toBe(2);
    await page.click('[role="menuitemradio"]:has-text("Sam Kim")');
    expect(await rows()).toBe(0);
    await page.keyboard.press("Escape");
    expect(await page.$('button[aria-label="Filter (on)"]')).not.toBeNull();
    await page.click('button:has-text("Clear filter")');
    expect(await rows()).toBe(6);
  });

  test("search: ⌘K opens it, an empty query keeps the list, arrows and Escape work", async () => {
    await open("team-sidebar");
    await page.keyboard.press("Meta+k");
    const field = 'input[role="combobox"]';
    await page.waitForSelector(field);
    await focusOn("Search designs, boards and comments");
    expect(await page.$$eval("[data-design-row]", (els) => els.length)).toBe(6);
    await page.keyboard.type("hero");
    await page.waitForSelector('[role="listbox"]');
    const active = () => page.$eval(field, (el) => el.getAttribute("aria-activedescendant"));
    expect(await active()).toBe("search-design-dsn_quieter");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    expect(await active()).toBe("search-board-ab_hero_b");
    await page.keyboard.press("ArrowUp");
    expect(await active()).toBe("search-design-dsn_settled_1");
    await page.keyboard.press("Escape");
    await page.waitForSelector(field, { state: "detached" });
    await focusOn("Search");
  });

  test("⌘K with the sidebar collapsed opens it, then searches", async () => {
    await open("sidebar-collapsed");
    expect(await page.$eval("#sidebar", (el) => el.hasAttribute("inert"))).toBe(true);
    await page.keyboard.press("Meta+k");
    await focusOn("Search designs, boards and comments");
    expect(await page.$eval("#sidebar", (el) => el.hasAttribute("inert"))).toBe(false);
    // Focused without scrolling the pane's content aside while it opens.
    expect(await page.$eval("#sidebar", (el) => el.scrollLeft)).toBe(0);
  });

  test("the search selection keeps itself in view", async () => {
    await open("sidebar-search", { width: 1100, height: 640 });
    // Enough results to run past the pane at the smallest window.
    await page.keyboard.type("e");
    const count = await page.$$eval('[role="option"]', (els) => els.length);
    for (let i = 1; i < count; i++) await page.keyboard.press("ArrowDown");
    const inView = await page.evaluate(() => {
      const id = document.activeElement?.getAttribute("aria-activedescendant");
      const option = document.getElementById(id ?? "")!.getBoundingClientRect();
      const list = document.getElementById("search-results")!.parentElement!;
      const box = list.getBoundingClientRect();
      return list.scrollTop > 0 && option.top >= box.top && option.bottom <= box.bottom;
    });
    expect(inView).toBe(true);
  });

  test("⌘J opens and closes the thread rail", async () => {
    await open("team-sidebar");
    const expanded = () =>
      page.$eval('button[aria-controls="thread"]', (b) => b.getAttribute("aria-expanded"));
    expect(await expanded()).toBe("true");
    await page.keyboard.press("Meta+j");
    expect(await expanded()).toBe("false");
    await page.keyboard.press("Meta+j");
    expect(await expanded()).toBe("true");
  });

  test("presence is one Tab stop, and each person's tip shows from the keyboard", async () => {
    await open("team-sidebar");
    await page.focus('[aria-label="Bryce (you)"]');
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
    await focusOn("Jordan · last here 2 days ago");
    await page.waitForSelector('[role="tooltip"]:has-text("Jordan · last here 2 days ago")');
    const stops = await page.$$eval(
      '[aria-label="People in this design"] [role="img"]',
      (els) => els.filter((e) => e.tabIndex === 0).length,
    );
    expect(stops).toBe(1);
  });

  test("unchecking a repo keeps Scratch's designs, and Scratch has its own box", async () => {
    await open("create");
    const names = () =>
      page.$$eval("[data-design-row]", (els) => els.map((e) => e.textContent ?? ""));
    await page.click('button[aria-label="Filter"]');
    await page.click('[role="menuitemcheckbox"]:has-text("brand")');
    expect((await names()).some((n) => n.includes("Autumn drop moodboard"))).toBe(true);
    expect((await names()).some((n) => n.includes("Brand kit"))).toBe(false);
    await page.click('[role="menuitemcheckbox"]:has-text("Scratch")');
    expect((await names()).some((n) => n.includes("Autumn drop moodboard"))).toBe(false);
  });

  test("at the smallest window the active page tab stays whole and clear of the fade", async () => {
    await open("team-sidebar", { width: 1100, height: 640 });
    const clear = await page.evaluate(() => {
      const tab = document.querySelector('[role="tab"][aria-selected="true"]')!;
      const strip = tab.closest('[role="tablist"]')!.parentElement!.getBoundingClientRect();
      const t = tab.getBoundingClientRect();
      return t.left >= strip.left && t.right <= strip.right - 16;
    });
    expect(clear).toBe(true);
    // And the chrome still fits: the thread toggle is in the window.
    const toggle = await page.$eval('button[aria-controls="thread"]', (b) => {
      const r = b.getBoundingClientRect();
      return r.right <= window.innerWidth;
    });
    expect(toggle).toBe(true);
  });

  test("the working slice turns, and holds still for reduced motion", async () => {
    const duration = () =>
      page.$eval('[aria-label="Working"]', (el) => getComputedStyle(el).animationDuration);
    await open("team-sidebar");
    expect(await duration()).toBe("0s");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    expect(await duration()).toBe("1.2s");
  });

  test("search with no matches says so", async () => {
    await open("sidebar-search");
    await page.keyboard.type("zebra");
    expect(await page.textContent('[role="status"]')).toBe("No results for “zebra”");
  });

  test("the design list is one Tab stop that the arrows move through", async () => {
    await open("team-sidebar");
    await page.focus('[data-design-row="dsn_quieter"]');
    await page.keyboard.press("ArrowDown");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-design-row"))).toBe(
      "dsn_checkout",
    );
    await page.keyboard.press("End");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-design-row"))).toBe(
      "dsn_brand",
    );
    const stops = await page.$$eval(
      "[data-design-row]",
      (els) => els.filter((e) => e.tabIndex === 0).length,
    );
    expect(stops).toBe(1);
  });

  test("the composer sends only something, and an idea fills it without sending", async () => {
    await open("fresh-start");
    const send = 'button[aria-label="Send"]';
    const disabled = () => page.$eval(send, (b) => b.getAttribute("aria-disabled") === "true");
    expect(await disabled()).toBe(true);
    await page.fill("textarea", "   ");
    expect(await disabled()).toBe(true);
    await page.click('button:has-text("A dark mode for the shop")');
    expect(await page.inputValue("textarea")).toBe(
      "A dark mode for the shop, using the tokens you already have",
    );
    await page.waitForFunction(() => document.activeElement?.tagName === "TEXTAREA");
    expect(await disabled()).toBe(false);
  });

  test("the repo picker filters as you type and chooses with Return", async () => {
    await open("create");
    await page.click('button[aria-label^="Project"]');
    await page.waitForSelector('input[aria-label="Search repositories"]');
    await page.keyboard.type("len");
    const options = await page.$$eval('[role="option"]', (els) => els.map((e) => e.id));
    expect(options).toEqual(["project-repo_lenny"]);
    await page.keyboard.press("Enter");
    await page.waitForSelector('input[aria-label="Search repositories"]', { state: "detached" });
    expect(await page.textContent('button[aria-label^="Project"]')).toBe("lenny");
    await focusOn("Project: lenny");
  });
});
