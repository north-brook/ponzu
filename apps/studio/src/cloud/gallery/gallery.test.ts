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

  /** Where the create page's question sits, in px from the window's top. */
  const questionTop = () =>
    page.$eval("h1", (h) => Math.round(h.getBoundingClientRect().top) as number);

  test("the repo picker lifts the column only when its list would not fit below it", async () => {
    // Scratch alone: a short list, with room under the chip at 1440×900. Nothing moves.
    await open("fresh-start-no-repos");
    const resting = await questionTop();
    await page.click('button[aria-label^="Project"]');
    await page.waitForSelector('[role="listbox"][aria-label="Repositories"]');
    await new Promise((r) => setTimeout(r, 100));
    expect(await questionTop()).toBe(resting);
    // Fifteen repos, a search and Scratch: more than the room under the chip, so it rises.
    await open("pick-a-project-many-repos");
    const centred = await questionTop();
    await page.click('button[aria-label^="Project"]');
    await page.waitForSelector('input[aria-label="Search repositories"]');
    await new Promise((r) => setTimeout(r, 100));
    expect(await questionTop()).toBeLessThan(centred);
    const raised = await questionTop();
    // Typing shortens the list; the column stays where it went.
    await page.keyboard.type("len");
    await new Promise((r) => setTimeout(r, 100));
    expect(await questionTop()).toBe(raised);
  });

  test("a first visit sits where its ideas go, and shows nothing while they're made", async () => {
    await open("fresh-start");
    const withIdeas = await questionTop();
    await open("fresh-start-loading");
    expect(await page.$('[aria-label="Finding ideas"]')).toBeNull();
    expect(await page.$('[aria-label="Ideas"]')).toBeNull();
    expect(await questionTop()).toBe(withIdeas);
  });

  test("a menu closed by a click gives focus back without a ring; by the keyboard, with one", async () => {
    await open("create");
    const chip = 'button[aria-label^="Model"]';
    const ring = () => page.$eval(chip, (el) => getComputedStyle(el).boxShadow);
    // Typing first, as someone does: the keyboard was the last thing used.
    await page.click("textarea");
    await page.keyboard.type("A card");
    await page.click(chip);
    await page.click('[role="menuitemradio"]:has-text("Low")');
    await page.waitForSelector('[role="menu"]', { state: "detached" });
    await focusOn(await page.$eval(chip, (el) => el.getAttribute("aria-label")!));
    expect(await ring()).toBe("none");
    // From the keyboard it is the keyboard's, ring and all.
    await page.keyboard.press("Enter");
    await page.waitForSelector('[role="menu"]');
    await page.keyboard.press("Escape");
    await page.waitForSelector('[role="menu"]', { state: "detached" });
    expect(await ring()).not.toBe("none");
  });

  test("the repo picker filters as you type and chooses with Return", async () => {
    await open("pick-a-project-many-repos");
    await page.click('button[aria-label^="Project"]');
    await page.waitForSelector('input[aria-label="Search repositories"]');
    await page.keyboard.type("len");
    const options = await page.$$eval('[role="option"]', (els) =>
      els.map((e) => e.getAttribute("data-choice")),
    );
    expect(options).toEqual(["repo_lenny"]);
    await page.keyboard.press("Enter");
    await page.waitForSelector('input[aria-label="Search repositories"]', { state: "detached" });
    expect(await page.textContent('button[aria-label^="Project"]')).toBe("lenny");
    await focusOn("Project: lenny");
  });

  // A few repos list without a search, and the list takes the keys; enough to need one, the field.
  for (const [board, focused] of [
    ["create", '[role="listbox"][aria-label="Repositories"]'],
    ["pick-a-project-many-repos", 'input[aria-label="Search repositories"]'],
  ] as const) {
    test(`the repo picker on ${board}: the arrows, Home and End move the highlight; Escape changes nothing`, async () => {
      await open(board);
      await page.click('button[aria-label^="Project"]');
      await page.waitForSelector(focused);
      const highlighted = () =>
        page.$eval(focused, (el) => {
          const id = el.getAttribute("aria-activedescendant");
          return id ? document.getElementById(id)?.getAttribute("data-choice") : null;
        });
      const choices = await page.$$eval('[role="option"]', (els) =>
        els.map((e) => e.getAttribute("data-choice")),
      );
      // It opens on the chosen one, named for assistive tech.
      expect(await highlighted()).toBe("repo_fernwood");
      await page.keyboard.press("End");
      expect(await highlighted()).toBe(choices.at(-1)!);
      await page.keyboard.press("Home");
      expect(await highlighted()).toBe(choices[0]!);
      await page.keyboard.press("ArrowDown");
      expect(await highlighted()).toBe(choices[1]!);
      // The field, or the list, keeps focus throughout.
      expect(await page.$eval(focused, (el) => el === document.activeElement)).toBe(true);
      await page.keyboard.press("Escape");
      await page.waitForSelector(focused, { state: "detached" });
      await focusOn("Project: fernwood");
    });
  }

  test("the repo picker: one line a row, by name; the search only once there are enough", async () => {
    await open("create");
    await page.click('button[aria-label^="Project"]');
    await page.waitForSelector('[role="listbox"][aria-label="Repositories"]');
    expect(await page.$('input[aria-label="Search repositories"]')).toBeNull();
    // Each row says only its name: no owner, no second line, no heading over them.
    expect(await page.$$eval('[role="option"]', (els) => els.map((e) => e.textContent))).toEqual([
      "Scratch",
      "fernwood",
      "lenny",
      "ponzu",
      "fablefuel",
    ]);
    expect(await page.$("[cmdk-group-heading]")).toBeNull();
    const heights = await page.$$eval('[role="option"]', (els) =>
      els.map((e) => Math.round(e.getBoundingClientRect().height)),
    );
    expect(new Set(heights)).toEqual(new Set([32]));
    // Return chooses with the list's own focus too.
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await page.waitForSelector('[role="listbox"][aria-label="Repositories"]', {
      state: "detached",
    });
    expect(await page.textContent('button[aria-label^="Project"]')).toBe("Scratch");
  });

  test("the repo picker: a name cut short shows whole in a tip; one that fits doesn't", async () => {
    await open("pick-a-project-many-repos");
    await page.click('button[aria-label^="Project"]');
    await page.waitForSelector('input[aria-label="Search repositories"]');
    const name = "customer-onboarding-experiments-and-landing-page-variants";
    const tip = '[data-slot="tooltip-content"]';
    await page.hover('[data-choice="repo_lenny"] span');
    await new Promise((r) => setTimeout(r, 700));
    expect(await page.$(tip)).toBeNull();
    const row = `[data-choice="repo_${name}"]`;
    await page.$eval(row, (el) => el.scrollIntoView({ block: "nearest" }));
    await page.hover(`${row} span`);
    await page.waitForSelector(tip);
    expect(await page.textContent(tip)).toContain(name);
    // It sits past the picker's edge, not over the rows.
    const [tipLeft, pickerRight] = await page.evaluate((tip) => {
      const t = document.querySelector(tip)!.getBoundingClientRect();
      const p = document.querySelector('[data-slot="popover-content"]')!.getBoundingClientRect();
      return [t.left, p.right];
    }, tip);
    expect(tipLeft).toBeGreaterThanOrEqual(pickerRight);
  });

  test("the repo picker: the arrows show a cut-short name's tip too, and take it away", async () => {
    await open("pick-a-project-many-repos");
    await page.mouse.move(1, 1);
    await page.click('button[aria-label^="Project"]');
    await page.waitForSelector('input[aria-label="Search repositories"]');
    await page.mouse.move(1, 1);
    const name = "customer-onboarding-experiments-and-landing-page-variants";
    const tip = '[data-slot="tooltip-content"]';
    // Opening on the chosen row shows no tip; arrowing onto the long name does.
    expect(await page.$(tip)).toBeNull();
    await page.keyboard.press("Home");
    for (let i = 0; i < 8; i++) {
      const on = await page.getAttribute(`[data-choice="repo_${name}"]`, "data-selected");
      if (on === "true") break;
      await page.keyboard.press("ArrowDown");
    }
    await page.waitForSelector(tip);
    expect(await page.textContent(tip)).toContain(name);
    await page.keyboard.press("ArrowDown");
    await page.waitForSelector(tip, { state: "detached" });
  });

  test("page tabs: the arrows move between them without opening one; Return opens it", async () => {
    await open("thread-in-the-right-rail");
    const tabs = '[role="tablist"][aria-label="Pages"] [role="tab"]';
    const names = await page.$$eval(tabs, (els) => els.map((e) => e.textContent ?? ""));
    const selected = () =>
      page.$$eval(tabs, (els) =>
        els
          .filter((e) => e.getAttribute("aria-selected") === "true")
          .map((e) => e.textContent ?? ""),
      );
    expect(await selected()).toEqual([names[0]!]);
    // They open pages, not panels of their own: no tab points at a panel that isn't there.
    expect(
      await page.$$eval(tabs, (els) => els.filter((e) => e.hasAttribute("aria-controls")).length),
    ).toBe(0);
    await page.focus(`${tabs}[aria-selected="true"]`);
    await page.keyboard.press("ArrowRight");
    await focusOn(names[1]!);
    expect(await selected()).toEqual([names[0]!]);
    await page.keyboard.press("Enter");
    expect(await selected()).toEqual([names[1]!]);
    await page.keyboard.press("End");
    await focusOn(names.at(-1)!);
    // The ends don't wrap around.
    await page.keyboard.press("ArrowRight");
    await focusOn(names.at(-1)!);
    await page.keyboard.press("Home");
    await focusOn(names[0]!);
  });

  test("a one-file pull request opens its diff, says its checks, and reads its base whole", async () => {
    await open("pull-request-one-file");
    const card = '[aria-label="Files changed"] button[aria-expanded]';
    expect(await page.getAttribute(card, "aria-expanded")).toBe("true");
    expect(await page.textContent('section[aria-label="Checks"]')).toContain("No checks ran");
    // The base reads whole beside a long head branch; "Merged …" goes under rather than squeezing.
    const base = await page.$eval(
      'span:text-is("→ main")',
      (el) => el.scrollWidth <= el.clientWidth,
    );
    expect(base).toBe(true);
    expect(await page.$('span:text-matches("^Merged")')).not.toBeNull();
  });

  test("page tabs: the + follows the last tab at the tabs' own 2px, one tab or many", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.goto(`${server.url}/gallery.html?states&theme=light`);
    await page.waitForFunction(() => (window as { galleryReady?: boolean }).galleryReady === true);
    const measure = (state: string) =>
      page.$eval(`[data-state="${state}"]`, (box) => {
        const list = box.querySelector('[role="tablist"]')!;
        const strip = list.parentElement!;
        const tabs = [...list.querySelectorAll('[role="tab"]')];
        const plus = box.querySelector('button[aria-label="New page"]')!.getBoundingClientRect();
        const last = tabs.at(-1)!.getBoundingClientRect();
        return {
          afterLastTab: Math.round(plus.left - last.right),
          afterStrip: Math.round(plus.left - strip.getBoundingClientRect().right),
          scrolls: strip.scrollWidth > strip.clientWidth,
        };
      });
    // Tabs that fit: no room kept for a fade there is no need of.
    expect(await measure("one page")).toEqual({ afterLastTab: 2, afterStrip: 2, scrolls: false });
    expect(await measure("three pages")).toEqual({
      afterLastTab: 2,
      afterStrip: 2,
      scrolls: false,
    });
    // Too many: they scroll under the fade, and the + still follows the strip at 2.
    const many = await measure("too many to fit");
    expect(many.scrolls).toBe(true);
    expect(many.afterStrip).toBe(2);
  });

  test("the create composer: a press anywhere on its card writes; its controls keep theirs", async () => {
    await open("create");
    const field = 'textarea[aria-label="Describe the design"]';
    const card = await page.$eval(field, (el) => {
      const r = el.parentElement!.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const focused = () =>
      page.evaluate(() => {
        const el = document.activeElement as HTMLTextAreaElement;
        return el.tagName === "TEXTAREA"
          ? { at: el.selectionStart, to: el.selectionEnd, length: el.value.length }
          : null;
      });
    expect(await page.$eval(field, (el) => getComputedStyle(el.parentElement!).cursor)).toBe(
      "text",
    );
    await page.fill(field, "Three plans");
    await page.$eval(field, (el) => (el as HTMLElement).blur());
    // The gap between the field and the buttons, and the space beside the + in their row.
    for (const [x, y] of [
      [card.x + card.width / 2, card.y + card.height - 64],
      [card.x + 120, card.y + card.height - 26],
    ] as const) {
      await page.mouse.click(x, y);
      expect(await focused()).toEqual({ at: 11, to: 11, length: 11 });
      await page.$eval(field, (el) => (el as HTMLElement).blur());
    }
    // A selection dragged out of the field and let go over the card stays.
    const box = (await page.$(field))!;
    const b = (await box.boundingBox())!;
    await page.mouse.move(b.x + 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(card.x + card.width / 2, card.y + card.height - 40, { steps: 6 });
    await page.mouse.up();
    const selected = await focused();
    expect(selected!.to - selected!.at).toBeGreaterThan(0);
    // The model picker opens its menu, not the field.
    await page.$eval(field, (el) => (el as HTMLElement).blur());
    await page.click('button[aria-haspopup="menu"]');
    await page.waitForSelector('[role="menu"]');
    expect(await focused()).toBeNull();
    await page.keyboard.press("Escape");
  });

  test("page tabs with the pull request tab open: none is chosen, and Tab reaches the first", async () => {
    await open("pull-request-tab");
    const tabs = '[role="tablist"][aria-label="Pages"] [role="tab"]';
    expect(await page.$$eval(`${tabs}[aria-selected="true"]`, (els) => els.length)).toBe(0);
    const first = await page.$eval(tabs, (el) => el.textContent);
    // Tab from the control before the strip.
    await page.focus('button[aria-label="Toggle sidebar"]');
    await page.keyboard.press("Tab");
    await focusOn(first!);
  });
});
