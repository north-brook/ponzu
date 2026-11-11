/*
 * The cloud gallery's components in a real Chromium: the sidebar's keyboard and focus
 * behaviour, its menus, search and presence. Creating a design, the repo picker, the page tabs
 * and the pull request tab are in gallery.create.test.ts; the compositions against their
 * references in gallery.references.*.test.ts. Skips where there is no Chrome or Chromium.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  type Browser,
  buildGallery,
  chromiumPath,
  fontsLoaded,
  launch,
  type Page,
  serve,
} from "../../../scripts/visual-lib.ts";

setDefaultTimeout(60_000);

describe.skipIf(!chromiumPath)("the cloud gallery", () => {
  let built: Awaited<ReturnType<typeof buildGallery>>;
  let server: ReturnType<typeof serve>;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    built = await buildGallery();
    server = serve(built.dir);
    browser = await launch();
    page = await browser.newPage();
    // The app's fonts, loaded once into the browser's cache before the first test measures.
    await page.goto(`${server.url}/gallery.html?board=team-sidebar`);
    await fontsLoaded(page);
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
    // Back where ⌘K found it: nowhere, so the next key goes to the window, and the Search
    // button is left alone: focus there would raise its tooltip, unasked.
    await page.waitForFunction(() => document.activeElement === document.body);
    expect(await page.$('[role="tooltip"]')).toBeNull();
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
});
