/*
 * The handoff document (@ponzu/core/handoff), the page the API's GitHub setup and the Mac app's
 * sign-in leave a browser on, run in Chromium under the content security policy it is served
 * with: it opens the link by itself, says the app has it when the app takes the focus, offers the
 * link again when nothing did, and closes itself where the app has it already. Its script and
 * style run under their hashes alone, with no violation.
 *
 * No test here opens an app: the page's link is swapped for a fragment of its own address after
 * it is made, which only the markup carries (the hashes are of the script and style), so
 * "opening" it leaves the page where it is, as a link nothing answers does.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { HANDOFF_WAIT_MS, type Handoff, renderHandoff } from "@ponzu/core/handoff";
import { type Browser, chromiumPath, launch, type Page } from "../../scripts/visual-lib.ts";

setDefaultTimeout(30_000);

const LINKED: Handoff = {
  documentTitle: "Ponzu is set up on Lenny Learning",
  view: { title: "Ponzu is set up on Lenny Learning", body: "Opening Ponzu Dev…" },
  link: {
    href: "ponzu-dev://github/setup?result=installed&workspace=ws_1",
    app: "Ponzu Dev",
    opened: {
      title: "Ponzu is set up on Lenny Learning",
      body: "Ponzu has it. You can close this tab.",
    },
    missed: {
      title: "Ponzu is set up on Lenny Learning",
      body: "If Ponzu didn't open, it picks this up when you go back to it.",
    },
  },
};

const HAS_IT: Handoff = {
  documentTitle: "You're signed in",
  view: { title: "You're signed in", body: "Ponzu has it. You can close this tab." },
  link: null,
  closes: true,
};

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
const pages = new Map<string, Handoff>([
  ["/linked", LINKED],
  ["/has-it", HAS_IT],
]);

beforeAll(async () => {
  if (!chromiumPath) return;
  browser = await launch();
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const handoff = pages.get(new URL(request.url).pathname);
      if (!handoff) return new Response("Not found", { status: 404 });
      const { html, csp } = await renderHandoff(handoff);
      // Never a real app's link in a test: a fragment of this page, which goes nowhere.
      const safe = handoff.link ? html.replaceAll(escapeAttr(handoff.link.href), "#app") : html;
      return new Response(safe, {
        headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": csp },
      });
    },
  });
});

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

const escapeAttr = (text: string) => text.replaceAll("&", "&amp;");

/** A page at `path`, recording any policy violation and any attempt to close it. */
async function open(path: string, opts: { focused?: boolean } = {}): Promise<Page> {
  const page = await browser.newPage();
  await page.addInitScript((focused: boolean) => {
    const w = window as unknown as { violations: string[]; closes: number };
    w.violations = [];
    w.closes = 0;
    document.addEventListener("securitypolicyviolation", (event) =>
      w.violations.push(`${event.violatedDirective} ${event.blockedURI}`),
    );
    window.close = () => {
      w.closes++;
    };
    if (!focused) document.hasFocus = () => false;
  }, opts.focused ?? true);
  await page.goto(`http://127.0.0.1:${server.port}${path}`);
  return page;
}

const read = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { violations: string[]; closes: number };
    const shown = [...document.querySelectorAll("section")].filter(
      (section) => getComputedStyle(section).display !== "none",
    );
    return {
      state: document.querySelector("main")!.getAttribute("data-state"),
      shown: shown.map((section) => section.getAttribute("data-for")),
      text: shown.map((section) => section.textContent!.replace(/\s+/g, " ").trim()).join(" | "),
      button: shown.some((section) => section.querySelector("[data-retry]")),
      violations: w.violations,
      closes: w.closes,
    };
  });

describe.skipIf(!chromiumPath)("the handoff, in a browser", () => {
  test("it opens the link by itself and says so; when the app takes the focus, Ponzu has it and the tab closes", async () => {
    const page = await open("/linked");
    let now = await read(page);
    expect(now.state).toBe("opening");
    expect(now.shown).toEqual(["opening"]);
    expect(now.text).toContain("Opening Ponzu Dev…");
    expect(await page.evaluate(() => location.hash)).toBe("#app");

    // The app launching takes the page's focus.
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    now = await read(page);
    expect(now.state).toBe("opened");
    expect(now.shown).toEqual(["opened"]);
    expect(now.text).toContain("Ponzu has it. You can close this tab.");
    expect(now.closes).toBe(1);
    expect(now.violations).toEqual([]);
    await page.close();
  });

  test("when nothing takes the link, it offers it again, and focus leaving later still counts", async () => {
    const page = await open("/linked");
    await Bun.sleep(HANDOFF_WAIT_MS + 300);
    let now = await read(page);
    expect(now.state).toBe("missed");
    expect(now.shown).toEqual(["missed"]);
    expect(now.text).toContain("If Ponzu didn't open, it picks this up when you go back to it.");
    expect(now.text).toContain("Open Ponzu Dev");
    expect(now.button).toBe(true);
    expect(now.closes).toBe(0);

    // The button tries again, and watches again.
    await page.click("[data-retry]", { timeout: 2000 });
    now = await read(page);
    expect(now.state).toBe("opening");
    expect(now.shown).toEqual(["opening"]);

    // The person answers the browser's prompt late: the app takes the focus after all.
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    now = await read(page);
    expect(now.state).toBe("opened");
    expect(now.violations).toEqual([]);
    await page.close();
  });

  test("a link nobody answers, left alone past the wait, still turns to 'has it' when the app comes", async () => {
    const page = await open("/linked");
    await Bun.sleep(HANDOFF_WAIT_MS + 300);
    expect((await read(page)).state).toBe("missed");
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    // Not hidden: nothing happened.
    expect((await read(page)).state).toBe("missed");
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    expect((await read(page)).state).toBe("opened");
    await page.close();
  });

  test("with nothing to open and the app already forward, the page closes itself", async () => {
    const away = await open("/has-it", { focused: false });
    let now = await read(away);
    expect(now.shown).toEqual(["opening"]);
    expect(now.text).toContain("Ponzu has it. You can close this tab.");
    expect(now.closes).toBe(1);
    await away.close();

    // Still in front: it waits for the app to come forward, then closes.
    const here = await open("/has-it");
    expect((await read(here)).closes).toBe(0);
    await here.evaluate(() => window.dispatchEvent(new Event("blur")));
    now = await read(here);
    expect(now.closes).toBe(1);
    expect(now.violations).toEqual([]);
    await here.close();
  });

  test("light and dark: the slice is ink on light and yuzu on dark, on white and near black", async () => {
    const colors: Record<string, { ground: string; slice: string }> = {};
    for (const scheme of ["light", "dark"] as const) {
      const page = await browser.newPage({ colorScheme: scheme });
      await page.goto(`http://127.0.0.1:${server.port}/has-it`);
      colors[scheme] = await page.evaluate(() => ({
        ground: getComputedStyle(document.body).backgroundColor,
        slice: getComputedStyle(document.querySelector(".mark g")!).fill,
      }));
      await page.close();
    }
    expect(colors.light).toEqual({ ground: "rgb(255, 255, 255)", slice: "rgb(17, 17, 16)" });
    expect(colors.dark).toEqual({ ground: "rgb(14, 14, 13)", slice: "rgb(255, 200, 30)" });
  });
});
