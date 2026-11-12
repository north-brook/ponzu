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

  test("a comment's picture is a glance: 144 by 96 over its words at every rail width, sharp at 2x", async () => {
    for (const rail of [300, 360, 520]) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
      await page.goto(
        `${server.url}/gallery.html?board=thread-in-the-right-rail&theme=light&rail=${rail}`,
      );
      await page.waitForFunction(() => (window as { galleryReady?: boolean }).galleryReady);
      // The rail at the width asked for, as the panes write it for the chrome.
      const width = await page.evaluate(() =>
        Number.parseFloat(
          getComputedStyle(document.querySelector("header")!.parentElement!).getPropertyValue(
            "--pane-rail",
          ),
        ),
      );
      expect(Math.round(width)).toBe(rail);
      const button = page.locator('button[aria-label^="Open the comment"]').first();
      await button.scrollIntoViewIfNeeded();
      const shape = await button.evaluate(async (el) => {
        const img = el.querySelector("img")!;
        await img.decode();
        const box = el.getBoundingClientRect();
        const words = el.nextElementSibling!.querySelector("p")!;
        const css = getComputedStyle(el);
        return {
          width: box.width,
          height: box.height,
          corners: [
            css.borderTopLeftRadius,
            css.borderTopRightRadius,
            css.borderBottomRightRadius,
            css.borderBottomLeftRadius,
          ],
          // Over its words: a hairline between, their right edges one.
          gap: words.getBoundingClientRect().top - box.bottom,
          right: words.getBoundingClientRect().right - box.right,
          wordsCorner: getComputedStyle(words).borderTopRightRadius,
          pixels: [img.naturalWidth, img.naturalHeight],
        };
      });
      expect(shape).toEqual({
        width: 144,
        height: 96,
        corners: ["10px", "10px", "5px", "10px"],
        gap: 2,
        right: 0,
        wordsCorner: "5px",
        // At least twice its size: sharp on a 2x screen.
        pixels: [480, 320],
      });
    }
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
    // Only the agent's words from before the send, once: it carried on after them, so they
    // became an aside of the turn (and left with it).
    const redrawn = Object.keys(drawn).filter((id) => after[id] !== drawn[id]);
    expect(redrawn.length).toBeLessThanOrEqual(1);
    for (const id of redrawn) expect(after[id]! - drawn[id]!).toBe(1);
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
    // Reading on to the top of what is loaded reveals the rest of it, then asks for older items:
    // noted as it asks, with the lines drawn under its "Loading earlier…".
    await page.$eval(log, (el) => {
      new MutationObserver(() => {
        const w = window as { askedWith?: number };
        if (el.hasAttribute("aria-busy")) w.askedWith ??= el.children.length - 1;
      }).observe(el, { attributeFilter: ["aria-busy"] });
    });
    const asked = () => page.evaluate(() => (window as { askedWith?: number }).askedWith);
    // Each reach waits for what the one before revealed, so none lands on a view already at 0.
    for (let i = 0; i < 4 && (await asked()) === undefined; i++) {
      const was = await first();
      await page.$eval(log, (el) => {
        el.parentElement!.scrollTop = 0;
      });
      await page.waitForFunction(
        ([sel, was]) => document.querySelector(`${sel} > *`)?.textContent !== was,
        [log, was] as const,
      );
    }
    const drawn = await asked();
    expect(drawn).toBeGreaterThan(0);
    // What arrives shows above with no further reach (another would ask for the page after).
    await page.waitForFunction(
      ([sel, drawn]) => {
        const el = document.querySelector(sel)!;
        return !el.hasAttribute("aria-busy") && el.children.length > drawn;
      },
      [log, drawn!] as const,
    );
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

  /** One frame of the thread, as the person sees it. */
  type Frame = {
    t: number;
    /** Live working lines (one leaving is not one). */
    lines: number;
    working: string | null;
    /** Live asides, by text, and whether each is set in italics. */
    asides: { text: string; italic: boolean }[];
    /** Lines on their way out: their height and opacity, and the clock each leaves on. */
    leaving: { height: number; opacity: number; clock: string[] }[];
    messages: number;
    work: boolean;
    answerBottom: number | null;
    askTop: number | null;
    /** The working line's height with the gap above it: what the answer settles by. */
    lineRoom: number;
  };

  /** Plays the live turn on `board`, sampling every frame until a moment after it ends. */
  const playTurn = async (board: string, reducedMotion: "reduce" | "no-preference") => {
    await page.setViewportSize({ width: 600, height: 700 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion });
    await page.goto(`${server.url}/gallery.html?board=${board}&theme=light`);
    await page.waitForFunction(
      () => typeof (window as { playTurn?: unknown }).playTurn === "function",
    );
    return page.evaluate(async () => {
      const out: Frame[] = [];
      let on = true;
      const sample = (t: number) => {
        const log = document.querySelector('[role="log"]');
        const lines = log?.querySelectorAll(":scope > * [data-working-line]") ?? [];
        const answer = [...(log?.querySelectorAll(":scope > .text-13") ?? [])].find((el) =>
          el.textContent?.startsWith("Done: Plan"),
        );
        const ask = [...(log?.querySelectorAll("p[dir=auto]") ?? [])].find((el) =>
          el.textContent?.includes("Two small boards"),
        );
        out.push({
          t,
          lines: lines.length,
          working: lines[0]?.textContent ?? null,
          asides: [...(log?.querySelectorAll<HTMLElement>(":scope > [data-aside]") ?? [])].map(
            (el) => ({
              text: el.textContent ?? "",
              italic: getComputedStyle(el).fontStyle === "italic",
            }),
          ),
          leaving: [...(log?.querySelectorAll<HTMLElement>(":scope > [data-leaving]") ?? [])].map(
            (el) => ({
              height: el.getBoundingClientRect().height,
              opacity: Number(getComputedStyle(el).opacity),
              // A CSS animation's curve is its keyframes' (the effect's own is linear).
              clock: el.getAnimations().map((a) => {
                const effect = a.effect as KeyframeEffect;
                const name = (a as Animation & { animationName?: string }).animationName;
                const curve = effect.getKeyframes()[0]?.easing;
                return `${name} ${effect.getComputedTiming().duration}ms ${curve}`;
              }),
            }),
          ),
          messages: log?.querySelectorAll("p[dir=auto]").length ?? 0,
          // What the rail's old stretches and fold said: "N steps", "Worked for".
          work: /\d+ steps?|Worked for/.test(log?.textContent ?? ""),
          answerBottom: answer ? answer.getBoundingClientRect().bottom : null,
          askTop: ask ? ask.getBoundingClientRect().top : null,
          lineRoom: lines[0] ? lines[0].getBoundingClientRect().height + 14 : 0,
        });
        if (on) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      await (window as unknown as { playTurn: () => Promise<void> }).playTurn();
      await new Promise((r) => setTimeout(r, 500));
      on = false;
      return out;
    });
  };

  /*
   * A turn played through as the API delivers it, watched every frame: from the send until the
   * turn ends there is always exactly one working line and the agent's work never has lines of
   * its own; what it said before carrying on is an aside, in italics, as it comes; and when the
   * turn ends the aside and the working line go together, closing their room and fading, while
   * the answer settles into place without a jump.
   */
  test("a streaming turn: one working line, asides as they come, and an end that settles", async () => {
    const frames = await playTurn("turn-live", "no-preference");
    const sent = frames.findIndex((f) => f.messages > 0);
    const end = frames.findIndex((f, i) => i > sent && f.lines === 0 && f.messages > 0);
    expect(sent).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(sent);
    // Every frame from the send to the end (however many the machine painted): one working
    // line, never blank, no work lines.
    const during = frames.slice(sent, end);
    for (const frame of during) {
      expect(frame.lines).toBe(1);
      expect(frame.working?.trim()).toBeTruthy();
      expect(frame.work).toBe(false);
      expect(frame.leaving).toEqual([]);
    }
    // The states it went through, each specific; thinking right after it spoke.
    const states = during.map((f) => f.working!).filter((state, i, all) => state !== all[i - 1]);
    expect(states).toEqual([
      "Thinking",
      "Reading the canvas",
      'Drawing "Plan"',
      "Thinking",
      'Drawing "Plan ready"',
      "Editing styles/tokens.css",
      "Thinking",
    ]);
    // Its first message reads plain while it is the newest thing said, and becomes an aside, in
    // italics, the moment the agent carries on after it; the answer is never one.
    const firstAside = during.findIndex((f) => f.asides.length > 0);
    expect(firstAside).toBeGreaterThan(0);
    expect(during[firstAside]!.working).toBe('Drawing "Plan ready"');
    for (const frame of during.slice(firstAside)) {
      expect(frame.asides).toEqual([
        { text: "Drew Plan. Now Plan ready, then the tokens.", italic: true },
      ]);
    }

    // The end's frame: the aside and the working line are no longer live, both leaving.
    const after = frames.slice(end);
    for (const frame of after) {
      expect(frame.lines).toBe(0);
      expect(frame.asides).toEqual([]);
      expect(frame.work).toBe(false);
    }
    const before = frames[end - 1]!;
    expect(frames[end]!.leaving).toHaveLength(2);
    // No jump: the answer is where it was in that frame, and the leaving lines hold no more
    // room than they did (no flash of an aside at its full height after it had gone).
    expect(Math.abs(frames[end]!.answerBottom! - before.answerBottom!)).toBeLessThan(1);
    expect(Math.abs(frames[end]!.askTop! - before.askTop!)).toBeLessThan(1);
    // Then they close and fade, on the pane's clock (each one's own animation, exactly), a little
    // more in each frame painted, and are gone.
    const pane = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--dur-pane").trim(),
    );
    // The panes' curve, as the browser writes it.
    const ease = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.animationTimingFunction = "var(--ease-out)";
      document.body.append(probe);
      const curve = getComputedStyle(probe).animationTimingFunction;
      probe.remove();
      return curve;
    });
    const ms = Number.parseFloat(pane) * (/\ds$/.test(pane) ? 1000 : 1);
    expect(ms).toBeGreaterThan(0);
    const leaving = after.filter((f) => f.leaving.length);
    expect(leaving[0]!.leaving.map((l) => l.clock)).toEqual([
      [`leave ${ms}ms ${ease}`],
      [`leave ${ms}ms ${ease}`],
    ]);
    for (const f of leaving) {
      for (const l of f.leaving) {
        // Its animation over (it goes in the frames after), it has closed all the way.
        if (l.clock.length === 0) expect(l.height).toBeLessThan(1);
        else expect(l.clock).toEqual([`leave ${ms}ms ${ease}`]);
      }
    }
    const total = (f: Frame) => f.leaving.reduce((n, l) => n + l.height, 0);
    for (let i = 1; i < leaving.length; i++) {
      expect(total(leaving[i]!)).toBeLessThanOrEqual(total(leaving[i - 1]!) + 0.5);
      for (const [j, l] of leaving[i]!.leaving.entries()) {
        expect(l.opacity).toBeLessThanOrEqual((leaving[i - 1]!.leaving[j]?.opacity ?? 1) + 0.01);
      }
    }
    expect(leaving.at(-1)!.t - leaving[0]!.t).toBeLessThan(400);
    expect(frames.at(-1)!.leaving).toEqual([]);
    // Each closes all the way, the space above it included, before it goes: its going moves
    // nothing (no last step of the answer by the gap it held).
    expect(total(leaving.at(-1)!)).toBeLessThan(1);
    const gone = frames.findIndex((f, i) => i > end && f.leaving.length === 0);
    expect(Math.abs(frames[gone]!.answerBottom! - frames[gone - 1]!.answerBottom!)).toBeLessThan(1);
    // The answer settles into the working line's room, a little each frame, never jumping, and
    // stays there.
    const settled = frames.at(-1)!.answerBottom!;
    expect(Math.abs(settled - before.answerBottom! - before.lineRoom)).toBeLessThan(2);
    const bottoms = after.map((f) => f.answerBottom!);
    for (let i = 1; i < bottoms.length; i++) {
      expect(bottoms[i]! - bottoms[i - 1]!).toBeGreaterThan(-0.5);
      expect(bottoms[i]! - bottoms[i - 1]!).toBeLessThan(before.lineRoom * 0.6);
    }
  });

  test("with reduced motion, the end of a turn is one frame: nothing leaves, nothing moves after", async () => {
    const frames = await playTurn("turn-live", "reduce");
    const sent = frames.findIndex((f) => f.messages > 0);
    const end = frames.findIndex((f, i) => i > sent && f.lines === 0 && f.messages > 0);
    expect(end).toBeGreaterThan(sent);
    for (const frame of frames) expect(frame.leaving).toEqual([]);
    const settled = frames[end]!.answerBottom!;
    for (const frame of frames.slice(end)) {
      expect(frame.asides).toEqual([]);
      expect(Math.abs(frame.answerBottom! - settled)).toBeLessThan(0.5);
    }
  });

  test("reading up while a turn ends: the line at the top of the view stays put", async () => {
    await page.setViewportSize({ width: 600, height: 700 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
    await page.goto(`${server.url}/gallery.html?board=turn-live-long&theme=light`);
    await page.waitForFunction(
      () => typeof (window as { playTurn?: unknown }).playTurn === "function",
    );
    const play = page.evaluate(() =>
      (window as unknown as { playTurn: () => Promise<void> }).playTurn(),
    );
    // Once the aside is there, scroll up a little to read, past the foot's slack.
    await page.waitForSelector(`${log} > [data-aside]`);
    await scrollBy(-120);
    await heardScroll();
    const before = await reading();
    await play;
    await page.waitForFunction((sel) => !document.querySelector(`${sel} > [data-leaving]`), log);
    expect(Math.abs((await whereIs(before.text))! - before.y)).toBeLessThan(2);
  });

  test("a thread opened after its turns ended shows them settled: answers only, nothing leaving", async () => {
    await open("turn-completed");
    expect(await page.$(`${log} [data-leaving]`)).toBeNull();
    expect(await page.$(`${log} [data-aside]`)).toBeNull();
    const text = await page.$eval(log, (el) => el.textContent ?? "");
    // The answer, and none of what was said on the way, nor any fold.
    expect(text).toContain("The flow is ready");
    expect(text).not.toContain("Copied the screen layout");
    expect(text).not.toContain("Worked for");
    expect(await page.$('[aria-expanded][data-slot^="trace"]')).toBeNull();
  });

  test("a running turn's asides: italic, quieter than the answer, close together, Markdown intact", async () => {
    await open("turn-running");
    const asides = await page.$$eval(`${log} > [data-aside]`, (els) =>
      els.map((el) => {
        const s = getComputedStyle(el);
        return {
          italic: s.fontStyle,
          color: s.color,
          bold: el.querySelector("strong") !== null,
          code: el.querySelector("code") !== null,
          list: el.querySelectorAll("li").length,
          top: el.getBoundingClientRect().top,
          bottom: el.getBoundingClientRect().bottom,
        };
      }),
    );
    // The flow's first three messages; its newest, with nothing after it, reads plain.
    expect(asides).toHaveLength(3);
    for (const a of asides) expect(a.italic).toBe("italic");
    expect(asides[0]!.bold).toBe(true);
    expect(asides[1]!.code).toBe(true);
    expect(asides[2]!.list).toBe(3);
    // A run of them: 6 between, where the thread's lines keep 14.
    expect(Math.round(asides[1]!.top - asides[0]!.bottom)).toBe(6);
    const plain = await page.$$eval(`${log} > div.text-13:not([data-aside])`, (els) => {
      const el = els.at(-1)!;
      return {
        italic: getComputedStyle(el).fontStyle,
        color: getComputedStyle(el).color,
        link: el.querySelector("a, button") !== null,
      };
    });
    expect(plain.italic).toBe("normal");
    expect(plain.link).toBe(true);
    expect(plain.color).not.toBe(asides[0]!.color);
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
