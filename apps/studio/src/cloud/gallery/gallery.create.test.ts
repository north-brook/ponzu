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
  holdSend,
  launch,
  type Page,
  releaseSend,
  type SendFrame,
  seekSend,
  sendFrame,
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
    // The statement's last words: "Make something from scratch".
    expect(await page.textContent('button[aria-label^="Project"]')).toBe("scratch");
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
   * The create page, measured: the canvas pane, the mark (and how opaque it is), the statement,
   * the selector and its words, the composer's card, all in px.
   */
  const header = () =>
    page.evaluate(() => {
      const box = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      };
      const label = document.querySelector("[data-project-label]")!;
      const name = (label.lastElementChild ?? label) as HTMLElement;
      const mark = document.querySelector("[data-create-mark]")!;
      return {
        pane: box(document.querySelector("main")!),
        mark: box(mark),
        markShown: Number(getComputedStyle(mark).opacity),
        statement: box(document.querySelector("[data-create-statement]")!),
        selector: box(document.querySelector("[data-project-selector]")!),
        label: box(label),
        // A line is the face's line box, a little over its size: two would be over twice it.
        labelLines: Math.floor(
          name.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(name).fontSize),
        ),
        nameShown: name.clientWidth,
        composer: box(document.querySelector("[data-create-composer] [data-composer-card]")!),
      };
    });

  /** How far the thread's composer rests from the foot of its pane, on a design. */
  const threadInset = async () => {
    await open("thread-in-the-right-rail");
    return page.evaluate(() => {
      const pane = document.getElementById("thread-pane")!.getBoundingClientRect();
      const card = document.querySelector("#thread [data-composer-card]")!.getBoundingClientRect();
      return Math.round(pane.bottom - card.bottom);
    });
  };

  test("the hero is centred in the room above the composer, which sits on the pane's foot at the thread composer's inset", async () => {
    const inset = await threadInset();
    for (const height of [700, 900, 1200]) {
      await open("fresh-start", { width: 1440, height });
      const h = await header();
      // The composer: centred in the pane, at its foot, as far from it as the thread's is from its own.
      expect(Math.round(h.pane.bottom - h.composer.bottom)).toBe(inset);
      const middle = (h.pane.left + h.pane.right) / 2;
      expect(Math.abs((h.composer.left + h.composer.right) / 2 - middle)).toBeLessThanOrEqual(0.5);
      // The hero, the mark over the statement: on the pane's centre line, and centred in the room
      // above the composer at rest, 28 high of true centre (create.ts, HERO_LIFT).
      expect(Math.abs((h.mark.left + h.mark.right) / 2 - middle)).toBeLessThanOrEqual(0.5);
      expect(Math.abs((h.statement.left + h.statement.right) / 2 - middle)).toBeLessThanOrEqual(1);
      expect(Math.round(h.statement.top - h.mark.bottom)).toBe(24);
      const room = { top: h.pane.top, bottom: h.composer.top };
      const centre = (room.top + room.bottom) / 2 - 28;
      expect(Math.abs((h.mark.top + h.statement.bottom) / 2 - centre)).toBeLessThanOrEqual(1);
      expect(h.markShown).toBe(1);
    }
  });

  test("the hero holds still as the composer grows, and gives way only once it must: the statement rises, the mark goes", async () => {
    await open("fresh-start", { width: 1440, height: 900 });
    const resting = await header();
    // A few lines grow the composer upward and move nothing else.
    await page.fill("textarea", "One\nTwo\nThree\nFour");
    const grown = await header();
    expect(grown.composer.top).toBeLessThan(resting.composer.top);
    expect(grown.composer.bottom).toBe(resting.composer.bottom);
    expect(grown.statement).toEqual(resting.statement);
    expect(grown.mark).toEqual(resting.mark);

    // The smallest window and the tallest the field grows: the whole hero still has its room.
    await open("fresh-start", { width: 1440, height: 640 });
    const long = Array.from({ length: 14 }, (_, i) => `Line ${i + 1}`).join("\n");
    await page.fill("textarea", long);
    const smallest = await header();
    expect(smallest.markShown).toBe(1);
    expect(smallest.composer.top - smallest.statement.bottom).toBeGreaterThanOrEqual(40 - 0.5);
    // A pane shorter than any window gives it (the rule holds all the same): the statement rises
    // ahead of the composer and the mark goes.
    await page.$eval("main", (el) => {
      (el as HTMLElement).style.marginTop = "200px";
    });
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector("[data-create-mark]")!).opacity === "0",
    );
    const tight = await header();
    // Nothing overlaps: the statement keeps 40 over the composer, and 24 under the pane's top.
    expect(tight.composer.top - tight.statement.bottom).toBeGreaterThanOrEqual(40 - 0.5);
    expect(tight.statement.top - tight.pane.top).toBeGreaterThanOrEqual(24 - 0.5);
    // Taken back, the hero is where it was.
    await page.fill("textarea", "");
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector("[data-create-mark]")!).opacity === "1",
    );
    const back = await header();
    expect(back.statement.top).toBeGreaterThan(tight.statement.top);
    expect(back.mark.bottom).toBeLessThanOrEqual(back.statement.top - 24 + 0.5);
  });

  test("the statement ends in the selector, on one baseline; a long owner and name stay on its line and in the pane", async () => {
    await open("create");
    const short = await header();
    // The selector's words are the statement's last: one line, after "Make something in".
    expect(short.selector.top).toBeGreaterThanOrEqual(short.statement.top - 0.5);
    expect(short.selector.bottom).toBeLessThanOrEqual(short.statement.bottom + 0.5);
    expect(short.selector.bottom).toBeLessThan(short.composer.top);
    await open("fresh-start-long-name");
    const long = await header();
    expect(long.labelLines).toBe(1);
    expect(long.statement.right).toBeLessThanOrEqual(long.pane.right);
    expect(long.statement.left).toBeGreaterThanOrEqual(long.pane.left);
    // The mark where it was (to the pixel: centring a statement of another width rounds apart).
    expect(Math.round(long.mark.left)).toBe(Math.round(short.mark.left));
    expect(long.mark.top).toBe(short.mark.top);
    // The owner gave way first: most of what shows is the name.
    expect(long.nameShown).toBeGreaterThan((long.label.right - long.label.left) * 0.6);
    expect(await page.getAttribute('button[aria-label^="Project"]', "aria-label")).toBe(
      "Project: the-extraordinarily-long-organization-name/customer-onboarding-experiments-and-landing-page-variants",
    );
  });

  /** The send composition, with motion: `query` adds the harness's options (`fail`, `beat`). */
  const openSend = async (
    query = "",
    reducedMotion: "reduce" | "no-preference" = "no-preference",
  ) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion });
    await page.goto(`${server.url}/gallery.html?board=create-send&theme=light${query}`);
    await page.waitForFunction(() => (window as { galleryReady?: boolean }).galleryReady === true);
    // Every travelling card ever made, counted as it arrives.
    await page.evaluate(() => {
      const w = window as { flights?: number };
      w.flights = 0;
      new MutationObserver((records) => {
        for (const r of records) {
          for (const n of r.addedNodes) {
            if (n instanceof Element && n.querySelector('[data-flight="surface"]')) w.flights!++;
          }
        }
      }).observe(document.body, { childList: true });
    });
    await page.focus("[data-create-composer] textarea");
  };
  const gallery = <T>(key: string) =>
    page.evaluate((key) => (window as unknown as Record<string, T>)[key], key);
  const near = (
    a: SendFrame["surface"],
    b: { x: number; y: number; width: number; height: number },
  ) =>
    !!a &&
    Math.abs(a.x - b.x) <= 1 &&
    Math.abs(a.y - b.y) <= 1 &&
    Math.abs(a.width - b.width) <= 1 &&
    Math.abs(a.height - b.height) <= 1;
  const sendCard = () =>
    page.$eval("[data-create-composer] [data-composer-card]", (el) => {
      const { x, y, width, height } = el.getBoundingClientRect();
      return { x, y, width, height };
    });

  test("a send: the composer travels as one from its box to the thread composer's, which has the words as its first line", async () => {
    await openSend("&beat=600000");
    const from = await sendCard();
    const length = await holdSend(page, () => page.keyboard.press("Enter"));
    // On a relative of the panes' clock: longer, so it lands once the pane has opened.
    expect(length).toBeGreaterThan(220);
    await seekSend(page, 0);
    const start = await sendFrame(page);
    expect(start.surfaces).toBe(1);
    expect(near(start.surface, from)).toBe(true);
    // Where it rests, it rests: the thread's composer once the pane has opened.
    let last = start;
    for (let i = 1; i <= 20; i++) {
      await seekSend(page, i / 20);
      const frame = await sendFrame(page);
      // One card all the way, never smaller than where it lands, moving only toward it.
      expect(frame.surfaces).toBe(1);
      expect(frame.surface!.x).toBeGreaterThanOrEqual(last.surface!.x - 0.5);
      expect(frame.surface!.width).toBeLessThanOrEqual(last.surface!.width + 0.5);
      last = frame;
    }
    // The + and the send button keep to their corners of the card.
    expect(last.attach!.x - last.surface!.x).toBeLessThan(12);
    expect(last.surface!.x + last.surface!.width - (last.send!.x + last.send!.width)).toBeLessThan(
      12,
    );
    await releaseSend(page);
    await page.waitForFunction(() => !document.querySelector("[data-flight]"));
    const home = await page.$eval("#thread [data-composer-card]", (el) => {
      const { x, y, width, height } = el.getBoundingClientRect();
      return { x, y, width, height, seen: getComputedStyle(el).visibility };
    });
    expect(near(last.surface, home)).toBe(true);
    expect(home.seen).toBe("visible");
    // The words are the thread's first line; the composer is empty and has the caret.
    const first = await page.$eval("#thread [data-thread-line], #thread li, #thread p", (el) =>
      el.textContent?.trim(),
    );
    expect(first).toContain("I'd like to iterate on the onboarding flow");
    expect(await page.inputValue("#thread textarea")).toBe("");
    await focusOn("Message");
    expect(await gallery<number>("flights")).toBe(1);
  });

  test("after the beat the thread's pane closes, and our own caret in it doesn't keep it open", async () => {
    await openSend("&beat=200");
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => (window as { gallerySettled?: string }).gallerySettled === "closed",
    );
    await page.waitForSelector('button[aria-controls="thread"][aria-expanded="false"]');
  });

  for (const [kind, touch] of [
    [
      "the pointer moved into it",
      async () => {
        await page.mouse.move(1300, 600);
        await page.mouse.move(1310, 620);
      },
    ],
    ["a press in it", () => page.mouse.click(1300, 400)],
    [
      "a scroll in it",
      async () => {
        await page.mouse.move(1300, 400);
        await page.mouse.wheel(0, -120);
      },
    ],
    ["typing in it", () => page.keyboard.type("and")],
    [
      "something in it focused",
      async () => {
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await page.focus("#thread textarea");
      },
    ],
  ] as const) {
    test(`the thread's pane stays open after ${kind}`, async () => {
      await page.mouse.move(700, 300);
      await openSend("&beat=600000");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => !document.querySelector("[data-flight]"));
      await focusOn("Message");
      await touch();
      await page.waitForFunction(
        () => (window as { gallerySettled?: string }).gallerySettled === "open",
      );
      expect(await page.getAttribute('button[aria-controls="thread"]', "aria-expanded")).toBe(
        "true",
      );
    });
  }

  test("the thread's toggle used during the beat: the pane is as the person left it, and the beat is over", async () => {
    await page.mouse.move(700, 300);
    await openSend("&beat=600000");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => !document.querySelector("[data-flight]"));
    await page.click('button[aria-controls="thread"]');
    await page.waitForFunction(
      () => (window as { gallerySending?: boolean }).gallerySending === false,
    );
    expect(await page.getAttribute('button[aria-controls="thread"]', "aria-expanded")).toBe(
      "false",
    );
    expect(await gallery<string | undefined>("gallerySettled")).toBeUndefined();
  });

  test("a send that fails comes back to the page as it was, the error said, with no second travel", async () => {
    await openSend("&fail=150&beat=600000");
    const before = await sendCard();
    await page.keyboard.press("Enter");
    await page.waitForSelector('[role="status"]:text("couldn\'t be made")');
    await page.waitForSelector("[data-create-composer]:not([data-launched])");
    expect(await page.inputValue("[data-create-composer] textarea")).toBe(
      "I'd like to iterate on the onboarding flow",
    );
    expect(await page.getAttribute('button[aria-label^="Project"]', "aria-label")).toBe(
      "Project: north-brook/fernwood",
    );
    expect(await page.$("[data-flight]")).toBeNull();
    expect(await gallery<number>("flights")).toBe(1);
    // Once the thread's pane has closed again, the composer is where it was.
    await page.waitForFunction(() => !document.querySelector("[data-pane-motion]"));
    expect(await sendCard()).toEqual(before);
    await focusOn("Describe the design");
  });

  test("send pressed twice makes one send and one travel", async () => {
    await openSend("&beat=600000");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page
      .click('[data-create-composer] button[aria-label="Send"]', { force: true })
      .catch(() => {});
    await page.waitForFunction(() => !document.querySelector("[data-flight]"));
    expect(await gallery<number>("gallerySends")).toBe(1);
    expect(await gallery<number>("flights")).toBe(1);
  });

  test("with reduced motion nothing travels, and it ends the same: the words in the thread, the caret there, the pane closing after the beat", async () => {
    await openSend("&beat=300", "reduce");
    await page.keyboard.press("Enter");
    await focusOn("Message");
    expect(await gallery<number>("flights")).toBe(0);
    expect(await page.textContent("#thread")).toContain(
      "I'd like to iterate on the onboarding flow",
    );
    await page.waitForFunction(
      () => (window as { gallerySettled?: string }).gallerySettled === "closed",
    );
  });

  test("a window resized mid-way lands the composer at once, where the thread's now rests", async () => {
    await openSend("&beat=600000");
    await holdSend(page, () => page.keyboard.press("Enter"));
    await seekSend(page, 0.5);
    expect((await sendFrame(page)).surfaces).toBe(1);
    await page.setViewportSize({ width: 1300, height: 820 });
    await page.waitForFunction(() => !document.querySelector("[data-flight]"));
    await releaseSend(page);
    // The pane lays itself out for the new window once its opening is over.
    await page.waitForFunction(() => {
      const el = document.querySelector("#thread [data-composer-card]");
      const r = el?.getBoundingClientRect();
      return (
        r &&
        Math.round(r.right) === 1300 - 10 &&
        Math.round(r.bottom) === 820 - 10 &&
        getComputedStyle(el).visibility === "visible"
      );
    });
  });

  test("a pane's edge taken hold of mid-way lands the composer at once", async () => {
    await openSend("&beat=600000");
    await holdSend(page, () => page.keyboard.press("Enter"));
    await seekSend(page, 0.4);
    await page.evaluate(() =>
      document.querySelector("header")!.parentElement!.setAttribute("data-pane-drag", ""),
    );
    await page.waitForFunction(() => !document.querySelector("[data-flight]"));
    await page.evaluate(() =>
      document.querySelector("header")!.parentElement!.removeAttribute("data-pane-drag"),
    );
    await releaseSend(page);
    expect(
      await page.$eval("#thread [data-composer-card]", (el) => getComputedStyle(el).visibility),
    ).toBe("visible");
  });

  test("the picker lists every workspace's repos by full name, the window's first, and searches them all", async () => {
    await open("pick-a-project-workspaces");
    await page.click('button[aria-label^="Project"]');
    await page.waitForSelector('[role="listbox"][aria-label="Repositories"]');
    const options = () => page.$$eval('[role="option"]', (els) => els.map((e) => e.textContent));
    expect(await options()).toEqual([
      "Scratch",
      "north-brook/fernwood",
      "north-brook/lenny",
      "north-brook/ponzu",
      "north-brook/fablefuel",
      "lennylearning/app",
      "lennylearning/site",
      "lennylearning/curriculum",
    ]);
    // Owners read quieter than names.
    const [owner, name] = await page.$eval('[data-choice="repo_lennylearning_app"]', (row) =>
      [...row.querySelectorAll("span span")].map((s) => getComputedStyle(s).color),
    );
    expect(owner).not.toBe(name);
    // A search matches anywhere in owner/name: an organization finds its repos, a name both's.
    await page.keyboard.type("lenny");
    await page.waitForFunction(() => document.querySelectorAll('[role="option"]').length === 4);
    expect(await options()).toEqual([
      "north-brook/lenny",
      "lennylearning/app",
      "lennylearning/site",
      "lennylearning/curriculum",
    ]);
    await page.fill('input[aria-label="Search repositories"]', "/site");
    await page.waitForFunction(() => document.querySelectorAll('[role="option"]').length === 1);
    expect(await options()).toEqual(["lennylearning/site"]);
  });

  test("choosing another workspace's repo switches the sidebar's workspace and keeps the choice and the words", async () => {
    await open("pick-a-project-workspaces");
    await page.fill("textarea", "Three takes on the lesson page");
    await page.click('button[aria-label^="Project"]');
    await page.waitForSelector('[role="listbox"][aria-label="Repositories"]');
    await page.click('[data-choice="repo_lennylearning_app"]');
    await page.waitForSelector('[role="listbox"]', { state: "detached" });
    await page.waitForSelector('button[aria-label="Workspace: Lenny Learning"]');
    expect(await page.getAttribute('button[aria-label^="Project"]', "aria-label")).toBe(
      "Project: lennylearning/app",
    );
    expect(await page.inputValue("textarea")).toBe("Three takes on the lesson page");
    // There, its own repos come first and Northbrook's after.
    await page.click('button[aria-label^="Project"]');
    await page.waitForSelector('[role="listbox"][aria-label="Repositories"]');
    const names = await page.$$eval('[role="option"]', (els) => els.map((e) => e.textContent));
    expect(names.slice(0, 3)).toEqual(["Scratch", "lennylearning/app", "lennylearning/site"]);
    expect(names.at(-1)).toBe("north-brook/fablefuel");
    await page.keyboard.press("Escape");
  });

  test("nothing moves when the other workspaces' repos arrive, the open list included", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.goto(`${server.url}/gallery.html?board=pick-a-project-workspaces&theme=light&later`);
    await page.waitForFunction(() => (window as { galleryReady?: boolean }).galleryReady === true);
    const before = await header();
    await page.click('button[aria-label^="Project"]');
    await page.waitForSelector('[role="listbox"][aria-label="Repositories"]');
    const rows = () =>
      page.$$eval('[role="option"]', (els) =>
        els.map((e) => [e.getAttribute("data-choice"), Math.round(e.getBoundingClientRect().top)]),
      );
    const open_ = await rows();
    expect(open_.length).toBe(5);
    // Five rows fit, but more are coming: the search is there from the start, not brought in
    // over the rows when they arrive.
    expect(await page.$('input[aria-label="Search repositories"]')).not.toBeNull();
    await page.evaluate(() => (window as { galleryArrive?: () => void }).galleryArrive?.());
    await page.waitForFunction(() => document.querySelectorAll('[role="option"]').length === 8);
    // They join at the foot: the rows there were stay put, and so does the page.
    expect((await rows()).slice(0, 5)).toEqual(open_);
    expect(await header()).toEqual(before);
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
  test("the pull request tab swaps the middle only: the thread stays, and ⌘J and the page numbers work there", async () => {
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
    // ⌘J closes and opens the thread on this tab as anywhere, and the tab stays.
    await page.click(heading);
    await page.keyboard.press("Meta+j");
    expect(await expanded()).toBe("false");
    expect(await page.$(heading)).not.toBeNull();
    await page.keyboard.press("Meta+j");
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
