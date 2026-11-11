/*
 * The thread rail and needs you in a real Chromium: following the foot, the composer's button,
 * sending from the keyboard, and answering a question with the keyboard alone. Skips where there
 * is no Chrome or Chromium.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  type Browser,
  buildGallery,
  chromiumPath,
  launch,
  type Page,
  serve,
} from "../../../scripts/visual-lib.ts";

setDefaultTimeout(60_000);

describe.skipIf(!chromiumPath)("the thread rail", () => {
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

  const open = async (board: string) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.goto(`${server.url}/gallery.html?board=${board}&theme=light`);
    await page.waitForFunction(() => (window as { galleryReady?: boolean }).galleryReady === true);
  };
  const log = '[role="log"]';
  /** How far the thread is from its foot, in pixels. */
  const fromFoot = () =>
    page.$eval(log, (el) => {
      const s = el.parentElement!;
      return s.scrollHeight - s.clientHeight - s.scrollTop;
    });
  const scrollBy = (dy: number) =>
    page.$eval(log, (el, dy) => el.parentElement!.scrollBy(0, dy), dy);

  test("a thousand lines: only the newest are drawn, and it opens at the foot", async () => {
    await open("long-thread");
    expect(await fromFoot()).toBeLessThan(2);
    const drawn = await page.$$eval(`${log} > *`, (els) => els.length);
    expect(drawn).toBeLessThan(120);
  });

  /** Waits until the rail has heard the person's scroll: it fades its foot. */
  const heardScroll = () =>
    page.waitForFunction(
      (sel) =>
        (document.querySelector(sel)!.parentElement as HTMLElement).style.maskImage.endsWith(
          "transparent)",
        ),
      log,
    );
  /** Where the first line in view sits on screen, by its text. */
  const reading = () =>
    page.$eval(log, (el) => {
      const top = el.parentElement!.getBoundingClientRect().top;
      const line = [...el.children].find((c) => c.getBoundingClientRect().bottom > top + 40)!;
      return { text: line.textContent, y: line.getBoundingClientRect().top };
    });
  /** Where a line with this text sits on screen now. */
  const whereIs = (text: string | null) =>
    page.$eval(
      log,
      (el, text) =>
        [...el.children].find((c) => c.textContent === text)?.getBoundingClientRect().top ?? null,
      text,
    );

  test("scrolling up stops following; what arrives is counted; the pill goes back", async () => {
    await open("long-thread");
    await scrollBy(-600);
    await heardScroll();
    expect(await fromFoot()).toBeGreaterThan(500);
    const before = await reading();
    // The run is stopped (a line from someone else, as far as following goes).
    await page.click('button[aria-label="Stop"]');
    await page.waitForSelector('button:has-text("1 new")');
    // What the person was reading didn't move.
    expect(Math.abs((await whereIs(before.text))! - before.y)).toBeLessThan(2);
    await page.click('button:has-text("1 new")');
    await page.waitForFunction((sel) => {
      const s = document.querySelector(sel)!.parentElement!;
      return s.scrollHeight - s.clientHeight - s.scrollTop < 2;
    }, log);
    expect(await page.$('button:has-text("new")')).toBeNull();
  });

  test("pictures loading above what the person reads don't move it", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/*.png", async (route) => {
      await held;
      await route.continue();
    });
    try {
      await open("long-thread");
      expect(await page.$$eval(`${log} img`, (imgs) => imgs.length)).toBeGreaterThan(0);
      await scrollBy(-500);
      await heardScroll();
      const before = await reading();
      release();
      await page.waitForFunction(
        (sel) =>
          [...document.querySelectorAll<HTMLImageElement>(`${sel} img`)].every((i) => i.complete),
        log,
      );
      await page.waitForTimeout(100);
      expect(Math.abs((await whereIs(before.text))! - before.y)).toBeLessThan(2);
    } finally {
      release();
      await page.unroute("**/*.png");
    }
  });

  test("text streaming in redraws its own line and no other", async () => {
    // Every commit React makes, through the hook its developer tools use: a line drew again
    // when its props are a new object, since a line that skips drawing keeps its old ones.
    await page.addInitScript(() => {
      const counts: Record<string, number> = {};
      const seen = new Map<string, unknown>();
      type Fiber = {
        key: string | null;
        memoizedProps: unknown;
        child: Fiber | null;
        sibling: Fiber | null;
      };
      (window as { lineRenders?: Record<string, number> }).lineRenders = counts;
      (window as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
        isDisabled: false,
        supportsFiber: true,
        renderers: new Map(),
        inject: () => 1,
        checkDCE: () => {},
        onCommitFiberUnmount: () => {},
        onPostCommitFiberRoot: () => {},
        onCommitFiberRoot: (_: number, root: { current: Fiber }) => {
          const stack = [root.current];
          while (stack.length) {
            const fiber = stack.pop()!;
            const props = fiber.memoizedProps as { item?: { id: string }; handlers?: unknown };
            if (props?.handlers && props.item && fiber.key === props.item.id) {
              if (seen.get(fiber.key) !== props) counts[fiber.key] = (counts[fiber.key] ?? 0) + 1;
              seen.set(fiber.key, props);
            }
            if (fiber.child) stack.push(fiber.child);
            if (fiber.sibling) stack.push(fiber.sibling);
          }
        },
      };
    });
    await open("thread-in-the-right-rail");
    const counts = () =>
      page.evaluate(() => ({
        ...(window as { lineRenders?: Record<string, number> }).lineRenders,
      }));
    const drawn = await counts();
    expect(Object.keys(drawn).length).toBeGreaterThan(2);
    await page.fill('textarea[aria-label="Message"]', "Calmer");
    await page.keyboard.press("Enter");
    // The reply streams in, a word at a time, and ends.
    await page.waitForSelector(`${log} p:has-text("in B.")`);
    const after = await counts();
    const redrawn = Object.keys(drawn).filter((id) => after[id] !== drawn[id]);
    expect(redrawn).toEqual([]);
    const fresh = Object.keys(after).filter((id) => !(id in drawn));
    // Your message, drawn once, and the reply, drawn as it grew.
    expect(fresh.map((id) => after[id]! > 5)).toEqual([false, true]);
    await page.close();
    page = await browser.newPage();
  });

  test("reading up reveals older lines without moving what is on screen", async () => {
    await open("long-thread");
    const first = () => page.$eval(`${log} > *`, (el) => el.textContent);
    const before = await first();
    await page.$eval(log, (el) => {
      el.parentElement!.scrollTop = 0;
    });
    await page.waitForFunction(
      ([sel, was]) => document.querySelector(`${sel} > *`)?.textContent !== was,
      [log, before] as const,
    );
    // The line that was at the top is still on screen, below what was revealed.
    const top = await page.$eval(log, (el) => el.parentElement!.scrollTop);
    expect(top).toBeGreaterThan(200);
    // Reading on to the top of what is loaded asks for older items.
    for (let i = 0; i < 12; i++) {
      await page.$eval(log, (el) => {
        el.parentElement!.scrollTop = 0;
      });
      await page.waitForTimeout(80);
    }
    await page.waitForFunction((sel) => document.querySelectorAll(`${sel} > *`).length > 200, log);
  });

  test("Stop while working with nothing typed; Send once there are words", async () => {
    await open("thread-in-the-right-rail");
    expect(await page.$('button[aria-label="Stop"]')).not.toBeNull();
    await page.fill('textarea[aria-label="Message"]', "Keep the green");
    expect(await page.$('button[aria-label="Stop"]')).toBeNull();
    const send = () =>
      page.$eval('button[aria-label="Send"]', (b) => b.getAttribute("aria-disabled"));
    expect(await send()).toBeNull();
    await page.fill('textarea[aria-label="Message"]', "   ");
    expect(await page.$('button[aria-label="Stop"]')).not.toBeNull();
  });

  test("Return sends, Shift-Return breaks the line, and the draft clears", async () => {
    await open("thread-in-the-right-rail");
    await page.click('textarea[aria-label="Message"]');
    await page.keyboard.type("Calmer");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("and keep the green");
    await page.keyboard.press("Enter");
    await page.waitForSelector(`${log} p:has-text("and keep the green")`);
    const text = await page.$eval(`${log} p:has-text("and keep the green")`, (p) =>
      p.textContent?.replace(/^You said: /, ""),
    );
    expect(text).toBe("Calmer\nand keep the green");
    expect(await page.inputValue('textarea[aria-label="Message"]')).toBe("");
    expect(await fromFoot()).toBeLessThan(2);
  });

  test("a question answers from the keyboard: arrows, Space, a digit, then Return", async () => {
    await open("needs-you-a-question");
    const send = () =>
      page.$eval('section button[aria-label="Send"]', (b) => b.getAttribute("aria-disabled"));
    expect(await send()).toBe("true");
    await page.focus('[role="radio"]');
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Space");
    const checked = () =>
      page.$$eval('[role="radio"][aria-checked="true"]', (els) => els.map((e) => e.textContent));
    expect((await checked())[0]).toContain("Smaller type on phones");
    expect(await send()).toBeNull();
    // A digit chooses outright, and one choice replaces another.
    await page.keyboard.press("1");
    expect(await checked()).toHaveLength(1);
    expect((await checked())[0]).toContain("Shorten it");
    // On to the note field, and Return answers this page and moves to the next.
    await page.keyboard.press("Tab");
    await page.keyboard.type("keep the comma");
    await page.keyboard.press("Enter");
    await page.waitForSelector('[role="group"] [role="checkbox"]');
    expect(await page.textContent("section h2")).toBe("Photo");
    // Several choices on a multi-select question.
    await page.focus('[role="checkbox"]');
    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Space");
    expect(await page.$$eval('[role="checkbox"][aria-checked="true"]', (e) => e.length)).toBe(2);
    // ⌘ and a digit is the app's, not a choice.
    await page.keyboard.press("Meta+1");
    expect(await page.$$eval('[role="checkbox"][aria-checked="true"]', (e) => e.length)).toBe(2);
    // The last answer goes, and the keyboard is back in the composer.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await page.waitForSelector('textarea[aria-label="Message"]');
    expect(await focused()).toBe("Message");
  });

  /** The focused element's name. */
  const focused = () =>
    page.evaluate(
      () => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName,
    );

  test("a question arriving while you type takes the keyboard with it", async () => {
    await open("thread-in-the-right-rail");
    await page.click('textarea[aria-label="Message"]');
    await page.keyboard.type("Calmer");
    await page.keyboard.press("Enter");
    // The reply, then board 2's questions in the composer's place.
    await page.waitForSelector('[role="radio"]');
    expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("radio");
    expect(await page.evaluate(() => document.activeElement?.textContent)).toContain("Shorten it");
    // It takes the keyboard without a ring that claims a choice; the first key shows it.
    const ring = () =>
      page.evaluate(() => getComputedStyle(document.activeElement as Element).boxShadow);
    expect(await ring()).toBe("none");
    await page.keyboard.press("ArrowDown");
    expect(await ring()).not.toBe("none");
  });

  /** A field's card: the element whose presses go to it. */
  const cardOf = (field: string) =>
    page.$eval(field, (el) => {
      const card = el.closest<HTMLElement>("[class*='cursor-text']")!;
      const r = card.getBoundingClientRect();
      return {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        cursor: getComputedStyle(card).cursor,
      };
    });
  const caret = () =>
    page.evaluate(() => {
      const el = document.activeElement as HTMLTextAreaElement;
      return el.tagName === "TEXTAREA" ? [el.selectionStart, el.selectionEnd] : null;
    });

  test("the rail's composer: a press anywhere on its card writes; attach, chips and send keep theirs", async () => {
    await open("thread-in-the-right-rail");
    const field = 'textarea[aria-label="Message"]';
    await page.fill(field, "Calmer");
    await page.$eval(field, (el) => (el as HTMLElement).blur());
    const card = await cardOf(field);
    expect(card.cursor).toBe("text");
    // Its padding, above the field and below it.
    await page.mouse.click(card.x + card.width / 2, card.y + 2);
    expect(await focused()).toBe("Message");
    expect(await caret()).toEqual([6, 6]);
    await page.$eval(field, (el) => (el as HTMLElement).blur());
    await page.mouse.click(card.x + card.width / 2, card.y + card.height - 2);
    expect(await caret()).toEqual([6, 6]);
    // Already writing: a press on the card keeps the caret where it was.
    await page.$eval(field, (el) => (el as HTMLTextAreaElement).setSelectionRange(2, 2));
    await page.mouse.click(card.x + card.width / 2, card.y + 2);
    expect(await caret()).toEqual([2, 2]);

    // An image attached: its chip's remove still removes, and send still sends.
    await page.setInputFiles('input[type="file"]', {
      name: "hero.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      ),
    });
    await page.waitForSelector('ul[aria-label="Attached images"] li');
    await page.hover('ul[aria-label="Attached images"] li');
    await page.click('button[aria-label="Remove hero.png"]');
    await page.waitForSelector('ul[aria-label="Attached images"]', { state: "detached" });
    await page.click('button[aria-label="Send"]');
    await page.waitForSelector('[role="log"] p:has-text("Calmer")');
    expect(await page.inputValue(field)).toBe("");
  });

  test("the rail's composer under a gate: the strip's words keep the arrow and can be selected", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.goto(`${server.url}/gallery.html?states&theme=light`);
    await page.waitForFunction(() => (window as { galleryReady?: boolean }).galleryReady === true);
    // A gate whose composer still shows its field (not the owner having left).
    const strip = await page.evaluateHandle(() => {
      for (const status of document.querySelectorAll<HTMLElement>('[role="status"]')) {
        const card = status.closest<HTMLElement>("[class*='cursor-text']");
        const field = card?.querySelector("textarea[data-press-focus]");
        if (field?.getClientRects().length) return status;
      }
      throw new Error("no gated composer with a field");
    });
    const el = strip.asElement()!;
    await el.scrollIntoViewIfNeeded();
    expect(await el.evaluate((s) => getComputedStyle(s).cursor)).toBe("default");
    const box = (await el.boundingBox())!;
    await page.mouse.dblclick(box.x + 4, box.y + box.height / 2);
    expect(await focused()).not.toBe("Message");
    expect(
      await page.evaluate(() => getSelection()?.toString().trim().length ?? 0),
    ).toBeGreaterThan(0);
  });

  test("the note under a question: a press anywhere on its card writes there", async () => {
    await open("needs-you-a-question");
    const field = 'textarea[aria-label="Note"]';
    const card = await cardOf(field);
    expect(card.cursor).toBe("text");
    await page.mouse.click(card.x + 6, card.y + card.height / 2);
    expect(await focused()).toBe("Note");
  });
});
