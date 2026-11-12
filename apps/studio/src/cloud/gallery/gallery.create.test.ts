/*
 * The cloud gallery's components in a real Chromium, beside gallery.test.ts: creating a
 * design, the repo picker, the page tabs and the pull request tab, their keyboard and focus
 * behaviour. Skips where there is no Chrome or Chromium.
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

  test("at the smallest window the active page tab stays whole and clear of the fade", async () => {
    // With the rail closed, the cluster at the window's edge. With both panes open the cluster
    // takes the canvas column's room and the tabs give way to it (chrome.test.ts).
    await open("team-sidebar", { width: 1100, height: 640 });
    await page.click('button[aria-controls="thread"]');
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
  test("the composer sends only something, and Tab takes the suggestion in without sending", async () => {
    await open("fresh-start");
    // The first idea stays for the whole test: which one Tab takes mustn't depend on the clock.
    await page.goto(`${server.url}/gallery.html?board=fresh-start&theme=light&dwell=600000`);
    await page.waitForFunction(() => (window as { galleryReady?: boolean }).galleryReady === true);
    const send = 'button[aria-label="Send"]';
    const disabled = () => page.$eval(send, (b) => b.getAttribute("aria-disabled") === "true");
    expect(await disabled()).toBe(true);
    await page.fill("textarea", "   ");
    expect(await disabled()).toBe(true);
    // Spaces are typing too: the suggestion is put away.
    expect(await page.$("[data-suggestion]")).toBeNull();
    await page.fill("textarea", "");
    await page.waitForSelector('[data-suggestion="idea_checkout"]');
    await page.focus("textarea");
    await page.keyboard.press("Tab");
    const idea = "Make checkout one page, with the order summary on the right";
    expect(await page.inputValue("textarea")).toBe(idea);
    // In the field to edit, the cursor after it, and nothing sent.
    expect(
      await page.$eval("textarea", (el) => {
        const field = el as HTMLTextAreaElement;
        return document.activeElement === field && field.selectionStart === field.value.length;
      }),
    ).toBe(true);
    expect(await page.$("[data-suggestion]")).toBeNull();
    expect(await disabled()).toBe(false);
    // With words in the field, Tab is the keyboard's again: past the frame the idea's caret is
    // placed in, so that doesn't take focus back after the Tab (a loaded machine runs it late).
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("TEXTAREA");
  });

  /** Where the create page's question sits, in px from the window's top. */
  const questionTop = () =>
    page.$eval("h1", (h) => Math.round(h.getBoundingClientRect().top) as number);
  test("the repo picker opens under its selector and the page stays where it is", async () => {
    const picker = '[data-slot="popover-content"]';
    const box = (selector: string) =>
      page.$eval(selector, (el) => {
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom) };
      });
    for (const board of ["fresh-start-no-repos", "pick-a-project-many-repos"]) {
      await open(board);
      const resting = await questionTop();
      await page.click('button[aria-label^="Project"]');
      await page.waitForSelector('[role="listbox"][aria-label="Repositories"]');
      // Past the popover's opening and anything the page might have done about it.
      await page.waitForFunction(
        (sel) =>
          document
            .querySelector(sel)
            ?.getAnimations()
            .every((a) => a.playState === "finished"),
        picker,
      );
      expect(await questionTop()).toBe(resting);
      // Under the selector, and whole inside the window.
      const selector = await box('button[aria-label^="Project"]');
      const open_ = await box(picker);
      expect(open_.top).toBeGreaterThanOrEqual(selector.bottom);
      expect(open_.bottom).toBeLessThanOrEqual(await page.evaluate(() => window.innerHeight));
    }
    // Fifteen repos and Scratch: the list shows five rows and half of the sixth, and has its search.
    expect(await page.$('input[aria-label="Search repositories"]')).not.toBeNull();
    const list = await box('[role="listbox"][aria-label="Repositories"]');
    const shown = await page.$eval('[role="listbox"][aria-label="Repositories"]', (el) =>
      Math.round(el.parentElement!.getBoundingClientRect().height),
    );
    expect(shown).toBe(176);
    expect(list.bottom - list.top).toBeGreaterThan(shown);
    // Typing shortens the list; the page still doesn't move.
    const resting = await questionTop();
    await page.keyboard.type("len");
    await page.waitForFunction(() => document.querySelectorAll('[role="option"]').length === 1);
    expect(await questionTop()).toBe(resting);
  });
  test("in a window too short for it, the picker's list gives up height and stays under the selector", async () => {
    await open("pick-a-project-many-repos");
    // The picker hangs from the header, so it takes a window this short to run out of room.
    await page.setViewportSize({ width: 1440, height: 440 });
    try {
      // The column re-centres for the shorter pane in the frame after the resize (a
      // ResizeObserver): past two frames it is where it rests.
      await page.evaluate(
        () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
      );
      const resting = await questionTop();
      await page.click('button[aria-label^="Project"]');
      await page.waitForSelector('input[aria-label="Search repositories"]');
      const [chipBottom, top, bottom, listHeight] = await page.evaluate(() => {
        const chip = document.querySelector('button[aria-label^="Project"]')!;
        const open = document.querySelector('[data-slot="popover-content"]')!;
        const list = document.querySelector('[role="listbox"][aria-label="Repositories"]')!;
        const r = open.getBoundingClientRect();
        return [
          chip.getBoundingClientRect().bottom,
          r.top,
          r.bottom,
          list.parentElement!.getBoundingClientRect().height,
        ];
      });
      expect(top).toBeGreaterThanOrEqual(chipBottom!);
      expect(bottom).toBeLessThanOrEqual(440);
      expect(listHeight).toBeLessThan(176);
      expect(listHeight).toBeGreaterThan(0);
      expect(await questionTop()).toBe(resting);
    } finally {
      await page.setViewportSize({ width: 1440, height: 900 });
    }
  });
  test("ideas take turns as the composer's placeholder, and nothing on the page moves for them", async () => {
    const placeholder = () =>
      page.$eval("textarea", (el) => getComputedStyle(el, "::placeholder").color);
    // While they are being made: the plain placeholder.
    await open("fresh-start-loading");
    const waiting = await questionTop();
    expect(await page.$("[data-suggestion]")).toBeNull();
    const plain = await placeholder();
    expect(plain).not.toBe("rgba(0, 0, 0, 0)");

    // Made: each shows in the placeholder's place and colour, with the key that takes it.
    await page.goto(`${server.url}/gallery.html?board=fresh-start&theme=light&dwell=200`);
    await page.waitForFunction(() => (window as { galleryReady?: boolean }).galleryReady === true);
    expect(await questionTop()).toBe(waiting);
    await page.waitForSelector("[data-suggestion]");
    // Everything about the one showing, read in one go: the next takes its place in 200ms.
    const prompts: Record<string, string> = {
      idea_checkout: "Make checkout one page, with the order summary on the right",
      idea_hero: "Three takes on the home hero that put the plants first",
      idea_dark: "A dark mode for the shop, using the tokens you already have",
      idea_empty: "Friendlier empty states for cart, orders and search",
    };
    const showing = await page.evaluate(() => {
      const line = document.querySelector<HTMLElement>("[data-suggestion]")!;
      const field = document.querySelector("textarea")!;
      const now = line.querySelector(".suggestion-in")!;
      const words = now.firstChild?.textContent ?? "";
      return {
        id: line.dataset.suggestion!,
        words,
        key: now.querySelector("kbd")?.textContent,
        color: getComputedStyle(line).color,
        pointer: getComputedStyle(line).pointerEvents,
        placeholder: getComputedStyle(field, "::placeholder").color,
        described: document.getElementById(field.getAttribute("aria-describedby")!)?.textContent,
        // Words made from the repo: none of them reaches a private recording unmasked.
        masked: [...document.querySelectorAll("[data-create-composer] *")]
          .filter((el) =>
            [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.includes(words)),
          )
          .map((el) => el.closest('[data-replay="mask"]') !== null),
      };
    });
    const prompt = prompts[showing.id]!;
    // In the placeholder's place and colour, with the key that takes it; the real placeholder
    // steps aside, and the pointer goes through to the field.
    expect(showing.words).toBe(prompt);
    expect(showing.key).toBe("tab");
    expect(showing.color).toBe(plain);
    expect(showing.placeholder).toBe("rgba(0, 0, 0, 0)");
    expect(showing.pointer).toBe("none");
    // The field tells assistive tech what the picture of a placeholder can't.
    expect(showing.described).toBe(`Suggestion: ${prompt}. Press Tab to use it.`);
    expect(showing.masked.length).toBeGreaterThanOrEqual(2);
    expect(showing.masked.every(Boolean)).toBe(true);
    // One after another, round to the first again.
    for (const id of ["idea_hero", "idea_dark", "idea_empty", "idea_checkout"]) {
      await page.waitForSelector(`[data-suggestion="${id}"]`);
    }
    // Typing puts them away, and the plain placeholder is the field's again once it is cleared.
    await page.fill("textarea", "A card");
    expect(await page.$("[data-suggestion]")).toBeNull();
    expect(await questionTop()).toBe(waiting);
    await page.fill("textarea", "");
    await page.waitForSelector("[data-suggestion]");
  });

  test("a menu gives focus back without a ring, unless the keyboard brought it to the chip", async () => {
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
    // Opened and closed with the keyboard, the chip a click had focused stays quiet: Return and
    // Escape aren't navigation.
    await page.keyboard.press("Enter");
    await page.waitForSelector('[role="menu"]');
    await page.keyboard.press("Escape");
    await page.waitForSelector('[role="menu"]', { state: "detached" });
    expect(await ring()).toBe("none");
    // Reached with Tab, it is the keyboard's, and the menu gives it back ring and all.
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await focusOn(await page.$eval(chip, (el) => el.getAttribute("aria-label")!));
    expect(await ring()).not.toBe("none");
    await page.keyboard.press("Enter");
    await page.waitForSelector('[role="menu"]');
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");
    await page.waitForSelector('[role="menu"]', { state: "detached" });
    await focusOn(await page.$eval(chip, (el) => el.getAttribute("aria-label")!));
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
    expect(await page.textContent('button[aria-label^="Project"]')).toBe("north-brook/lenny");
    await focusOn("Project: north-brook/lenny");
  });
  /**
   * Checks the arrows, Home and End move the highlight while `focused` (the field, or the list)
   * keeps focus, and that Escape closes the picker with the chosen repo kept.
   */
  const highlightWalk = async (focused: string) => {
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
    await focusOn("Project: north-brook/fernwood");
  };
  test("the repo picker on create: one line a row, by name, no search; the list takes the keys, Escape changes nothing, Return chooses", async () => {
    const list = '[role="listbox"][aria-label="Repositories"]';
    await open("create");
    await page.click('button[aria-label^="Project"]');
    await page.waitForSelector(list);
    // A few repos: no search; the list itself has the keys.
    expect(await page.$('input[aria-label="Search repositories"]')).toBeNull();
    // Each row says its full name on one line: no second line, no heading over them.
    expect(await page.$$eval('[role="option"]', (els) => els.map((e) => e.textContent))).toEqual([
      "Scratch",
      "north-brook/fernwood",
      "north-brook/lenny",
      "north-brook/ponzu",
      "north-brook/fablefuel",
    ]);
    expect(await page.$("[cmdk-group-heading]")).toBeNull();
    const heights = await page.$$eval('[role="option"]', (els) =>
      els.map((e) => Math.round(e.getBoundingClientRect().height)),
    );
    expect(new Set(heights)).toEqual(new Set([32]));
    await highlightWalk(list);
    // Return chooses with the list's own focus too.
    await page.click('button[aria-label^="Project"]');
    await page.waitForSelector(list);
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await page.waitForSelector(list, { state: "detached" });
    expect(await page.textContent('button[aria-label^="Project"]')).toBe("Scratch");
  });
  test("the repo picker on pick-a-project-many-repos: the search field keeps the keys; the arrows, Home and End move the highlight; Escape changes nothing", async () => {
    const field = 'input[aria-label="Search repositories"]';
    await open("pick-a-project-many-repos");
    await page.click('button[aria-label^="Project"]');
    await page.waitForSelector(field);
    await highlightWalk(field);
  });
  test("the repo picker: a cut-short name's tip, from the arrows and the pointer; one that fits has none", async () => {
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
    // The pointer: a name that fits gets no tip, the one cut short does.
    await page.hover('[data-choice="repo_lenny"] span');
    await new Promise((r) => setTimeout(r, 700));
    expect(await page.$(tip)).toBeNull();
    const row = `[data-choice="repo_${name}"]`;
    await page.$eval(row, (el) => el.scrollIntoView({ block: "nearest" }));
    await page.hover(`${row} span`);
    await page.waitForSelector(tip);
    expect(await page.textContent(tip)).toContain(name);
    // It sits past the picker's edge, not over the rows: the right edge where the window has
    // room, else the left (the picker hangs from the header's selector, right of centre).
    const clear = await page.evaluate((tip) => {
      const t = document.querySelector(tip)!.getBoundingClientRect();
      const p = document.querySelector('[data-slot="popover-content"]')!.getBoundingClientRect();
      return {
        past: t.left >= p.right || t.right <= p.left,
        inside: t.left >= 0 && t.right <= window.innerWidth,
      };
    }, tip);
    expect(clear).toEqual({ past: true, inside: true });
  });
  /**
   * The create page's header, measured: the logo's mark, the hairline, the selector and its
   * words (their box, and the centre of their x-height, the line the logo's word sits on), the
   * composer's card, all in px.
   */
  const header = () =>
    page.evaluate(() => {
      const box = (el: Element) => {
        const r = el.getBoundingClientRect();
        return {
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
          mid: r.top + r.height / 2,
        };
      };
      const label = document.querySelector("[data-project-label]")!;
      const name = (label.lastElementChild ?? label) as HTMLElement;
      const style = getComputedStyle(name);
      const ctx = document.createElement("canvas").getContext("2d")!;
      ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const m = ctx.measureText("nwoo");
      const n = name.getBoundingClientRect();
      // Where the line box puts the baseline: half the leading over the font's own box.
      const baseline =
        n.top +
        (n.height - (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent)) / 2 +
        m.fontBoundingBoxAscent;
      return {
        mark: box(document.querySelector("h1 svg")!),
        divider: box(document.querySelector("[data-create-divider]")!),
        selector: box(document.querySelector("[data-project-selector]")!),
        label: box(label),
        // A line is the face's line box, a little over its size: two would be over twice it.
        labelLines: Math.floor(n.height / Number.parseFloat(style.fontSize)),
        nameShown: name.clientWidth,
        xHeight: baseline - m.actualBoundingBoxAscent / 2,
        composer: box(document.querySelector("textarea")!.closest(".cursor-text")!),
      };
    });

  test("the header is one line on the mark: the hairline, and the selector's words, centred on it", async () => {
    await open("create");
    const h = await header();
    // The mark is the lockup's height; its centre is the row's line.
    expect(Math.abs(h.divider.mid - h.mark.mid)).toBeLessThanOrEqual(1);
    expect(Math.abs(h.label.mid - h.mark.mid)).toBeLessThanOrEqual(1);
    expect(Math.abs(h.selector.mid - h.mark.mid)).toBeLessThanOrEqual(1);
    // The words sit on it by their x-height, as the logo's word does.
    expect(Math.abs(h.xHeight - h.mark.mid)).toBeLessThanOrEqual(1);
    // The hairline stands on the composer's centre line; the logo ends 16 before it.
    const centre = (h.composer.left + h.composer.right) / 2;
    expect(Math.abs((h.divider.left + h.divider.right) / 2 - centre)).toBeLessThanOrEqual(0.5);
    expect(Math.round(h.divider.left - h.mark.right)).toBe(16);
    // Nothing is under the composer: the selector came up into the header.
    expect(h.selector.bottom).toBeLessThan(h.composer.top);
  });

  test("a long owner and name stay on the header's line, inside the composer's width, the logo where it was", async () => {
    await open("create");
    const short = await header();
    await open("fresh-start-long-name");
    const long = await header();
    expect(long.selector.right).toBeLessThanOrEqual(long.composer.right);
    expect(long.labelLines).toBe(1);
    expect(long.selector.mid).toBe(short.selector.mid);
    // The logo and the hairline didn't move or shrink for it.
    expect(long.mark).toEqual(short.mark);
    expect(long.divider).toEqual(short.divider);
    // The owner gave way first: most of what shows is the name.
    expect(long.nameShown).toBeGreaterThan((long.label.right - long.label.left) * 0.75);
    expect(await page.getAttribute('button[aria-label^="Project"]', "aria-label")).toBe(
      "Project: the-extraordinarily-long-organization-name/customer-onboarding-experiments-and-landing-page-variants",
    );
  });

  /** The open list as read top to bottom: `# <heading>` for a group's heading, else a row's words. */
  const listed = () =>
    page.$$eval('[role="listbox"] [cmdk-group-heading], [role="listbox"] [role="option"]', (els) =>
      els.map((e) => (e.hasAttribute("cmdk-group-heading") ? `# ${e.textContent}` : e.textContent)),
    );
  const openPicker = async () => {
    await page.click('button[aria-label^="Project"]');
    await page.waitForSelector('[role="listbox"][aria-label="Repositories"]');
  };
  /** Opens a board with the other workspaces' repos held back until `galleryArrive()`. */
  const openLater = async (board: string) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.goto(`${server.url}/gallery.html?board=${board}&theme=light&later`);
    await page.waitForFunction(() => (window as { galleryReady?: boolean }).galleryReady === true);
  };
  /** Each row's key and where it is, in px from the window's top. */
  const rowTops = () =>
    page.$$eval('[role="option"]', (els) =>
      els.map((e) => [e.getAttribute("data-choice"), Math.round(e.getBoundingClientRect().top)]),
    );

  test("with several workspaces the picker groups them, each under its name with its own Scratch, and searches them all", async () => {
    await open("pick-a-project-workspaces");
    await openPicker();
    expect(await listed()).toEqual([
      "# Northbrook",
      "Scratch",
      "north-brook/fernwood",
      "north-brook/lenny",
      "north-brook/ponzu",
      "north-brook/fablefuel",
      "# Lenny Learning",
      "Scratch",
      "lennylearning/app",
      "lennylearning/site",
      "lennylearning/curriculum",
    ]);
    // Each Scratch is its workspace's.
    expect(
      await page.$$eval('[role="option"]', (els) =>
        els.filter((e) => e.textContent === "Scratch").map((e) => e.getAttribute("data-choice")),
      ),
    ).toEqual(["scratch", "scratch:ws_lennylearning"]);
    // A heading is the menus' section label, cut short on one line; not an option, but the name
    // of its rows' group.
    const headings = await page.$$eval("[cmdk-group-heading]", (els) =>
      els.map((h) => {
        const label = h.firstElementChild!;
        const css = getComputedStyle(label);
        const group = h.parentElement!.querySelector('[role="group"]')!;
        return {
          height: Math.round(label.getBoundingClientRect().height),
          type: [css.fontSize, css.fontWeight, css.paddingTop, css.paddingBottom, css.paddingLeft],
          hidden: h.getAttribute("aria-hidden"),
          names: document.getElementById(group.getAttribute("aria-labelledby")!) === h,
          truncates: css.textOverflow === "ellipsis" && css.whiteSpace === "nowrap",
        };
      }),
    );
    expect(headings).toEqual(
      ["Northbrook", "Lenny Learning"].map(() => ({
        height: 24,
        type: ["11px", "600", "6px", "4px", "8px"],
        hidden: "true",
        names: true,
        truncates: true,
      })),
    );
    // In the faint ink of every menu's label, and the rows' icons stand under its first letter.
    const [faint, iconLeft, headingLeft] = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.className = "text-faint";
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      const label = document.querySelector("[cmdk-group-heading] > *")!;
      return [
        color === getComputedStyle(label).color,
        Math.round(
          document.querySelector('[data-choice="scratch"] svg')!.getBoundingClientRect().left,
        ),
        Math.round(label.getBoundingClientRect().left + 8),
      ];
    });
    expect(faint).toBe(true);
    expect(iconLeft).toBe(headingLeft);
    // Owners read quieter than names.
    const [owner, name] = await page.$eval('[data-choice="repo_lennylearning_app"]', (row) =>
      [...row.querySelectorAll("span span")].map((s) => getComputedStyle(s).color),
    );
    expect(owner).not.toBe(name);
    // A search matches anywhere in owner/name, and a workspace's name finds its Scratch and repos;
    // a heading shows only over a group with a match.
    await page.keyboard.type("lenny");
    await page.waitForFunction(() => document.querySelectorAll('[role="option"]').length === 5);
    expect(await listed()).toEqual([
      "# Northbrook",
      "north-brook/lenny",
      "# Lenny Learning",
      "Scratch",
      "lennylearning/app",
      "lennylearning/site",
      "lennylearning/curriculum",
    ]);
    await page.fill('input[aria-label="Search repositories"]', "/site");
    await page.waitForFunction(() => document.querySelectorAll('[role="option"]').length === 1);
    expect(await listed()).toEqual(["# Lenny Learning", "lennylearning/site"]);
    // "scratch" finds every workspace's.
    await page.fill('input[aria-label="Search repositories"]', "scratch");
    await page.waitForFunction(() => document.querySelectorAll('[role="option"]').length === 2);
    expect(await listed()).toEqual(["# Northbrook", "Scratch", "# Lenny Learning", "Scratch"]);
    await page.keyboard.press("Escape");
  });

  test("the arrows move over the rows and pass the headings by", async () => {
    await open("pick-a-project-workspaces");
    await openPicker();
    const field = 'input[aria-label="Search repositories"]';
    const highlighted = () =>
      page.$eval(field, (el) => {
        const id = el.getAttribute("aria-activedescendant");
        return id ? document.getElementById(id)?.getAttribute("data-choice") : null;
      });
    expect(await highlighted()).toBe("repo_fernwood");
    await page.keyboard.press("Home");
    expect(await highlighted()).toBe("scratch");
    await page.keyboard.press("End");
    expect(await highlighted()).toBe("repo_lennylearning_curriculum");
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowUp");
    expect(await highlighted()).toBe("scratch:ws_lennylearning");
    // Past Lenny Learning's heading to Northbrook's last repo.
    await page.keyboard.press("ArrowUp");
    expect(await highlighted()).toBe("repo_fablefuel");
    await page.keyboard.press("ArrowDown");
    expect(await highlighted()).toBe("scratch:ws_lennylearning");
    await page.keyboard.press("Escape");
  });

  test("choosing another workspace's repo switches the sidebar's workspace and keeps the choice and the words", async () => {
    await open("pick-a-project-workspaces");
    await page.fill("textarea", "Three takes on the lesson page");
    await openPicker();
    await page.click('[data-choice="repo_lennylearning_app"]');
    await page.waitForSelector('[role="listbox"]', { state: "detached" });
    await page.waitForSelector('button[aria-label="Workspace: Lenny Learning"]');
    expect(await page.getAttribute('button[aria-label^="Project"]', "aria-label")).toBe(
      "Project: lennylearning/app",
    );
    expect(await page.inputValue("textarea")).toBe("Three takes on the lesson page");
    // There, its own group comes first and Northbrook's after.
    await openPicker();
    expect(await listed()).toEqual([
      "# Lenny Learning",
      "Scratch",
      "lennylearning/app",
      "lennylearning/site",
      "lennylearning/curriculum",
      "# Northbrook",
      "Scratch",
      "north-brook/fernwood",
      "north-brook/lenny",
      "north-brook/ponzu",
      "north-brook/fablefuel",
    ]);
    await page.keyboard.press("Escape");
  });

  test("choosing another workspace's Scratch switches the sidebar's workspace with Scratch chosen and the words kept", async () => {
    await open("pick-a-project-workspaces");
    await page.fill("textarea", "Three takes on the lesson page");
    await openPicker();
    await page.click('[data-choice="scratch:ws_lennylearning"]');
    await page.waitForSelector('[role="listbox"]', { state: "detached" });
    await page.waitForSelector('button[aria-label="Workspace: Lenny Learning"]');
    // The selector says Scratch; to assistive tech, whose.
    expect(await page.textContent('button[aria-label^="Project"]')).toBe("Scratch");
    expect(await page.getAttribute('button[aria-label^="Project"]', "aria-label")).toBe(
      "Project: Scratch in Lenny Learning",
    );
    expect(await page.inputValue("textarea")).toBe("Three takes on the lesson page");
    // Lenny Learning's Scratch, now the window's own, is the one checked.
    await openPicker();
    expect(
      await page.$$eval("[data-checked]", (els) => els.map((e) => e.getAttribute("data-choice"))),
    ).toEqual(["scratch"]);
    expect(await page.getAttribute('[data-choice="scratch"]', "data-selected")).toBe("true");
    expect(await listed().then((l) => l.slice(0, 2))).toEqual(["# Lenny Learning", "Scratch"]);
    await page.keyboard.press("Escape");
  });

  test("a workspace's heading and Scratch show at once; its repos join at the foot, and nothing moves", async () => {
    await openLater("pick-a-project-workspaces");
    const before = await header();
    await openPicker();
    // Lenny Learning's name and Scratch are there before its repos, which hold a place under it.
    expect(await listed()).toEqual([
      "# Northbrook",
      "Scratch",
      "north-brook/fernwood",
      "north-brook/lenny",
      "north-brook/ponzu",
      "north-brook/fablefuel",
      "# Lenny Learning",
      "Scratch",
    ]);
    expect(await page.$('[role="status"][aria-label="Loading repositories"]')).not.toBeNull();
    expect(await page.$('input[aria-label="Search repositories"]')).not.toBeNull();
    const open_ = await rowTops();
    await page.evaluate(() => (window as { galleryArrive?: () => void }).galleryArrive?.());
    await page.waitForFunction(() => document.querySelectorAll('[role="option"]').length === 9);
    // They join at the foot: the rows there were stay put, and so does the page.
    expect((await rowTops()).slice(0, open_.length)).toEqual(open_);
    expect(await header()).toEqual(before);
    expect(await page.$('[role="status"][aria-label="Loading repositories"]')).toBeNull();
    await page.keyboard.press("Escape");
  });

  test("an open list takes only the last workspace's late repos; the others' wait until it opens again", async () => {
    await openLater("pick-a-project-three-workspaces");
    await openPicker();
    const opened = await listed();
    expect(opened.slice(6)).toEqual(["# Lenny Learning", "Scratch", "# Bryce Bjork", "Scratch"]);
    // The pointer rests on Lenny Learning's Scratch, under which its repos would go (the list
    // scrolls it into view first).
    await page.hover('[data-choice="scratch:ws_lennylearning"] span');
    const open_ = await rowTops();
    await page.evaluate(() => (window as { galleryArrive?: () => void }).galleryArrive?.());
    await page.waitForFunction(() => document.querySelectorAll('[role="option"]').length === 8);
    // The last workspace's repo joined at the foot; Lenny Learning's wait, so nothing moved.
    expect(await listed()).toEqual([...opened, "brycedbjork/dotfiles"]);
    expect((await rowTops()).slice(0, open_.length)).toEqual(open_);
    expect(
      await page.getAttribute('[data-choice="scratch:ws_lennylearning"]', "data-selected"),
    ).toBe("true");
    await page.keyboard.press("Escape");
    await page.waitForSelector('[role="listbox"]', { state: "detached" });
    // Opened again, every workspace lists what it has.
    await openPicker();
    expect((await listed()).slice(6)).toEqual([
      "# Lenny Learning",
      "Scratch",
      "lennylearning/app",
      "lennylearning/site",
      "lennylearning/curriculum",
      "# Bryce Bjork",
      "Scratch",
      "brycedbjork/dotfiles",
    ]);
    await page.keyboard.press("Escape");
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
      const r = el.closest(".cursor-text")!.getBoundingClientRect();
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
  test("the pull request tab swaps the middle only: the thread stays, and ⌥⌘B and the page numbers work there", async () => {
    await open("pull-request-tab");
    const heading = 'h1:text-is("Quieter hero, editorial take")';
    // The rail's width as the design gives it: its panel and the 10 of gutter (its edge) before it.
    const thread = () =>
      page.$eval("#thread-pane", (el) => Math.round(el.getBoundingClientRect().width + 10));
    const expanded = () =>
      page.$eval('button[aria-controls="thread"]', (b) => b.getAttribute("aria-expanded"));
    expect(await page.$(heading)).not.toBeNull();
    expect(await expanded()).toBe("true");
    expect(await thread()).toBe(360);
    // ⌥⌘B closes and opens the thread on this tab as anywhere, and the tab stays.
    await page.click(heading);
    await page.keyboard.press("Meta+Alt+b");
    expect(await expanded()).toBe("false");
    expect(await page.$(heading)).not.toBeNull();
    await page.keyboard.press("Meta+Alt+b");
    expect(await expanded()).toBe("true");
    // What is typed in the thread outlives leaving the tab (board 3 asks a question: its note
    // field is in the composer's place). ⌃1 (Alt off the Mac) opens the first page; the thread
    // doesn't move.
    const field = "#thread textarea";
    await page.fill(field, "Half typed");
    await page.click(heading);
    const mac = await page.evaluate(() => navigator.userAgent.includes("Mac"));
    await page.keyboard.press(`${mac ? "Control" : "Alt"}+Digit1`);
    await page.waitForSelector(heading, { state: "detached" });
    const chosen = await page.$$eval(
      '[role="tablist"][aria-label="Pages"] [role="tab"][aria-selected="true"]',
      (els) => els.length,
    );
    expect(chosen).toBe(1);
    expect(await thread()).toBe(360);
    expect(await page.inputValue(field)).toBe("Half typed");
  });
  test("the pull request fits the canvas's column: stacked when narrow, two columns when wide", async () => {
    const layout = () =>
      page.$eval("[data-pr-columns]", (el) => {
        const pane = el.closest("main")!;
        const box = el.getBoundingClientRect();
        const kids = [...el.children].map((c) => c.getBoundingClientRect());
        return {
          side: kids.length === 2 && Math.abs(kids[0]!.top - kids[1]!.top) < 1,
          width: Math.round(box.width),
          // Nothing reaches past the pane's edges.
          fits: [...el.querySelectorAll("*")].every(
            (c) => c.getBoundingClientRect().right <= pane.getBoundingClientRect().right + 0.5,
          ),
        };
      });
    // The smallest window with both panes open: one column, nothing cut, a long title wrapped.
    await open("pull-request-min-window", { width: 1100, height: 640 });
    expect(await layout()).toMatchObject({ side: false, fits: true });
    // The usual window with both open: one column at the reading measure, centred.
    await open("pull-request-tab");
    expect(await layout()).toMatchObject({ side: false, fits: true, width: 760 });
    // The thread closed: the board's two columns.
    await open("pull-request-rail-closed");
    expect(await layout()).toMatchObject({ side: true, fits: true });
    // A wide screen: two columns, no wider than 1480.
    await open("pull-request-wide", { width: 2240, height: 1100 });
    expect(await layout()).toMatchObject({ side: true, fits: true, width: 1480 });
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
