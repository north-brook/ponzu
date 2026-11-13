/*
 * ⌘K in the studio as it ships, in a real Chromium, on Ponzu Cloud in memory (fake-host.ts),
 * whose search answers by the API's rules (@ponzu/client/testing): a canvas, a page, a board and
 * a comment found across canvases, each opened in place; a comment deleted since its answer; the
 * last answer kept while the next is slow; and the line when search doesn't answer. Skips where
 * there is no Chrome or Chromium.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import { type Browser, chromiumPath, launch, type Page } from "../../scripts/visual-lib.ts";
import { buildApp, serve, waitUntil } from "./e2e-lib.ts";

setDefaultTimeout(60_000);

describe.skipIf(!chromiumPath)("search, on Ponzu Cloud in memory", () => {
  let dir: string;
  let server: ReturnType<typeof serve>;
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];
  let world: { onboarding: string; checkout: string; thread: string };

  beforeAll(async () => {
    dir = await buildApp("e2e");
    server = serve(dir);
    browser = await launch();
    page = await browser.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(`${server.url}?as=returning`);
  });
  afterAll(async () => {
    await browser?.close();
    server?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const field = 'input[role="combobox"]';
  const activeTab = () =>
    page.getByRole("tablist", { name: "Pages" }).locator('[aria-selected="true"]').textContent();
  /** The selected result's words. */
  const selected = () =>
    page.locator('[role="option"][aria-selected="true"]').textContent({ timeout: 5000 });
  /**
   * Opens search and types `words`, waiting for the answer to them (not the last one, kept on
   * screen while it comes), holding `expected`.
   */
  const search = async (words: string, expected: RegExp) => {
    if (!(await page.locator(field).count())) {
      await page.click('#sidebar button[aria-label="Search"]');
    }
    await page.fill(field, words);
    await page.locator('[role="listbox"]:not([aria-busy="true"])').waitFor();
    await page.getByRole("option", { name: expected }).waitFor();
  };

  test("a canvas, a page, a board and a comment are found across canvases", async () => {
    await page.locator("#sidebar").waitFor();
    world = await page.evaluate(async () => {
      const fake = window.ponzuFake!;
      const { backend } = fake;
      const onboarding = [...backend.canvases.values()].find(
        (c) => c.sequencer.doc.name === "Onboarding flow",
      )!;
      const welcome = onboarding.sequencer.doc.pages[0]!.artboards[0]!;
      // A page with its icon and a board on it, as the agent makes them.
      backend.agent(onboarding.id).commit([
        {
          op: "page.create",
          index: 1,
          page: { id: "pg_zebra", name: "Zebra stripes", icon: "card" },
        },
        {
          op: "artboard.create",
          page: "pg_zebra",
          index: 0,
          artboard: {
            id: "ab_zebra",
            name: "Zebra mobile",
            x: 0,
            y: 0,
            root: {
              kind: "el",
              id: "ab_zebra",
              tag: "div",
              attrs: {},
              style: { width: "390px", height: "844px", background: "#e4ecef" },
              children: [],
            },
          },
        },
      ]);
      // Sam's comment on Welcome.
      const sam = backend.connect(fake.teammate).api;
      const author = { kind: "user" as const, id: fake.teammate.id, name: "Sam Lee" };
      await sam.canvases.commit(onboarding.id, [
        {
          id: "op_zebra_comment",
          op: {
            op: "thread.create",
            thread: {
              id: "th_zebra",
              artboardId: welcome.id,
              x: 120,
              y: 160,
              status: "open",
              createdAt: Date.now(),
              updatedAt: Date.now(),
              messages: [
                {
                  id: "m_zebra",
                  author,
                  text: "Could a zebra print sit behind the welcome?",
                  createdAt: Date.now(),
                },
              ],
            },
          },
        },
      ]);
      // Another canvas, named for it.
      const me = backend.connect(fake.me).api;
      const checkout = await me.canvases.create({
        workspaceId: fake.workspaceId,
        repoId: onboarding.repoId!,
        name: "Zebra checkout",
      });
      fake.drawBoard(checkout.id, "Cart");
      return { onboarding: onboarding.id, checkout: checkout.id, thread: "th_zebra" };
    });
    await page.locator(`[data-canvas-row="${world.checkout}"]`).waitFor();

    await search("zebra", /Zebra mobile/);
    const groups = await page.$$eval('[role="listbox"] [role="group"]', (els) =>
      els.map((group) => ({
        label: group.querySelector("span")!.textContent,
        rows: [...group.querySelectorAll('[role="option"]')].map((row) =>
          row.textContent!.replace(/\s+/g, " ").trim(),
        ),
      })),
    );
    expect(groups.map((group) => group.label)).toEqual(["Canvases", "Boards", "Comments"]);
    expect(groups[0]!.rows).toEqual(["Zebra checkoutponzu · pz/zebra-checkout"]);
    // Pages and boards in one group, as ranked: equal here, so a board before a page.
    expect(groups[1]!.rows).toEqual([
      "Zebra mobilein Onboarding flow",
      "Zebra stripesPage in Onboarding flow",
    ]);
    // Sam's initial for his avatar, his words in quotes, then who, where and when.
    expect(groups[2]!.rows).toEqual([
      "S“Could a zebra print sit behind the welcome?”Sam · Onboarding flow · just now",
    ]);
    expect(await page.locator('#sidebar [role="status"]').textContent()).toBe("4 results");
    // The first is selected, and the arrows walk the groups in order.
    expect(await selected()).toMatch(/^Zebra checkout/);
    await page.keyboard.press("ArrowDown");
    expect(await selected()).toBe("Zebra mobilein Onboarding flow");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    expect(await selected()).toMatch(/^S“Could a zebra print/);
  });

  test("Return opens a board on its page, a page, and a comment with its thread open", async () => {
    // The board: its page is the one showing, and the board is in view.
    await search("zebra mobile", /Zebra mobile/);
    await page.keyboard.press("Enter");
    await page.waitForSelector(field, { state: "detached" });
    await waitUntil(async () => (await activeTab().catch(() => null)) === "Zebra stripes");
    await page.locator('[data-board-name][title="Zebra mobile"]').waitFor();

    // A page, from another page: the tab follows.
    await page.getByRole("tablist", { name: "Pages" }).getByRole("tab").first().click();
    await waitUntil(async () => (await activeTab()) !== "Zebra stripes");
    await search("zebra stripes", /Zebra stripes/);
    await page.keyboard.press("Enter");
    await waitUntil(async () => (await activeTab()) === "Zebra stripes");

    // A comment: its thread open on the canvas, its words there.
    await search("zebra print", /Could a zebra print/);
    await page.keyboard.press("Enter");
    await page.locator("[data-comment-open]").waitFor({ state: "attached" });
    await page.getByPlaceholder("Reply…").waitFor();
    await page
      .locator(".pz-root")
      .getByText("Could a zebra print sit behind the welcome?")
      .waitFor();
    await waitUntil(async () => (await activeTab()) !== "Zebra stripes");
    await page.keyboard.press("Escape");

    // A canvas: it opens, as from the list.
    await search("zebra checkout", /Zebra checkout/);
    await page.keyboard.press("Enter");
    await page.locator('[data-board-name][title="Cart"]').waitFor();
    expect(errors).toEqual([]);
  });

  test("a comment deleted since the answer goes to where it was, and says so", async () => {
    await search("zebra print", /Could a zebra print/);
    await page.evaluate(async ({ onboarding, thread }) => {
      const fake = window.ponzuFake!;
      await fake.backend
        .connect(fake.teammate)
        .api.canvases.commit(onboarding, [
          { id: "op_zebra_delete", op: { op: "thread.delete", id: thread } },
        ]);
    }, world);
    // The answer on screen is from before; opening it finds the thread gone.
    await page.keyboard.press("Enter");
    await page.getByText("That comment was deleted. This is where it was.").waitFor();
    await page.locator('[data-board-name][title="Welcome"]').waitFor();
  });

  test("a slow answer keeps the last one on screen until it lands", async () => {
    await search("zebra", /Zebra checkout/);
    await page.evaluate(() => {
      window.ponzuFake!.backend.latencyMs = 1500;
    });
    await page.fill(field, "zebra mob");
    const rows = () =>
      page.$$eval('[role="option"]', (els) => els.map((el) => el.textContent!.slice(0, 14)));
    // Still the last answer's rows, marked busy, not an empty list or "Searching…".
    expect(await page.getAttribute('[role="listbox"]', "aria-busy")).toBe("true");
    expect(await rows()).toContain("Zebra checkout");
    // Past the debounce, with the new words asked and not yet answered: still the last rows.
    await page.waitForFunction(() => window.ponzuFake!.answers.waiting > 0);
    expect(await rows()).toContain("Zebra checkout");
    expect(await page.getByText("Searching…").count()).toBe(0);
    // Then the new one.
    await page.locator('[role="listbox"]:not([aria-busy="true"])').waitFor();
    expect(await rows()).toEqual(["Zebra mobilein"]);
    // An empty answer is never said of the next words while they are asked.
    await page.evaluate(() => {
      window.ponzuFake!.backend.latencyMs = 0;
    });
    await page.fill(field, "qqqzzx");
    await page.getByText("No results for “qqqzzx”").waitFor();
    await page.evaluate(() => {
      window.ponzuFake!.backend.latencyMs = 1500;
    });
    // Words not asked before, so no answer to them is kept.
    await page.fill(field, "zebra mobil");
    await page.waitForFunction(() => window.ponzuFake!.answers.waiting > 0);
    expect(await page.getByText(/No results for/).count()).toBe(0);
    await page.getByText("Searching…").waitFor();
    await page.locator('[role="listbox"]:not([aria-busy="true"])').waitFor();
    expect(await rows()).toEqual(["Zebra mobilein"]);
    await page.evaluate(() => {
      window.ponzuFake!.backend.latencyMs = 0;
    });
  });

  /** Whether the line `id` of the thread is drawn inside the rail's scrolled view. */
  const lineInView = (id: string) =>
    page.evaluate((id) => {
      const line = document.querySelector(`#thread [role="log"] > [data-item="${id}"]`);
      const scroller = document.querySelector('#thread [role="log"]')?.parentElement;
      if (!line || !scroller) return false;
      const own = line.getBoundingClientRect();
      const box = scroller.getBoundingClientRect();
      return own.top >= box.top && own.bottom <= box.bottom;
    }, id);
  const washed = (id: string) =>
    page.locator(`#thread [data-item="${id}"]`).first().getAttribute("data-revealed");
  let garden: { id: string; question: string; answer: string };

  test("a message older than the page the rail holds is paged back to and shown", async () => {
    garden = await page.evaluate(async () => {
      const fake = window.ponzuFake!;
      const { backend } = fake;
      const repoId = [...backend.canvases.values()].find((c) => c.repoId)!.repoId!;
      const canvas = await backend
        .connect(fake.me)
        .api.canvases.create({ workspaceId: fake.workspaceId, repoId, name: "Garden plan" });
      const sam = backend.connect(fake.teammate).api;
      const agent = backend.agent(canvas.id);
      // Seventy turns: the first is the one found, three pages back from the newest.
      const question = (
        await sam.canvases.sendMessage(canvas.id, { text: "Where does the zebra grass go?" })
      ).id;
      const answer = agent.say("The zebra grass goes by the gate, in the tall planters.");
      for (let i = 1; i < 70; i++) {
        await sam.canvases.sendMessage(canvas.id, { text: `And bed ${i}?` });
        agent.say(`Bed ${i} gets the low ferns.`);
        // Each write's live rows go out in a microtask. Real Realtime delivers each in a task of
        // its own; without this yield, 140 writes in one task are 140 nested renders, which React
        // refuses past 50 on a slow machine ("Maximum update depth exceeded").
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      // History is read a page at a time only while the live thread isn't there.
      backend.realtime.disconnect();
      return { id: canvas.id, question, answer };
    });
    // The thread's pane closed: the result opens it.
    const threadShown = () =>
      page.locator('button[aria-controls="thread"]').getAttribute("aria-expanded");
    if ((await threadShown()) === "true") {
      await page.locator('button[aria-controls="thread"]').click();
      await waitUntil(async () => (await threadShown()) === "false");
    }
    await search("zebra grass", /Where does the zebra grass go/);
    const option = page.getByRole("option", { name: /Where does the zebra grass go/ });
    expect((await option.textContent())?.replace(/\s+/g, " ")).toContain(
      "Sam · Garden plan · just now",
    );
    await page.keyboard.press("Enter");
    await page.waitForSelector(field, { state: "detached" });
    await waitUntil(async () => (await threadShown()) === "true");
    await waitUntil(() => lineInView(garden.question));
    // Reduced motion: brought into view, never washed.
    expect(await washed(garden.question)).toBeNull();
    // Opened to read, not to type: the composer doesn't take the keyboard.
    expect(
      await page.evaluate(() => document.activeElement?.closest("#thread") ?? null),
    ).toBeNull();
    await page.evaluate(() => window.ponzuFake!.backend.realtime.reconnect());
    expect(errors).toEqual([]);
  });

  test("with motion, the line shown is washed in pith a moment", async () => {
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
    // The agent's answer, on the canvas already open, with its thread's pane closed.
    const toggle = page.locator('button[aria-controls="thread"]');
    await toggle.click();
    await waitUntil(async () => (await toggle.getAttribute("aria-expanded")) === "false");
    await search("zebra grass gate", /The zebra grass goes by the gate/);
    await page.keyboard.press("Enter");
    await waitUntil(async () => (await washed(garden.answer)) === "");
    expect(await lineInView(garden.answer)).toBe(true);
    // Then it fades and the mark goes.
    await waitUntil(async () => (await washed(garden.answer)) === null, 5000);
    // The pane opened (and eased open long since) to be read: the keyboard isn't in it.
    expect(await toggle.getAttribute("aria-expanded")).toBe("true");
    expect(
      await page.evaluate(() => document.activeElement?.closest("#thread") ?? null),
    ).toBeNull();
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  });

  test("a pull request opens on its tab", async () => {
    await page.evaluate(async ({ checkout }) => {
      const { backend } = window.ponzuFake!;
      backend.agent(checkout).push([{ path: "src/checkout.tsx", additions: 12, deletions: 2 }]);
      backend.canvas(checkout).github!.open("maya", "Zebra checkout, one page");
    }, world);
    await search("zebra checkout one page", /Zebra checkout, one page/);
    const option = page.getByRole("option", { name: /Zebra checkout, one page/ });
    expect((await option.textContent())?.replace(/\s+/g, " ")).toMatch(
      /^Zebra checkout, one page#\d+ · Draft · Zebra checkout$/,
    );
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { name: "Zebra checkout, one page" }).waitFor();
    expect(errors).toEqual([]);
  });

  test("a person filters the list to the canvases they started", async () => {
    const samCanvas = await page.evaluate(async () => {
      const fake = window.ponzuFake!;
      const repoId = [...fake.backend.canvases.values()].find((c) => c.repoId)!.repoId!;
      const made = await fake.backend
        .connect(fake.teammate)
        .api.canvases.create({ workspaceId: fake.workspaceId, repoId, name: "Fern wall" });
      return made.id;
    });
    await page.locator(`[data-canvas-row="${samCanvas}"]`).waitFor();
    await search("sam lee", /Sam Lee/);
    const groups = await page.$$eval('[role="listbox"] [role="group"] > span', (els) =>
      els.map((el) => el.textContent),
    );
    expect(groups).toEqual(["People"]);
    await page.keyboard.press("Enter");
    await page.waitForSelector(field, { state: "detached" });
    await waitUntil(async () => {
      const rows = await page.$$eval("#sidebar [data-canvas-row]", (els) =>
        els.map((el) => el.getAttribute("data-canvas-row")),
      );
      return rows.length === 1 && rows[0] === samCanvas;
    });
    expect(errors).toEqual([]);
  });

  test("with no answer and nothing to show, it says search isn't answering", async () => {
    await page.evaluate(() => {
      window.ponzuFake!.backend.online = false;
    });
    await page.keyboard.press("Escape");
    await page.waitForSelector(field, { state: "detached" });
    await page.click('#sidebar button[aria-label="Search"]');
    await page.fill(field, "quokka");
    await page.getByText("Search isn't answering. Try again in a moment.").waitFor();
    await page.evaluate(() => {
      window.ponzuFake!.backend.online = true;
    });
    // A field longer than the API takes can't be typed.
    expect(await page.$eval(field, (el) => (el as HTMLInputElement).maxLength)).toBe(200);
    expect(errors).toEqual([]);
  });
});
