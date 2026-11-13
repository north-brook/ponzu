/*
 * The cloud gallery's components in a real Chromium: the sidebar's keyboard and focus
 * behaviour, its menus, search and presence. Creating a canvas, the repo picker, the page tabs
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
    expect(names).toEqual(["Thistlewick", "Quillmoor", "Personal"]);
    // Typeahead jumps to the row that starts with the letter typed, by its name alone.
    await page.keyboard.press("q");
    await page.waitForFunction(() => document.activeElement?.textContent?.endsWith("Quillmoor"));
    await page.keyboard.press("End");
    await focusOn("Sign out");
    await page.keyboard.press("Home");
    await focusOn("Thistlewick");
    await page.keyboard.press("Escape");
    await page.waitForSelector('[role="menu"]', { state: "detached" });
    await focusOn("Workspace: Thistlewick");
  });
  test("the filter narrows the list as you choose, stays open, and marks itself on", async () => {
    await open("team-sidebar");
    const rows = () => page.$$eval("[data-canvas-row]", (els) => els.length);
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
  test("a long workspace name is cut short; the header's buttons keep their place", async () => {
    await open("team-sidebar");
    const header = () =>
      page.evaluate(() => {
        const trigger = document.querySelector<HTMLElement>(
          '#sidebar button[aria-label^="Workspace:"]',
        )!;
        const name = trigger.querySelector("span")!;
        const sidebar = document.querySelector("#sidebar")!.getBoundingClientRect();
        const buttons = ["Search", "Filter", "New canvas"].map((label) => {
          const r = document
            .querySelector(`#sidebar button[aria-label^="${label}"]`)!
            .getBoundingClientRect();
          return { left: Math.round(r.left), right: Math.round(r.right), width: r.width };
        });
        return {
          cut: name.scrollWidth > name.clientWidth,
          nameRight: Math.round(trigger.getBoundingClientRect().right),
          sidebarRight: Math.round(sidebar.right),
          buttons,
        };
      });
    const before = await header();
    expect(before.cut).toBe(false);
    // The same header with a name far too long for it (the text alone: nothing else changes).
    await page.evaluate(() => {
      const name = document.querySelector('#sidebar button[aria-label^="Workspace:"] span')!;
      name.textContent = "The Thistlewick Institute for Uncommonly Long Workspace Names";
    });
    const after = await header();
    expect(after.cut).toBe(true);
    // Each button where it was and as wide as it was, inside the sidebar.
    expect(after.buttons).toEqual(before.buttons);
    expect(after.buttons.at(-1)!.right).toBeLessThanOrEqual(after.sidebarRight);
    // And the name stops short of them.
    expect(after.buttons[0]!.left - after.nameRight).toBeGreaterThanOrEqual(8);
  });

  test("search: ⌘K opens it, an empty query keeps the list, arrows and Escape work", async () => {
    await open("team-sidebar");
    await page.keyboard.press("Meta+k");
    const field = 'input[role="combobox"]';
    await page.waitForSelector(field);
    await focusOn("Search canvases, boards, comments and messages");
    expect(await page.$$eval("[data-canvas-row]", (els) => els.length)).toBe(6);
    await page.keyboard.type("hero");
    await page.waitForSelector('[role="listbox"]');
    const active = () => page.$eval(field, (el) => el.getAttribute("aria-activedescendant"));
    expect(await active()).toBe("search-canvas-cnv_quieter");
    // Said for someone who can't see the list: how many there are.
    expect(await page.textContent('[role="status"]')).toBe("5 results");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    expect(await active()).toBe("search-board-cnv_quieter-ab_hero_b");
    await page.keyboard.press("ArrowUp");
    expect(await active()).toBe("search-canvas-cnv_settled_1");
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
    await focusOn("Search canvases, boards, comments and messages");
    expect(await page.$eval("#sidebar", (el) => el.hasAttribute("inert"))).toBe(false);
    // Focused without scrolling the pane's content aside while it opens.
    expect(await page.$eval("#sidebar", (el) => el.scrollLeft)).toBe(0);
  });
  test("search: the arrows walk canvases, pages and boards, then comments, and Return opens", async () => {
    await open("team-sidebar");
    await page.keyboard.press("Meta+k");
    const field = 'input[role="combobox"]';
    await page.waitForSelector(field);
    await page.keyboard.type("pricing");
    await page.waitForSelector('[role="listbox"]');
    const active = () => page.$eval(field, (el) => el.getAttribute("aria-activedescendant"));
    const walked = [await active()];
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("ArrowDown");
      walked.push(await active());
    }
    expect(walked).toEqual([
      "search-canvas-cnv_pricing",
      "search-page-cnv_quieter-pg_pricing",
      "search-board-cnv_pricing-ab_pricing_annual",
      "search-comment-cnv_pricing-th_rows-msg_rows",
      "search-comment-cnv_pricing-th_seat-msg_seat",
      // The end: it stays.
      "search-comment-cnv_pricing-th_seat-msg_seat",
      "search-comment-cnv_pricing-th_seat-msg_seat",
    ]);
    // The groups as labelled, and each row as it reads.
    const groups = await page.$$eval('[role="listbox"] [role="group"]', (els) =>
      els.map((group) => ({
        label: group.querySelector("span")!.textContent,
        rows: [...group.querySelectorAll('[role="option"]')].map((row) =>
          row.textContent!.replace(/\s+/g, " ").trim(),
        ),
      })),
    );
    expect(groups.map((group) => group.label)).toEqual(["Canvases", "Boards", "Comments"]);
    expect(groups[1]!.rows).toEqual([
      "PricingPage in Quieter shop hero",
      "Pricing, annualin Pricing page, three takes",
    ]);
    expect(groups[2]!.rows).toEqual([
      "“The pricing cards now line up on one row at every width.”Claude · Pricing page, three takes · 30 m · Resolved",
      "“Could the pricing say per seat?”Deleted user · Pricing page, three takes · 1 d",
    ]);
    // A page's tile is its own icon; a board's, the board tile.
    const icons = await page.$$eval('[role="listbox"] [role="group"]:nth-of-type(2) svg', (els) =>
      els.map((svg) => svg.innerHTML),
    );
    expect(icons[0]).not.toBe(icons[1]);
    // Return opens what is selected, and closes search.
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await page.waitForSelector(field, { state: "detached" });
    expect(await page.evaluate(() => (window as { searchOpened?: string }).searchOpened)).toBe(
      "comment:cnv_pricing/th_rows/msg_rows",
    );
  });
  test("search: the arrows walk all six groups in order, and a person filters the list", async () => {
    await open("sidebar-search-every-group");
    const field = 'input[role="combobox"]';
    await page.waitForSelector('[role="listbox"]');
    const active = () => page.$eval(field, (el) => el.getAttribute("aria-activedescendant"));
    const count = await page.$$eval('[role="option"]', (els) => els.length);
    const walked = [await active()];
    for (let i = 1; i < count; i++) {
      await page.keyboard.press("ArrowDown");
      walked.push(await active());
    }
    expect(walked).toEqual([
      "search-canvas-cnv_park",
      "search-page-cnv_park-pg_park",
      "search-board-cnv_park-ab_park_grid",
      "search-comment-cnv_park-th_sage-msg_sage",
      "search-message-cnv_park-ti_park_ask",
      "search-message-cnv_park-ti_park_answer",
      "search-pr-cnv_park-417",
      "search-pr-cnv_park-391",
      "search-person-usr_ada",
      // A colon is no part of an element's id.
      "search-person-github-5102",
    ]);
    const groups = await page.$$eval('[role="listbox"] [role="group"]', (els) =>
      els.map((group) => ({
        id: group.getAttribute("aria-labelledby"),
        label: group.querySelector("span")!.textContent,
        rows: [...group.querySelectorAll('[role="option"]')].map((row) =>
          row.textContent!.replace(/\s+/g, " ").trim(),
        ),
      })),
    );
    expect(groups.map((group) => group.label)).toEqual([
      "Canvases",
      "Boards",
      "Comments",
      "Messages",
      "Pull requests",
      "People",
    ]);
    // Each group is named by its label, by an id with no space in it.
    expect(groups.map((group) => group.id)).toContain("search-group-pull-requests");
    // A person's words and the agent's answer, each with who, where and when.
    expect(groups[3]!.rows).toEqual([
      "“Make a park planters page, three to a row like the care cards.”Maya · Park planters collection · 3 h",
      "“I added the park planters page, three to a row, with the sizes under each one.”Claude · Park planters collection · 3 h",
    ]);
    // The current pull request with its state; an earlier one with none.
    expect(groups[4]!.rows).toEqual([
      "Park planters collection#417 · Draft · Park planters collection",
      "Park planters, first try#391 · Park planters collection",
    ]);
    expect(groups[5]!.rows).toEqual(["Ada Park@adapark", "LLeo Park@leopark"]);
    // The status counts every group's.
    expect(await page.textContent('[role="status"].sr-only')).toBe(`${count} results`);
    // Return on a person: search closes and the list shows only the canvases they started.
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await page.waitForSelector(field, { state: "detached" });
    expect(await page.evaluate(() => (window as { searchOpened?: string }).searchOpened)).toBe(
      "person:usr_ada",
    );
    expect(
      await page.$$eval("[data-canvas-row]", (els) =>
        els.map((el) => el.getAttribute("data-canvas-row")),
      ),
    ).toEqual(["cnv_quieter"]);
  });
  test("search's lines: no answer, and nothing found", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${server.url}/gallery.html?states&theme=light`);
    await page.getByText("Search isn't answering. Try again in a moment.").waitFor();
    await page.getByText("No results for “zebra”").waitFor();
  });
  test("the search selection keeps itself in view, and no matches says so", async () => {
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
    // Nothing matches: it says so.
    await page.fill('input[role="combobox"]', "zebra");
    expect(await page.textContent('[role="status"]:not(.sr-only)')).toBe("No results for “zebra”");
    // The count's region stays, empty: the line says it.
    expect(await page.textContent('[role="status"].sr-only')).toBe("");
  });
  test("presence is one Tab stop, and each person's tip shows from the keyboard", async () => {
    await open("team-sidebar");
    await page.focus('[aria-label="Ada (you)"]');
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
    await focusOn("Jordan · last here 2 days ago");
    await page.waitForSelector('[role="tooltip"]:has-text("Jordan · last here 2 days ago")');
    const stops = await page.$$eval(
      '[aria-label="People in this canvas"] [role="img"]',
      (els) => els.filter((e) => e.tabIndex === 0).length,
    );
    expect(stops).toBe(1);
  });
  test("unchecking a repo keeps Scratch's canvases, and Scratch has its own box", async () => {
    await open("create");
    const names = () =>
      page.$$eval("[data-canvas-row]", (els) => els.map((e) => e.textContent ?? ""));
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
  test("the canvas list is one Tab stop that the arrows move through", async () => {
    await open("team-sidebar");
    await page.focus('[data-canvas-row="cnv_quieter"]');
    await page.keyboard.press("ArrowDown");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-canvas-row"))).toBe(
      "cnv_checkout",
    );
    await page.keyboard.press("End");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-canvas-row"))).toBe(
      "cnv_brand",
    );
    const stops = await page.$$eval(
      "[data-canvas-row]",
      (els) => els.filter((e) => e.tabIndex === 0).length,
    );
    expect(stops).toBe(1);
  });
});
