/*
 * The studio as it ships, built and in a real Chromium, on Ponzu Cloud in memory
 * (fake-host.ts): a whole first run (the sign-in gate, setting up where to design, connecting
 * Claude by code, the iPhone, Fresh start with ideas, the first design), Settings, the sidebar
 * on live data, making a design, the canvas drawing what its agent commits, and a comment there
 * and back. Skips where there is no Chrome or Chromium.
 *
 * With PONZU_SHOTS set to a folder, it leaves a picture of each first-run step and each
 * Settings section there, to look at beside the design's boards.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  type Browser,
  chromiumPath,
  launch,
  type Page,
  sampleToggle,
} from "../../scripts/visual-lib.ts";
import { nameFor } from "./create.tsx";
import { buildApp, serve, waitUntil } from "./e2e-lib.ts";
import { KETTLE_IDEAS } from "./fake-host.ts";

setDefaultTimeout(60_000);

const PROMPT = "A pricing page with three plans";
/** What the design made from it is called until its agent names it. */
const NAME = nameFor(PROMPT);
const SHOTS = process.env.PONZU_SHOTS;

/**
 * Where a guided step's shared parts sit: each one's top and the line it is centred on, the
 * same on every step to the pixel (their words, and so their widths, differ).
 */
async function stepFrame(page: Page) {
  const box = async (selector: string) => {
    const found = await page.locator(selector).first().boundingBox();
    return found && { top: found.y, centre: found.x + found.width / 2 };
  };
  return {
    progress: await box('[role="progressbar"]'),
    title: await box("h1"),
    body: await box("h1 + p"),
  };
}

describe.skipIf(!chromiumPath)("the studio, built, on Ponzu Cloud in memory", () => {
  let dir: string;
  let server: ReturnType<typeof serve>;
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];

  beforeAll(async () => {
    dir = await buildApp("e2e");
    server = serve(dir);
    browser = await launch();
    page = await browser.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(server.url);
  });
  afterAll(async () => {
    await browser?.close();
    server?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** The design the test made, as the in-memory API holds it. */
  const made = () =>
    page.evaluate((name) => {
      const designs = [...window.ponzuFake!.backend.designs.values()];
      const design = designs.find((d) => d.sequencer.doc.name === name)!;
      return {
        id: design.id,
        said: design.thread.flatMap(({ item }) =>
          item.kind === "message" ? [item.payload.text] : [],
        ),
        threads: design.sequencer.doc.threads.map((t) => ({
          id: t.id,
          texts: t.messages.map((m) => m.text),
        })),
      };
    }, NAME);

  const shoot = async (name: string) => {
    if (!SHOTS) return;
    mkdirSync(SHOTS, { recursive: true });
    // Past what is still easing in.
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  };
  const frames: Awaited<ReturnType<typeof stepFrame>>[] = [];

  test("a sign-in outlives the window coming forward; the button waits a moment, then is ready", async () => {
    // Signed out, the built app opens on the sign-in screen (app.test.tsx: and nothing else).
    await page.waitForSelector('[data-screen="sign-in"]');
    await shoot("1-sign-in");
    const button = page.getByRole("button", { name: "Continue with GitHub" });
    const busy = () => button.getAttribute("aria-busy");
    await page.evaluate(() => window.ponzuFake!.holdSignIn());
    const pressed = Date.now();
    await button.click();
    expect(await busy()).toBe("true");
    await shoot("1-sign-in-waiting");
    // No Cancel any more, and a press while it waits starts nothing.
    expect(await page.getByRole("button", { name: "Cancel" }).count()).toBe(0);
    await button.click({ force: true });
    expect(await page.evaluate(() => window.ponzuFake!.signInsStarted)).toBe(1);

    // Back in the window while the browser is still out: past the old 1.5 s grace, nothing ends.
    await page.evaluate(() => {
      window.dispatchEvent(new Event("blur"));
      window.dispatchEvent(new Event("focus"));
    });
    await page.waitForTimeout(2_000);
    expect(await busy()).toBe("true");
    // The attempt is still out in the browser: nothing the window did ended it.
    expect(await page.evaluate(() => window.ponzuFake!.signInsEnded)).toBe(0);
    await waitUntil(async () => (await busy()) === null);
    expect(Date.now() - pressed).toBeGreaterThanOrEqual(3_900);
    await shoot("1-sign-in-ready-again");

    // A second press starts another attempt beside the first; the first tab back signs in.
    await button.click();
    expect(await page.evaluate(() => window.ponzuFake!.signInsStarted)).toBe(2);
    expect(await page.evaluate(() => window.ponzuFake!.signInsEnded)).toBe(0);
    await page.evaluate(() => window.ponzuFake!.finishSignIn());
    // Both held attempts finish and the person is in: first run asks where they design.
    await page.getByRole("heading", { name: "Where do you design?" }).waitFor();
    expect(await page.evaluate(() => window.ponzuFake!.signInsEnded)).toBe(2);
    expect(errors).toEqual([]);
  });

  test("first run: where they design, set up on GitHub and Ready on the way back", async () => {
    await page.getByRole("heading", { name: "Where do you design?" }).waitFor();
    // The team's account is set up already; their own is not.
    await page.getByText("Ready").waitFor();
    await shoot("2-where-do-you-design");
    frames.push(await stepFrame(page));

    await page.getByRole("button", { name: "Set up" }).click();
    await waitUntil(async () =>
      Boolean(
        await page.evaluate(() =>
          window.ponzuFake!.opened.some((url) => url.includes("installations/new")),
        ),
      ),
    );
    // Back from GitHub's install page: the shell hands the app its link.
    await page.evaluate(() =>
      window.ponzuFake!.link({
        kind: "github_setup",
        result: "installed",
        workspaceId: window.ponzuFake!.personalId,
      }),
    );
    await waitUntil(async () => (await page.getByText("Ready").count()) === 2);
    expect(await page.getByRole("button", { name: "Set up" }).count()).toBe(0);
    await page.getByRole("button", { name: "Continue" }).click();
  });

  test("first run: Claude connected by code, after one it turned away", async () => {
    await page.getByRole("heading", { name: "Connect Claude" }).waitFor();
    await shoot("3-connect-claude");
    frames.push(await stepFrame(page));

    await page.getByRole("button", { name: "Sign in" }).click();
    const field = page.getByLabel("Paste the code from claude.ai");
    await field.waitFor();
    expect(await page.evaluate(() => window.ponzuFake!.opened.at(-1))).toContain("claude.ai");
    frames.push(await stepFrame(page));
    await field.fill("wrong-code#state");
    await shoot("3b-paste-the-code");
    await page.getByRole("button", { name: "Connect" }).click();
    await page.getByText("That code didn't work.").waitFor();
    await shoot("3b-paste-the-code-wrong");
    // The sign-in is spent: Connect waits for a new one.
    expect(await page.getByRole("button", { name: "Connect" }).isDisabled()).toBe(true);

    // Starting a sign-in takes the API a while (it wakes a sandbox for each): the link waits,
    // and pressing it again starts nothing more.
    const tabs = () => page.evaluate(() => window.ponzuFake!.opened.length);
    const before = await tabs();
    // Held until the second press is in, so it lands while the first start is out.
    await page.evaluate(() => window.ponzuFake!.backend.claude.holdStarts());
    const reopen = page.getByRole("button", { name: "Open sign-in again" });
    await reopen.click();
    await waitUntil(async () => (await reopen.getAttribute("aria-busy")) === "true");
    expect(await reopen.isDisabled()).toBe(true);
    await shoot("3c-open-sign-in-again-waiting");
    await reopen.click({ force: true });
    await page.evaluate(() => window.ponzuFake!.backend.claude.releaseStarts());
    await waitUntil(async () => (await reopen.getAttribute("aria-busy")) === null);
    expect((await tabs()) - before).toBe(1);
    await waitUntil(async () => (await field.inputValue()) === "");
    await field.fill("k7Hq2-Rw9xT-pL4mZ#state");
    await page.getByRole("button", { name: "Connect" }).click();
  });

  test("first run: the iPhone, then Fresh start in the account just set up, with its ideas", async () => {
    await page.getByRole("heading", { name: "Get Ponzu on your iPhone" }).waitFor();
    await shoot("4-get-ponzu-on-your-iphone");
    frames.push(await stepFrame(page));
    // Moving between the steps moves nothing they share.
    for (const frame of frames.slice(1)) expect(frame).toEqual(frames[0]!);

    await page.getByRole("button", { name: "Start designing" }).click();
    await page.getByText("What do you want to design?").waitFor();
    // A brand-new personal workspace hides the sidebar only when it is all the person has:
    // with the team Ready, the switcher is how they reach it.
    await page.getByRole("button", { name: "Workspace: Personal" }).waitFor();
    expect(await page.getByRole("button", { name: "Project: maya/kettle" }).count()).toBe(1);
    // Its ideas take turns as the composer's placeholder: Tab takes the one showing.
    await page.locator("[data-suggestion]").waitFor();
    await shoot("5-fresh-start");
    const field = page.getByPlaceholder(/Describe a screen/);
    await field.press("Tab");
    expect(KETTLE_IDEAS).toContain(await field.inputValue());
  });

  test("Fresh start makes one design however often send is pressed, and opens it", async () => {
    await page.getByPlaceholder(/Describe a screen/).fill("A quieter checkout");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.locator("#sidebar").waitFor();
    await page.getByRole("button", { name: /Quieter checkout/ }).waitFor();
    const made = await page.evaluate(() =>
      [...window.ponzuFake!.backend.designs.values()]
        .filter((d) => d.sequencer.doc.name === "Quieter checkout")
        .map((d) => ({
          workspaceId: d.workspaceId,
          model: d.model,
          effort: d.effort,
          said: d.thread.flatMap(({ item }) =>
            item.kind === "message" ? [item.payload.text] : [],
          ),
        })),
    );
    const personalId = await page.evaluate(() => window.ponzuFake!.personalId);
    expect(made).toEqual([
      {
        workspaceId: personalId,
        model: "claude-opus-5-5",
        effort: "medium",
        said: ["A quieter checkout"],
      },
    ]);
  });

  test("Settings opens with ⌘, on every section", async () => {
    await page.keyboard.press("Meta+,");
    const nav = page.getByRole("navigation", { name: "Settings" });
    await nav.waitFor();
    const sections = async () =>
      (await nav.locator("button:not([aria-label^='Workspace'])").allTextContents()).map((t) =>
        t.trim(),
      );
    // A personal workspace has nobody else in it, so no Members.
    expect(await sections()).toEqual([
      "Account",
      "Agents",
      "Notifications",
      "Plan and usage",
      "GitHub",
      "Environments",
    ]);
    await page.getByText("Signed in with").waitFor();
    await shoot("settings-account");
    await nav.getByRole("button", { name: "Agents" }).click();
    await page.getByText("Defaults for new designs").waitFor();
    await shoot("settings-agents");

    // Switching ways, pressed anywhere along the row: a key first, then back to a subscription,
    // whose sign-in is let go of when Settings closes with it unfinished.
    await page.getByText("Use an API key instead").click();
    await page.getByLabel("Paste your Anthropic API key").fill("sk-ant-api03-e2e-4f2a");
    await page.getByRole("button", { name: "Connect" }).click();
    await page.getByText("Use a Claude subscription instead").click();
    await page.getByLabel("Paste the code from claude.ai").waitFor();
    const openSignIns = () =>
      page.evaluate(() => window.ponzuFake!.backend.claude.openSignIns(window.ponzuFake!.me.id));
    expect(await openSignIns()).toBe(1);
    await page.keyboard.press("Escape");
    await nav.waitFor({ state: "detached" });
    await waitUntil(async () => (await openSignIns()) === 0);
    await page.keyboard.press("Meta+,");
    await nav.getByRole("button", { name: "Agents" }).click();
    await page.getByText("Use a Claude subscription instead").waitFor();

    // Settings' own switcher changes only its workspace's sections.
    await nav.getByRole("button", { name: "Workspace: Personal" }).click();
    await page.getByRole("menuitemradio", { name: "Northbrook" }).click();
    // The rest of the window is hidden from the accessibility tree while the menu is open.
    await page.getByRole("menu").waitFor({ state: "detached" });
    await nav.getByRole("button", { name: "Members" }).waitFor();
    expect(await sections()).toEqual([
      "Account",
      "Agents",
      "Notifications",
      "Members",
      "Plan and usage",
      "GitHub",
      "Environments",
    ]);
    for (const [section, shows, name] of [
      ["Members", "Everyone with access to its repos is in Northbrook", "settings-members"],
      ["GitHub", "Repositories Ponzu can open", "settings-github"],
    ] as const) {
      await nav.getByRole("button", { name: section, exact: true }).click();
      await page.getByText(shows).waitFor();
      await shoot(name);
    }
    await page.keyboard.press("Escape");
    await nav.waitFor({ state: "detached" });
  });

  test("the team menu switches to the team's workspace, where the sidebar lists its designs", async () => {
    await page.getByRole("button", { name: "Workspace: Personal" }).click();
    await page.getByRole("menuitemradio", { name: "Northbrook" }).click();
    await page.getByRole("button", { name: /Onboarding flow/ }).waitFor();
    expect(await page.locator("#sidebar").textContent()).toContain("Northbrook");
    // The create page fills the canvas pane until a design is opened.
    await page.getByText("What do you want to design?").waitFor();
  });

  test("the create page's picker groups both workspaces; the other's repo or Scratch switches the window there in one step", async () => {
    const selector = page.locator("[data-project-selector]");
    await selector.click();
    const options = page.getByRole("option");
    // Northbrook's group first, then Personal's, each its Scratch and its repos by full name.
    await waitUntil(async () => (await options.count()) === 5);
    // Each group is named by its heading, which is not an option.
    expect(await options.allTextContents()).toEqual([
      "Scratch",
      "north-brook/ponzu",
      "north-brook/site",
      "Scratch",
      "maya/kettle",
    ]);
    for (const [name, rows] of [
      ["Northbrook", ["Scratch", "north-brook/ponzu", "north-brook/site"]],
      ["Personal", ["Scratch", "maya/kettle"]],
    ] as const) {
      const group = page.getByRole("group", { name, exact: true });
      expect(await group.getByRole("option").allTextContents()).toEqual([...rows]);
    }
    await page.keyboard.press("Escape");
    const field = page.getByPlaceholder(/Describe a screen/);
    // Every name the selector shows from here on: no other project on the way to the one chosen.
    const watchSelector = () =>
      page.evaluate(() => {
        const seen: string[] = [];
        (window as { selectorSaid?: string[] }).selectorSaid = seen;
        const note = () => {
          const label = document
            .querySelector("[data-project-selector]")
            ?.getAttribute("aria-label");
          if (label && seen.at(-1) !== label) seen.push(label);
        };
        note();
        new MutationObserver(note).observe(document.body, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ["aria-label"],
        });
      });
    const selectorSaid = () =>
      page.evaluate(() => (window as { selectorSaid?: string[] }).selectorSaid);

    await field.fill("A kettle that whistles");
    await watchSelector();
    await selector.click();
    await page.getByRole("option", { name: "maya/kettle" }).click();
    await page.getByRole("button", { name: "Workspace: Personal" }).waitFor();
    await page.getByRole("button", { name: "Project: maya/kettle" }).waitFor();
    expect(await field.inputValue()).toBe("A kettle that whistles");
    // The create page, not the design last open there.
    await page.getByText("What do you want to design?").waitFor();
    expect((await selectorSaid())?.slice(1)).toEqual(["Project: maya/kettle"]);

    // Back to the team, and from there Personal's Scratch: the window switches with Scratch
    // chosen, never showing a repo or Northbrook's choice on the way.
    await page.getByRole("button", { name: "Workspace: Personal" }).click();
    await page.getByRole("menuitemradio", { name: "Northbrook" }).click();
    await page.getByRole("button", { name: "Project: north-brook/ponzu" }).waitFor();
    await field.fill("A kettle in the dark");
    await watchSelector();
    await selector.click();
    await page
      .getByRole("group", { name: "Personal" })
      .getByRole("option", { name: "Scratch" })
      .click();
    await page.getByRole("button", { name: "Workspace: Personal" }).waitFor();
    await page.getByRole("button", { name: "Project: Scratch in Personal" }).waitFor();
    expect(await selector.textContent()).toBe("Scratch");
    expect(await field.inputValue()).toBe("A kettle in the dark");
    await page.getByText("What do you want to design?").waitFor();
    expect((await selectorSaid())?.slice(1)).toEqual(["Project: Scratch in Personal"]);

    // Back to the team for what follows.
    await page.getByRole("button", { name: "Workspace: Personal" }).click();
    await page.getByRole("menuitemradio", { name: "Northbrook" }).click();
    await page.getByRole("button", { name: "Project: north-brook/ponzu" }).waitFor();
  });

  test("a design made on the create page opens, and the canvas draws what its agent commits", async () => {
    await page.getByPlaceholder(/Describe a screen/).fill(PROMPT);
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: new RegExp(NAME) }).waitFor();
    const design = await made();
    // The first message went to the agent.
    expect(design.said).toEqual([PROMPT]);

    await page.evaluate((id) => window.ponzuFake!.drawBoard(id, "Three plans"), design.id);
    await page.locator('[data-board-name][title="Three plans"]').waitFor();
    expect(await page.locator("[data-artboard-host]").count()).toBe(1);
    // The thread came with the design rather than being opened: the caret isn't put there.
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => !!document.activeElement?.closest("#thread"))).toBe(false);
  });

  test("a pane opening or closing slides over still boards, on either side, every frame", async () => {
    await page.mouse.move(700, 500);
    for (const pane of ["sidebar", "thread", "thread", "sidebar"]) {
      const { frames, clocks } = await sampleToggle(page, `button[aria-controls="${pane}"]`);
      const edge = pane === "sidebar" ? "left" : "right";
      // It eased, rather than jumped: the pane and the canvas's edge each on the panes' clock…
      const eased = (target: string) =>
        clocks.filter((c) => c.target === target && c.duration > 0).map((c) => c.duration);
      expect(eased(`#${pane}-pane`)).toHaveLength(1);
      const ms = eased(`#${pane}-pane`)[0]!;
      expect(eased("main").length).toBeGreaterThan(0);
      expect(new Set([...eased(`#${pane}-pane`), ...eased("main")])).toEqual(new Set([ms]));
      expect(frames.at(-1)![edge]).not.toBe(frames[0]![edge]);
      // …and the board stayed where it was on screen in every frame painted (however many a
      // busy machine paints): no swim, no refit.
      for (const f of frames) {
        expect(Math.abs(f.boardX - frames[0]!.boardX)).toBeLessThanOrEqual(1);
        expect(f.boardY).toBe(frames[0]!.boardY);
      }
    }
    if (!SHOTS) return;
    // A frame sequence of each, slowed down to be seen.
    mkdirSync(SHOTS, { recursive: true });
    await page.evaluate(() => document.documentElement.style.setProperty("--dur-pane", "1600ms"));
    for (const pane of ["sidebar", "sidebar", "thread", "thread"]) {
      const was = await page.getAttribute(`button[aria-controls="${pane}"]`, "aria-expanded");
      await page.click(`button[aria-controls="${pane}"]`);
      await page.mouse.move(700, 500);
      for (let i = 0; i < 6; i++) {
        const name = `motion-${pane}-${was === "true" ? "closing" : "opening"}-${i}.png`;
        await page.screenshot({ path: join(SHOTS, name) });
        await page.waitForTimeout(280);
      }
    }
    await page.evaluate(() => document.documentElement.style.removeProperty("--dur-pane"));
  });

  test("a comment left on the canvas reaches the design, and a teammate's reply comes back", async () => {
    // The thread opened last, with the caret in its composer: back to the canvas's keys first.
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe(
      "Message",
    );
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("c");
    // Into the board, below its title.
    const title = (await page.locator('[data-board-name][title="Three plans"]').boundingBox())!;
    await page.mouse.click(title.x + 120, title.y + 120);
    await page.getByPlaceholder("Leave a comment…").fill("Make the middle plan stand out");
    await page.keyboard.press("Enter");

    await waitUntil(async () => (await made()).threads.length === 1);
    const [thread] = (await made()).threads;
    expect(thread!.texts).toEqual(["Make the middle plan stand out"]);

    const { id } = await made();
    await page.evaluate(
      ([designId, threadId]) => window.ponzuFake!.reply(designId!, threadId!, "On it"),
      [id, thread!.id],
    );
    await page.locator('button[title="Drag to move"]', { hasText: "2" }).waitFor();
    // The comment and the reply reached the thread too, each with its board above it.
    const frames = rail().getByRole("button", { name: "Open the comment on Three plans" });
    await waitUntil(async () => (await frames.count()) === 2);
  });

  /** The thread rail. */
  const rail = () => page.locator("#thread");

  test("a message, a reply that streams while the agent draws, a question, and a merge", async () => {
    const { id } = await made();
    await page.keyboard.press("Escape");
    const field = rail().getByPlaceholder("Steer, or ask more");
    await field.fill("Add a yearly toggle");
    await field.press("Enter");
    // The bubble is there at once, and the message reached the design's feed.
    await rail().getByText("Add a yearly toggle").waitFor();
    await waitUntil(async () => (await made()).said.includes("Add a yearly toggle"));

    // The agent works: the working line, then its reply streaming in, and a board drawn.
    await page.evaluate((designId) => {
      const agent = window.ponzuFake!.backend.agent(designId);
      agent.work([], "Drawing Yearly toggle");
      agent.tool("Drawing Yearly toggle", { id: "ti_work0000000001" });
    }, id);
    await rail().getByRole("status").getByText("Drawing Yearly toggle").waitFor();
    await rail().getByRole("button", { name: "Stop" }).waitFor();
    await page.evaluate((designId) => {
      const world = window.ponzuFake!;
      const agent = world.backend.agent(designId);
      agent.tool("Drew Yearly toggle", { id: "ti_work0000000001", streaming: false, steps: 3 });
      agent.say("Adding a toggle", { id: "ti_reply000000001", streaming: true });
      world.drawBoard(designId, "Yearly toggle", "#e8efe4");
    }, id);
    await rail().getByText("Adding a toggle").waitFor();
    await page.locator('[data-board-name][title="Yearly toggle"]').waitFor();
    await page.evaluate((designId) => {
      window
        .ponzuFake!.backend.agent(designId)
        .say("Adding a toggle above the plans. Yearly saves 20%.", {
          id: "ti_reply000000001",
          streaming: false,
        });
    }, id);
    await rail().getByText("Yearly saves 20%").waitFor();
    // While the turn runs its work has no line of its own; the working line goes on.
    await rail().getByRole("status").getByText("Drawing Yearly toggle").waitFor();
    expect(await rail().getByText("Drew Yearly toggle").count()).toBe(0);

    // It asks; the question takes the composer's place, and the answer goes to the API.
    const question = await page.evaluate(
      (designId) =>
        window.ponzuFake!.backend.agent(designId).ask(
          {
            kind: "question",
            payload: {
              questions: [
                {
                  header: "Default",
                  question: "Which should the toggle show first?",
                  options: [
                    { label: "Monthly", description: "As the page does today." },
                    { label: "Yearly", description: "Leads with the saving." },
                  ],
                  multiSelect: false,
                },
              ],
            },
          },
          "Default",
        ),
      id,
    );
    const asked = page.getByRole("region", { name: "Ponzu needs you: Default" });
    await asked.getByText("Which should the toggle show first?").waitFor();
    expect(await rail().getByPlaceholder("Steer, or ask more").count()).toBe(0);
    // Waiting in the composer's place, it isn't also a line in the thread.
    expect(await rail().getByText("Asked:").count()).toBe(0);
    await asked.getByRole("radio", { name: /Yearly/ }).click();
    await asked.getByRole("button", { name: "Send" }).click();
    await waitUntil(() =>
      page.evaluate(
        ([designId, q]) =>
          window.ponzuFake!.backend.design(designId!).questions.find((x) => x.id === q)?.status ===
          "answered",
        [id, question],
      ),
    );
    await rail().getByPlaceholder("Steer, or ask more").waitFor();
    // Answered, it is part of what happened.
    await rail().getByText("Asked:").waitFor();

    // It pushes and its turn ends: Create PR, then Ready, then Merge.
    await page.evaluate((designId) => {
      const agent = window.ponzuFake!.backend.agent(designId);
      agent.push([{ path: "src/pricing.tsx", additions: 42, deletions: 3 }]);
      agent.idle();
    }, id);
    const action = (name: string) => page.locator("header").getByRole("button", { name });
    await action("Create PR").click();
    await action("Ready").click();
    await rail()
      .getByText(/Pull request\s+#\d+\s+opened as a draft/)
      .waitFor();

    // Where the canvas was left: zoomed in, a board chosen; and a draft in the composer.
    const zoomShown = () => page.getByRole("button", { name: "Zoom to fit" }).textContent();
    const before = await zoomShown();
    await page.getByRole("button", { name: "Zoom in" }).click();
    await waitUntil(async () => (await zoomShown()) !== before);
    const zoom = await zoomShown();
    await page.locator('[data-board-name][title="Yearly toggle"]').click();
    const draft = rail().getByPlaceholder("Steer, or ask more");
    await draft.fill("Half typed");
    const railBox = await rail().boundingBox();

    // The pull request tab takes the canvas's pane, with the file's diff on demand, and leaves
    // the thread as it was beside it.
    await page.locator("header").getByRole("button", { name: /#\d+/ }).click();
    await page.getByRole("heading", { name: NAME }).waitFor();
    expect(await rail().boundingBox()).toEqual(railBox);
    expect(await draft.inputValue()).toBe("Half typed");
    // Keys go to what shows: Delete doesn't reach the chosen board under the tab.
    await page.getByRole("heading", { name: NAME }).click();
    await page.keyboard.press("Backspace");
    // ⌘Z has nothing to undo on the tab: it neither undoes on the canvas underneath nor reaches
    // into the thread to take back the draft.
    await page.keyboard.press("Meta+z");
    expect(await draft.inputValue()).toBe("Half typed");
    // ⌥⌘B closes and opens the thread on this tab as on any other, and the draft survives.
    const threadShown = () =>
      page.locator('button[aria-controls="thread"]').getAttribute("aria-expanded");
    await page.keyboard.press("Meta+Alt+b");
    await waitUntil(async () => (await threadShown()) === "false");
    expect(await page.getByRole("heading", { name: NAME }).count()).toBe(1);
    await page.keyboard.press("Meta+Alt+b");
    await waitUntil(async () => (await threadShown()) === "true");
    await rail().getByPlaceholder("Steer, or ask more").waitFor();
    expect(await rail().getByPlaceholder("Steer, or ask more").inputValue()).toBe("Half typed");
    await rail().getByPlaceholder("Steer, or ask more").fill("");
    // Its one file starts open.
    const card = page.getByRole("button", { name: /src\/pricing\.tsx/ });
    expect(await card.getAttribute("aria-expanded")).toBe("true");
    await page.getByText("src/pricing.tsx", { exact: false }).first().waitFor();
    // The agent pushes again while the file is open: the diff shown is the new head's.
    await page.evaluate((designId) => {
      const agent = window.ponzuFake!.backend.agent(designId);
      agent.push([
        { path: "src/pricing.tsx", patch: "@@ -1 +1,2 @@\n context\n+const yearly = true;" },
      ]);
      agent.tool("Pushed the toggle", { streaming: false });
    }, id);
    await page.getByText("const yearly = true;").waitFor();

    await action("Merge").click();
    await page
      .getByText(/Merged/)
      .first()
      .waitFor();
    await waitUntil(() =>
      page.evaluate(
        (designId) => window.ponzuFake!.backend.design(designId).settledAt !== null,
        id,
      ),
    );
    // Merged: no button, and the design settled on its own.
    expect(await action("Merge").count()).toBe(0);
    await page.getByRole("tab", { name: "Page 1" }).click();
    await rail()
      .getByText(/Pull request\s+#\d+\s+merged/)
      .waitFor();
    // The canvas is back as it was left: the same zoom, and the chosen board still there.
    expect(await zoomShown()).toBe(zoom);
    expect(await page.locator('[data-board-name][title="Yearly toggle"]').count()).toBe(1);
  });

  test("a design deleted while it's open says so calmly, and leads back", async () => {
    const { id } = await made();
    await page.evaluate(async (designId) => {
      const world = window.ponzuFake!;
      await world.backend.connect(world.me).api.designs.delete(designId);
    }, id);
    await page.getByText("This design isn't here any more").waitFor();
    await page.getByRole("button", { name: "Back to designs" }).click();
    await page.getByText("What do you want to design?").waitFor();
    expect(await page.getByRole("button", { name: new RegExp(NAME) }).count()).toBe(0);
    expect(errors).toEqual([]);
  });

  test("a team suspended on GitHub gives way to another, says why, and Settings shows it", async () => {
    await page.evaluate(() => {
      const world = window.ponzuFake!;
      world.backend.suspend(world.workspaceId);
      // Back from GitHub: the window asks GitHub again.
      world.link({ kind: "github_setup", result: "installed" });
    });
    await page.getByText("Ponzu is suspended on GitHub for Northbrook").waitFor();
    await page.getByRole("button", { name: "Workspace: Personal" }).waitFor();

    await page.keyboard.press("Meta+,");
    const nav = page.getByRole("navigation", { name: "Settings" });
    await nav.getByRole("button", { name: "Workspace: Personal" }).click();
    await page.getByRole("menuitemradio", { name: "Northbrook" }).click();
    await page.getByRole("menu").waitFor({ state: "detached" });
    await nav.getByRole("button", { name: "GitHub", exact: true }).click();
    await page.getByText("Suspended on north-brook").waitFor();
    await shoot("settings-github-suspended");
    await page.keyboard.press("Escape");
    expect(errors).toEqual([]);
  });
});

describe.skipIf(!chromiumPath)("the studio as it ships, without the desktop's bridge", () => {
  test("carries no in-memory Ponzu Cloud, and says it couldn't start", async () => {
    const dir = await buildApp("production");
    const server = serve(dir);
    const browser = await launch();
    try {
      const shipped = await Array.fromAsync(new Bun.Glob("**/*.js").scan(dir));
      for (const file of shipped) {
        expect(await Bun.file(join(dir, file)).text()).not.toContain("ponzuFake");
      }
      const page = await browser.newPage();
      await page.goto(server.url);
      await page.waitForSelector('[data-screen="cant-start"]');
      expect(await page.textContent("h1")).toBe("Ponzu couldn't start");
      expect(await page.locator('[data-screen="sign-in"]').count()).toBe(0);
    } finally {
      await browser.close();
      server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
