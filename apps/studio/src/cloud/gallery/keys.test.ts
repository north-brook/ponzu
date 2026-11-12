/*
 * The keyboard and the thread pane, and the pull request's keys, in a real Chromium: opening the
 * thread puts the caret in its composer once the pane is open (or on a question's first option),
 * never taking it from a field elsewhere, and closing gives it back; ⌘P shows the pull request
 * and ⌘⇧↵ presses the action button, each once a press, never under a menu or while the button
 * couldn't be pressed. Skips where there is no Chrome or Chromium.
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

describe.skipIf(!chromiumPath)("the thread's keyboard and the pull request's keys", () => {
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
  const THREAD = 'button[aria-controls="thread"]';
  const COMPOSER = '#thread textarea[aria-label="Message"]';
  const PR = 'header button[aria-label^="Pull request #"]';
  const expanded = () => page.getAttribute(THREAD, "aria-expanded");
  /** The focused element: its name, or its role, or its tag; and whether it is in the pane. */
  const focused = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      return {
        name: el?.getAttribute("aria-label") ?? el?.getAttribute("role") ?? el?.tagName ?? null,
        inThread: !!el?.closest("#thread"),
      };
    });
  /** The chrome's action button's words. */
  const actionLabel = async () =>
    (
      await page.$$eval("header button", (els) =>
        els
          .map((b) => b.textContent?.trim() ?? "")
          .filter((t) =>
            /^(Create PR|Ready|Merge|Auto-merge|Fix checks|Resolve|Update branch)$/.test(t),
          ),
      )
    )[0];
  /**
   * Waits until the pane has finished closing or opening: the window wears `data-pane-motion`
   * from the toggle's render until its easing ends, and what waits on the move (focus into the
   * thread) runs as it comes off. Call it once `expanded()` shows the toggle took.
   */
  const settled = () => page.waitForFunction(() => !document.querySelector("[data-pane-motion]"));

  test("⌥⌘B opens the thread with the caret in the composer, once the pane is open, not scrolled", async () => {
    await open("thread-in-the-right-rail", "no-preference");
    await page.keyboard.press("Meta+Alt+b");
    expect(await expanded()).toBe("false");
    await settled();
    // Where focus lands, and how wide the pane is when it does.
    await page.evaluate(() => {
      const w = window as { landed?: { name: string | null; width: number }[] };
      w.landed = [];
      document.addEventListener("focusin", (e) => {
        w.landed!.push({
          name: (e.target as Element).getAttribute("aria-label"),
          // The rail as the design sizes it: its panel and the 10 of gutter (its edge) before it.
          width: Math.round(
            document.querySelector("#thread-pane")!.getBoundingClientRect().width + 10,
          ),
        });
      });
    });
    await page.keyboard.press("Meta+Alt+b");
    expect(await expanded()).toBe("true");
    await page.waitForFunction(
      (sel) => document.activeElement === document.querySelector(sel),
      COMPOSER,
    );
    const landed = await page.evaluate(
      () => (window as { landed?: { name: string | null; width: number }[] }).landed,
    );
    // Once, and only after the pane had opened all the way.
    expect(landed).toEqual([{ name: "Message", width: 360 }]);
    // Nothing scrolled for it: the pane holds still and the thread sits at its foot.
    const scroll = await page.evaluate(() => {
      const pane = document.querySelector("#thread")!;
      const s = pane.querySelector('[role="log"]')!.parentElement!;
      return { pane: pane.scrollLeft, foot: s.scrollHeight - s.clientHeight - s.scrollTop };
    });
    expect(scroll.pane).toBe(0);
    expect(scroll.foot).toBeLessThan(2);
    // No ring on the field that claims attention: a caret, as after a click.
    expect(
      await page.$eval(
        COMPOSER,
        (el) => el.hasAttribute("data-quiet-focus") || !el.matches(":focus-visible"),
      ),
    ).toBe(true);
  });

  test("the toggle's click does the same, and closing gives the keyboard back to the window", async () => {
    await open("thread-in-the-right-rail");
    await page.click(THREAD);
    expect(await expanded()).toBe("false");
    await settled();
    expect((await focused()).inThread).toBe(false);
    await page.click(THREAD);
    await page.waitForFunction(
      (sel) => document.activeElement === document.querySelector(sel),
      COMPOSER,
    );
    // Closed with the caret inside: it leaves with the pane, never stuck in what went inert.
    await page.keyboard.type("Calmer");
    await page.keyboard.press("Meta+Alt+b");
    expect(await expanded()).toBe("false");
    await settled();
    expect(await focused()).toEqual({ name: "BODY", inThread: false });
    // And the draft is kept for when it opens again.
    await page.keyboard.press("Meta+Alt+b");
    await page.waitForFunction(
      (sel) => document.activeElement === document.querySelector(sel),
      COMPOSER,
    );
    expect(await page.inputValue(COMPOSER)).toBe("Calmer");
  });

  test("with a question in the composer's place, the keyboard lands on its first option", async () => {
    await open("needs-you-a-question");
    await page.keyboard.press("Meta+Alt+b");
    expect(await expanded()).toBe("false");
    await settled();
    await page.keyboard.press("Meta+Alt+b");
    await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "radio");
    expect(await page.evaluate(() => document.activeElement?.textContent)).toContain("Shorten it");
    expect(
      await page.evaluate(() => getComputedStyle(document.activeElement as Element).boxShadow),
    ).toBe("none");
  });

  test("a field elsewhere keeps the caret when the thread opens", async () => {
    await open("thread-in-the-right-rail");
    await page.keyboard.press("Meta+Alt+b");
    expect(await expanded()).toBe("false");
    await settled();
    await page.click("#sidebar [aria-current]", { button: "right" });
    await page.click('[role=menuitem]:has-text("Rename")');
    await page.waitForSelector('input[aria-label="Canvas name"]');
    await page.waitForSelector("[role=menu]", { state: "detached" });
    await page.keyboard.press("Meta+Alt+b");
    expect(await expanded()).toBe("true");
    await settled();
    expect((await focused()).name).toBe("Canvas name");
  });

  test("⌘P shows and hides the pull request from anywhere, and not under a menu", async () => {
    await open("thread-in-the-right-rail");
    const pressed = () => page.getAttribute(PR, "aria-pressed");
    expect(await pressed()).toBe("false");
    await page.keyboard.press("Meta+p");
    expect(await pressed()).toBe("true");
    await page.keyboard.press("Meta+p");
    expect(await pressed()).toBe("false");
    // The thread pane stays as it was throughout.
    expect(await expanded()).toBe("true");
    // From the composer, which keeps its words and its caret (no "p" typed into it).
    await page.fill(COMPOSER, "Keep the green");
    await page.focus(COMPOSER);
    await page.keyboard.press("Meta+p");
    expect(await pressed()).toBe("true");
    expect(await page.inputValue(COMPOSER)).toBe("Keep the green");
    expect((await focused()).name).toBe("Message");
    await page.keyboard.press("Meta+p");
    expect(await pressed()).toBe("false");
    // Under a menu it does nothing, and the menu stays.
    await page.click('#sidebar button[aria-label^="Workspace:"]');
    await page.waitForSelector("[role=menu]");
    await page.keyboard.press("Meta+p");
    expect(await pressed()).toBe("false");
    expect(await page.$("[role=menu]")).not.toBeNull();
    await page.keyboard.press("Escape");
    // Its tip says so.
    await page.hover(PR);
    const tip = await page.waitForSelector('[role="tooltip"]');
    expect((await tip.textContent())?.replace(/\s/g, "")).toContain("⌘P");
  });

  test("⌘⇧↵ presses the action button once a press, from the composer too, and says so", async () => {
    await open("thread-in-the-right-rail");
    const runs = () => page.evaluate(() => (window as { actionsRun?: string[] }).actionsRun ?? []);
    const label = await actionLabel();
    expect(label).toBeTruthy();
    await page.keyboard.press("Meta+Shift+Enter");
    expect(await runs()).toHaveLength(1);
    // Held down, the keys repeat: still one.
    await page.keyboard.down("Meta");
    await page.keyboard.down("Shift");
    await page.keyboard.down("Enter");
    await page.keyboard.down("Enter");
    await page.keyboard.down("Enter");
    await page.keyboard.up("Enter");
    await page.keyboard.up("Shift");
    await page.keyboard.up("Meta");
    expect(await runs()).toHaveLength(2);
    // From the composer: the action, and the words stay as they were (not sent, no new line).
    await page.fill(COMPOSER, "Keep the green");
    await page.focus(COMPOSER);
    await page.keyboard.press("Meta+Shift+Enter");
    expect(await runs()).toHaveLength(3);
    expect(await page.inputValue(COMPOSER)).toBe("Keep the green");
    // ⌘↵ there is still the composer's send, not the action.
    await page.keyboard.press("Meta+Enter");
    expect(await runs()).toHaveLength(3);
    // Under a menu: nothing.
    await page.click('#sidebar button[aria-label^="Workspace:"]');
    await page.waitForSelector("[role=menu]");
    await page.keyboard.press("Meta+Shift+Enter");
    expect(await runs()).toHaveLength(3);
    await page.keyboard.press("Escape");
    // Its tip names the keys.
    await page.hover(`header button:has-text("${label}")`);
    const tip = await page.waitForSelector('[role="tooltip"]');
    expect((await tip.textContent())?.replace(/\s/g, "")).toContain("⌘⇧↵");
  });

  test("⌘⇧↵ does nothing while the action can't be pressed", async () => {
    await open("thread-read-only");
    // Read-only: the action shows, faded, its tip saying why.
    const label = await actionLabel();
    expect(label).toBeTruthy();
    expect(await page.getAttribute(`header button:has-text("${label}")`, "aria-disabled")).toBe(
      "true",
    );
    await page.keyboard.press("Meta+Shift+Enter");
    const runs = await page.evaluate(() => (window as { actionsRun?: string[] }).actionsRun ?? []);
    expect(runs).toEqual([]);
  });
});
