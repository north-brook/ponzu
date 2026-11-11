/*
 * Guided setup, Settings and the blocking dialogs in a real Chromium: their keyboard, and the
 * rules a person meets as they type (a secret's name, the cap, a role). Skips where there is no
 * Chrome or Chromium. The pictures and styles are gallery.test.ts's, with every composition's.
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

describe.skipIf(!chromiumPath)("setup and settings", () => {
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

  const open = async (board: string, size = { width: 1440, height: 900 }) => {
    await page.setViewportSize(size);
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.goto(`${server.url}/gallery.html?board=${board}&theme=light`);
    await page.waitForFunction(() => (window as { galleryReady?: boolean }).galleryReady === true);
  };
  const dialog = '[role="dialog"]';
  const title = () => page.textContent(`${dialog} h2:not(.sr-only)`);
  const focused = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
  const inView = (selector: string) =>
    page.$eval(selector, (el) => {
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight;
    });

  test("Settings: Escape closes it, ⌘, opens it again, and Tab stays inside", async () => {
    await open("settings-account");
    await page.waitForSelector(dialog);
    await page.keyboard.press("Escape");
    await page.waitForSelector(dialog, { state: "detached" });
    await page.keyboard.press("Meta+,");
    await page.waitForSelector(dialog);
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press("Tab");
      const inside = await page.evaluate(
        () => !!document.activeElement?.closest('[role="dialog"]'),
      );
      expect(inside).toBe(true);
    }
  });

  test("Settings: the nav swaps the section, and a personal workspace has no Members", async () => {
    await open("settings-account");
    await page.click('nav[aria-label="Settings"] button:has-text("Members")');
    expect(await title()).toBe("Members");
    await page.click(`${dialog} button[aria-label="Workspace: Northbrook"]`);
    await page.click('[role="menuitemradio"]:has-text("Personal")');
    // Members gives way to Plan and usage, and leaves the nav.
    expect(await title()).toBe("Plan and usage");
    expect(await page.$('nav[aria-label="Settings"] button:has-text("Members")')).toBeNull();
  });

  test("a secret: its name is written as a variable, Return saves, a repeat is refused", async () => {
    await open("settings-environments");
    await page.click('button:has-text("Add")');
    await page.keyboard.type("stripe webhook-secret");
    expect(await page.inputValue('input[aria-label="Name"]')).toBe("STRIPE_WEBHOOK_SECRET");
    await page.fill('input[aria-label="Value"]', "whsec_123");
    await page.press('input[aria-label="Value"]', "Enter");
    await page.waitForSelector('span:text-is("STRIPE_WEBHOOK_SECRET")');

    await page.click('button:has-text("Add")');
    await page.keyboard.type("database_url");
    expect(await page.textContent('[role="alert"]')).toBe("DATABASE_URL is already here");
    await page.fill('input[aria-label="Value"]', "postgres://…");
    await page.press('input[aria-label="Value"]', "Enter");
    // Not saved: the form is still open.
    expect(await page.$('input[aria-label="Name"]')).not.toBeNull();
  });

  test("Escape in a secret's field cancels the edit and leaves Settings open", async () => {
    await open("settings-environments");
    await page.click('button[aria-label="Edit DATABASE_URL"]');
    await page.waitForSelector('input[aria-label="New value for DATABASE_URL"]');
    await page.keyboard.press("Escape");
    await page.waitForSelector('input[aria-label="New value for DATABASE_URL"]', {
      state: "detached",
    });
    expect(await page.$(dialog)).not.toBeNull();
    expect(await focused()).toBe("Edit DATABASE_URL");
  });

  test("the cap: below what is billed is refused, Return saves, Escape puts it back", async () => {
    await open("settings-plan-solo");
    const field = 'input[aria-label="Monthly cap in dollars"]';
    await page.click('button[aria-label="Change cap"]');
    await page.fill(field, "10");
    expect(await page.textContent('[role="alert"]')).toBe("At least $22, billed so far");
    await page.press(field, "Enter");
    expect(await page.$(field)).not.toBeNull();
    // Clicking away keeps the refused cap and its reason in view rather than dropping them.
    await page.click(`${dialog} h2:not(.sr-only)`);
    expect(await page.inputValue(field)).toBe("10");
    expect(await page.textContent('[role="alert"]')).toBe("At least $22, billed so far");
    await page.fill(field, "75");
    await page.press(field, "Enter");
    await page.waitForSelector(field, { state: "detached" });
    await page.waitForSelector('span:has-text("Cap $75")');
    expect(await focused()).toBe("Change cap");

    await page.click('button[aria-label="Change cap"]');
    await page.fill(field, "300");
    await page.keyboard.press("Escape");
    await page.waitForSelector(field, { state: "detached" });
    expect(await page.$('span:has-text("Cap $75")')).not.toBeNull();
    expect(await page.$(dialog)).not.toBeNull();
    // Focus is back on the pencil, so the next Tab carries on from the row.
    expect(await focused()).toBe("Change cap");
  });

  test("roles: an admin changes a member's, and the account's owner is locked", async () => {
    await open("settings-members");
    expect(await page.$('button[aria-label^="Role of Bryce Bjork"]')).toBeNull();
    await page.click('button[aria-label="Role of Maya Ortiz: Member"]');
    await page.click('[role="menuitemradio"]:has-text("Admin")');
    await page.waitForSelector('button[aria-label="Role of Maya Ortiz: Admin"]');
  });

  test("where you design: Continue waits for an account, which turns Ready on return", async () => {
    await open("setup-where-nothing-ready");
    const continueButton = 'button:has-text("Continue")';
    expect(await page.$eval(continueButton, (b) => (b as HTMLButtonElement).disabled)).toBe(true);
    await page.click('button:has-text("Set up")');
    await page.waitForSelector('span:text-is("Ready")');
    expect(await page.$eval(continueButton, (b) => (b as HTMLButtonElement).disabled)).toBe(false);
  });

  test("where you design: a dozen accounts in the smallest window leave Continue in reach", async () => {
    await open("setup-where-many", { width: 1100, height: 640 });
    expect(await inView('button:has-text("Continue")')).toBe(true);
    expect(await inView('button:has-text("Don\'t see an organization?")')).toBe(true);
    // The rows past what fits are a scroll inside the card away.
    expect(await inView('span:text-is("Ridgeline")')).toBe(false);
    await page.hover('span:text-is("Personal")');
    await page.mouse.wheel(0, 2000);
    await page.waitForFunction(() => {
      const row = [...document.querySelectorAll("span")].find((s) => s.textContent === "Ridgeline");
      return row && row.getBoundingClientRect().bottom <= window.innerHeight;
    });
    expect(await inView('button:has-text("Continue")')).toBe(true);
  });

  test("paste the code: a paste keeps only the code, and Return connects", async () => {
    await open("setup-claude");
    await page.click('button:has-text("Sign in")');
    const field = 'input[id]:not([type="password"])';
    await page.waitForSelector(field);
    await page.waitForFunction(() => document.activeElement?.tagName === "INPUT");
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.setData("text", "Your code: k7Hq2Rw9xT#pL4mZ (copy it)");
      document.activeElement!.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    });
    expect(await page.inputValue(field)).toBe("k7Hq2Rw9xT#pL4mZ");
    await page.press(field, "Enter");
    await page.waitForSelector('h1:has-text("Get Ponzu on your iPhone")');
  });

  test("a key that doesn't work keeps what was typed and says so, and Connect holds", async () => {
    await open("setup-api-key");
    const connect = () =>
      page.$eval('button:has-text("Connect")', (b) => b.getBoundingClientRect().top);
    const before = await connect();
    await page.keyboard.type("wrong");
    await page.keyboard.press("Enter");
    await page.waitForSelector('[role="alert"]:has-text("Anthropic didn\'t accept that key.")');
    expect(await page.inputValue('input[type="password"]')).toBe("wrong");
    expect(await connect()).toBe(before);
  });

  test("a key copied with a stray space and line break arrives without them", async () => {
    await open("setup-api-key");
    await page.keyboard.insertText(" sk-ant-api03-abc \n");
    expect(await page.inputValue('input[type="password"]')).toBe("sk-ant-api03-abc");
  });

  test("a confirmation is an alert dialog: Tab stays inside, Escape or the dim leaves it", async () => {
    const alert = '[role="alertdialog"]';
    await open("disconnect-claude");
    await page.waitForSelector(alert);
    expect(await page.$eval(alert, (el) => el.getAttribute("aria-labelledby") !== null)).toBe(true);
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate((s) => !!document.activeElement?.closest(s), alert)).toBe(true);
    }
    await page.keyboard.press("Escape");
    await page.waitForSelector(alert, { state: "detached" });

    await open("delete-account");
    await page.waitForSelector(alert);
    await page.mouse.click(4, 4);
    await page.waitForSelector(alert, { state: "detached" });
  });

  test("free credits used up: Escape leaves it, and the prompt stays in the composer", async () => {
    await open("free-credits");
    await page.waitForSelector(dialog);
    await page.keyboard.press("Escape");
    await page.waitForSelector(dialog, { state: "detached" });
    expect(await page.inputValue("textarea")).toBe(
      "Try a darker footer with the newsletter signup",
    );
  });
});
