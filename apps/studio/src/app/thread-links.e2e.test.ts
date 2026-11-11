/*
 * Links in the agent's words to a page or board, in the studio as it ships, in a real Chromium,
 * on Ponzu Cloud in memory (fake-host.ts): a board on the page showing and one on another page,
 * a page, a board since deleted, another design, an ordinary link and one dressed as ours, a
 * link mid-stream, by keyboard, in light and dark. Skips where there is no Chrome or Chromium.
 *
 * With PONZU_SHOTS set to a folder, it leaves a picture of each there.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromiumPath, launch, type Page } from "../../scripts/visual-lib.ts";
import { buildApp, serve, waitUntil } from "./e2e-lib.ts";

setDefaultTimeout(60_000);

const SHOTS = process.env.PONZU_SHOTS;
const SITE = "https://ponzu.design/designs";

describe.skipIf(!chromiumPath)("links to pages and boards in the agent's words", () => {
  let dir: string;
  let server: ReturnType<typeof serve>;
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];
  /** The seeded design, its boards, a second page and another design. */
  let world: {
    id: string;
    other: string;
    welcome: string;
    picker: string;
    mobile: string;
    phone: string;
  };

  beforeAll(async () => {
    dir = await buildApp("e2e");
    server = serve(dir);
    browser = await launch();
    page = await browser.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "light" });
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(`${server.url}?as=returning`);
  });
  afterAll(async () => {
    if (SHOTS && page) await page.screenshot({ path: join(SHOTS, "last.png") }).catch(() => {});
    await browser?.close();
    server?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const shoot = async (name: string) => {
    if (!SHOTS) return;
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  };
  const rail = () => page.locator("#thread");
  const opened = () => page.evaluate(() => [...window.ponzuFake!.opened]);
  const activeTab = () =>
    page.getByRole("tablist", { name: "Pages" }).locator('[aria-selected="true"]').textContent();
  /** The board's box on screen, and whether all of it is in the canvas's pane. */
  const inView = async (name: string) => {
    const board = page.locator(`[data-board-name][title="${name}"]`);
    if (!(await board.count())) return false;
    const box = (await board.boundingBox())!;
    const thread = (await rail().boundingBox())!;
    return box.x > 0 && box.x + box.width < thread.x && box.y > 0 && box.y < 900;
  };

  test("a design opens with the agent's reply naming its boards and pages as links", async () => {
    await page.locator("#sidebar").waitFor();
    world = await page.evaluate(async () => {
      const fake = window.ponzuFake!;
      const { backend } = fake;
      const design = [...backend.designs.values()].find(
        (d) => d.sequencer.doc.name === "Onboarding flow",
      )!;
      const doc = design.sequencer.doc;
      const [welcome, picker] = doc.pages[0]!.artboards.map((a) => a.id);
      // A second page with a board, as the agent makes it; and another design of the team's.
      const mobile = "pg_mobile";
      const phone = "ab_phone";
      backend.agent(design.id).commit([
        { op: "page.create", index: 1, page: { id: mobile, name: "Mobile" } },
        {
          op: "artboard.create",
          page: mobile,
          index: 0,
          artboard: {
            id: phone,
            name: "Phone home",
            x: 0,
            y: 0,
            root: {
              kind: "el",
              id: phone,
              tag: "div",
              attrs: {},
              style: { width: "390px", height: "844px", background: "#e4ecef" },
              children: [],
            },
          },
        },
      ]);
      const api = backend.connect(fake.me).api;
      const other = await api.designs.create({
        workspaceId: fake.workspaceId,
        repoId: design.repoId!,
        name: "Checkout",
      });
      fake.drawBoard(other.id, "Cart");
      return { id: design.id, other: other.id, welcome: welcome!, picker: picker!, mobile, phone };
    });
    await page.evaluate((id) => window.ponzuFake!.link({ kind: "design", designId: id }), world.id);
    await page.locator('[data-board-name][title="Welcome"]').waitFor();
    if (!(await rail().count())) await page.getByRole("button", { name: /thread/i }).click();
    await rail().waitFor();

    const { id, other, picker, mobile, phone } = world;
    await page.evaluate(
      ([designId, text]) => window.ponzuFake!.backend.agent(designId!).say(text!),
      [
        id,
        [
          `The repo picker is on [Pick a repo](${SITE}/${id}?artboard=${picker}), and the phone version on [Phone home](${SITE}/${id}?artboard=${phone}).`,
          `Everything for small screens is on [Mobile](${SITE}/${id}?page=${mobile}), and the rest of [Onboarding flow](${SITE}/${id}) is as it was.`,
          `I dropped [Hero / B](${SITE}/${id}?artboard=ab_gone1) in favour of A.`,
          `The cart is in [Checkout](${SITE}/${other}?artboard=ab_x).`,
          "See [the docs](https://ponzu.design/docs) and [this](https://ponzu.design.evil.test/designs/x?artboard=ab_1).",
        ].join("\n\n"),
      ],
    );
    await rail().getByRole("link", { name: "Pick a repo" }).waitFor();
    // Ours carry no target and say where they go; the gone one is no link at all.
    expect(await rail().locator("a[data-place]").count()).toBe(5);
    expect(await rail().getByRole("link", { name: "Hero / B" }).count()).toBe(0);
    expect(await rail().locator('[data-place="gone"]').textContent()).toBe("Hero / B");
    expect(await rail().getByRole("link", { name: "the docs" }).getAttribute("data-place")).toBe(
      null,
    );
    expect(await rail().getByRole("link", { name: "this" }).getAttribute("data-place")).toBe(null);
    await shoot("1-links-light");
  });

  test("a board on the page showing: the canvas frames it and marks it, in place", async () => {
    // Off somewhere else first, so the jump is seen.
    await page.mouse.move(400, 400);
    await page.mouse.wheel(0, 3000);
    await page.waitForTimeout(200);
    const before = page.url();
    await rail().getByRole("link", { name: "Pick a repo" }).hover();
    await page.waitForTimeout(250);
    await shoot("2-hover");
    await rail().getByRole("link", { name: "Pick a repo" }).click();
    await page.locator("[data-beacon]").waitFor();
    await waitUntil(() => inView("Pick a repo"));
    await page.waitForTimeout(300);
    await shoot("3-board-marked");
    expect(await opened()).toEqual([]);
    expect(page.url()).toBe(before);
    // The mark goes by itself.
    await page.locator("[data-beacon]").waitFor({ state: "detached" });
  });

  test("a board on another page switches to its page first; a page shows whole", async () => {
    await rail().getByRole("link", { name: "Phone home" }).click();
    await waitUntil(async () => (await activeTab())?.includes("Mobile") ?? false);
    await waitUntil(() => inView("Phone home"));
    await page.locator("[data-beacon]").waitFor();
    await shoot("4-other-page");

    await page.getByRole("tablist", { name: "Pages" }).getByRole("tab").first().click();
    await waitUntil(async () => !((await activeTab())?.includes("Mobile") ?? true));
    await rail().getByRole("link", { name: "Mobile" }).click();
    await waitUntil(async () => (await activeTab())?.includes("Mobile") ?? false);
    expect(await opened()).toEqual([]);
  });

  test("by keyboard: focus shows a ring, Enter follows it", async () => {
    await page.getByRole("tablist", { name: "Pages" }).getByRole("tab").first().click();
    await rail().getByRole("link", { name: "Phone home" }).focus();
    await page.waitForTimeout(150);
    await shoot("5-focus");
    await page.keyboard.press("Enter");
    await waitUntil(async () => (await activeTab())?.includes("Mobile") ?? false);
    expect(await opened()).toEqual([]);
  });

  test("a link to the design itself shows the page that's open, whole", async () => {
    await page.getByRole("tablist", { name: "Pages" }).getByRole("tab").first().click();
    await waitUntil(() => inView("Welcome"));
    await page.mouse.move(400, 400);
    await page.mouse.wheel(0, 3000);
    await waitUntil(async () => !(await inView("Welcome")));
    await rail().getByRole("link", { name: "Onboarding flow" }).click();
    await waitUntil(() => inView("Welcome"));
    expect(await activeTab()).not.toContain("Mobile");
    expect(await opened()).toEqual([]);
  });

  test("a board since deleted is muted text that says what happened", async () => {
    await rail().locator('[data-place="gone"]').hover();
    await page.getByRole("tooltip").getByText("This board isn't in the design any more").waitFor();
    await shoot("6-gone");
    // And one that goes while the reply is on screen turns muted then.
    await page.evaluate(
      ([designId, board]) =>
        window.ponzuFake!.backend.agent(designId!).commit([{ op: "artboard.delete", id: board! }]),
      [world.id, world.picker],
    );
    await waitUntil(async () => (await rail().locator('[data-place="gone"]').count()) === 2);
  });

  test("ordinary links, and one dressed as ours, leave the app as before", async () => {
    await rail().getByRole("link", { name: "the docs" }).click();
    await rail().getByRole("link", { name: "this" }).click();
    expect(await opened()).toEqual([
      "https://ponzu.design/docs",
      "https://ponzu.design.evil.test/designs/x?artboard=ab_1",
    ]);
  });

  test("while a reply streams, a half-written link shows only its words", async () => {
    const say = (text: string, streaming: boolean) =>
      page.evaluate(
        ([designId, t, s]) =>
          window.ponzuFake!.backend.agent(designId as string).say(t as string, {
            id: "ti_stream00000001",
            streaming: s as boolean,
          }),
        [world.id, text, streaming],
      );
    const line = `The three options are on [Phone home](${SITE}/${world.id}?artboard=${world.phone})`;
    await say(line.slice(0, line.indexOf("(") + 20), true);
    await rail().getByText("The three options are on Phone home").waitFor();
    const text = (await rail().textContent()) ?? "";
    expect(text).not.toContain("[Phone");
    expect(text).not.toContain("](");
    expect(text).not.toContain("ponzu.design/des");
    await shoot("7-streaming");
    // Closed while still streaming, it works at once.
    await say(`${line}, and`, true);
    await page.getByRole("tablist", { name: "Pages" }).getByRole("tab").first().click();
    await rail().getByRole("link", { name: "Phone home" }).last().click();
    await waitUntil(async () => (await activeTab())?.includes("Mobile") ?? false);
    await say(`${line}, and I'd pick A.`, false);
  });

  test("in dark, the two kinds of link still read apart", async () => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(300);
    await shoot("8-links-dark");
    await rail().getByRole("link", { name: "Phone home" }).first().hover();
    await page.waitForTimeout(250);
    await shoot("9-hover-dark");
    await page.emulateMedia({ colorScheme: "light" });
  });

  test("another design's board opens that design, in the app", async () => {
    // The turn has ended, so its earlier lines fold away under "Worked for …": open them.
    const fold = rail().getByRole("button", { name: /^Worked for/ });
    if (await fold.count()) await fold.first().click();
    await rail().getByRole("link", { name: "Checkout" }).click();
    await page.locator('[data-board-name][title="Cart"]').waitFor();
    expect(await opened()).toHaveLength(2);
    expect(errors).toEqual([]);
  });
});
