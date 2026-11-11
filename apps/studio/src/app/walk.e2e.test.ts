/*
 * The whole product as a brand-new person meets it, in one go: the studio built as it ships, in
 * a real Chromium, on Ponzu Cloud in memory (fake-host.ts), with the backend playing GitHub,
 * claude.ai, the agent and a teammate. Sign in; set up where to design; connect Claude by code,
 * after one it turns away; the iPhone; Fresh start with its ideas; pick one and send; the design
 * opens waking, its agent replies, draws and asks; answer; it pushes; Create PR, Ready, the pull
 * request and a diff, Merge, and it settles; every section of Settings; a design waiting on
 * Claude connects it; switch workspace; sign out. Skips where there is no Chrome or Chromium.
 *
 * With PONZU_SHOTS set to a folder, it leaves a picture of each step there (and four in dark),
 * to look at beside the design's boards.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromiumPath, launch, type Page } from "../../scripts/visual-lib.ts";
import { buildApp, serve, waitUntil } from "./e2e-lib.ts";

setDefaultTimeout(240_000);

const SHOTS = process.env.PONZU_SHOTS;
const IDEA = "Make checkout one page, with the order summary on the right";

describe.skipIf(!chromiumPath)("a brand-new person, from sign-in to sign-out", () => {
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
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(server.url);
  });
  afterAll(async () => {
    // Where it ended, which on a failure is where it stopped.
    if (SHOTS && page) await page.screenshot({ path: join(SHOTS, "last.png") }).catch(() => {});
    await browser?.close();
    server?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  let shots = 0;
  /** A picture of the window as it stands; with `dark`, one in the dark appearance as well. */
  const shoot = async (name: string, { dark = false } = {}) => {
    if (!SHOTS) return;
    mkdirSync(SHOTS, { recursive: true });
    const n = String(++shots).padStart(2, "0");
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(SHOTS, `${n}-${name}.png`) });
    if (dark) {
      await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
      await page.waitForTimeout(350);
      await page.screenshot({ path: join(SHOTS, `${n}-${name}-dark.png`) });
      await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
      await page.waitForTimeout(150);
    }
  };
  /** Runs in the page, where `window.ponzuFake` is the backend: as GitHub, the agent, a teammate. */
  // biome-ignore lint/suspicious/noExplicitAny: what each step hands the page is its own
  const fake = <T>(run: (arg: any) => T, arg?: unknown): Promise<T> =>
    page.evaluate(run as (arg: unknown) => T, arg);
  const rail = () => page.locator("#thread");
  const action = (name: string) => page.locator("header").getByRole("button", { name });
  const nav = () => page.getByRole("navigation", { name: "Settings" });

  test("walks the whole product", async () => {
    // The sign-in gate: nothing else shows.
    await page.waitForSelector('[data-screen="sign-in"]');
    expect(await page.locator("#sidebar").count()).toBe(0);
    await shoot("sign-in", { dark: true });

    // Where do you design: their own account set up on GitHub, Ready on the way back.
    await page.getByRole("button", { name: "Continue with GitHub" }).click();
    await page.getByRole("heading", { name: "Where do you design?" }).waitFor();
    await page.getByText("Ready").waitFor();
    await shoot("where-do-you-design");
    await page.getByRole("button", { name: "Set up" }).click();
    await waitUntil(() =>
      fake(() => window.ponzuFake!.opened.some((url) => url.includes("installations/new"))),
    );
    await fake(() =>
      window.ponzuFake!.link({
        kind: "github_setup",
        result: "installed",
        workspaceId: window.ponzuFake!.personalId,
      }),
    );
    await waitUntil(async () => (await page.getByText("Ready").count()) === 2);
    await shoot("where-do-you-design-ready");
    await page.getByRole("button", { name: "Continue" }).click();

    // Connect Claude by code: a wrong one first, then a new sign-in and the right one.
    await page.getByRole("heading", { name: "Connect Claude" }).waitFor();
    await shoot("connect-claude");
    await page.getByRole("button", { name: "Sign in" }).click();
    const code = page.getByLabel("Paste the code from claude.ai");
    await code.fill("wrong-code#state");
    await page.getByRole("button", { name: "Connect" }).click();
    await page.getByText("That code didn't work.").waitFor();
    await shoot("connect-claude-wrong-code");
    await page.getByRole("button", { name: "Open sign-in again" }).click();
    await waitUntil(async () => (await code.inputValue()) === "" && (await code.isEditable()));
    await code.fill("k7Hq2-Rw9xT-pL4mZ#state");
    await shoot("connect-claude-code");
    await page.getByRole("button", { name: "Connect" }).click();

    // The iPhone: nobody has Ponzu on their phone yet, so the step shows.
    await page.getByRole("heading", { name: "Get Ponzu on your iPhone" }).waitFor();
    await shoot("get-ponzu-on-your-iphone");
    await page.getByRole("button", { name: "Start designing" }).click();

    // Fresh start, in the account just set up, with the ideas made for its repo.
    await page.getByText("What do you want to design?").waitFor();
    const idea = page.getByRole("button", { name: new RegExp(IDEA.slice(0, 24)) });
    await idea.waitFor();
    await shoot("fresh-start", { dark: true });
    await idea.click();
    expect(await page.getByPlaceholder(/Describe a screen/).inputValue()).toBe(IDEA);

    // Send: the design opens straight into its thread, the message there and the agent waking,
    // never an empty design on the way.
    // Picking it put the cursor at the end of the prompt.
    await waitUntil(
      async () => (await page.evaluate(() => document.activeElement?.tagName)) === "TEXTAREA",
    );
    // Every answer takes a moment, as over a network: the design must not wait on them to show.
    await fake(() => {
      window.ponzuFake!.backend.latencyMs = 400;
    });
    await watchForAnEmptyDesign(page, IDEA);
    await page.keyboard.press("Enter");
    await rail().getByText(IDEA).waitFor();
    await rail().getByText("Waking up…").first().waitFor();
    expect(await sawAnEmptyDesign(page)).toEqual([]);
    await fake(() => {
      window.ponzuFake!.backend.latencyMs = 0;
    });
    await shoot("design-waking");
    const id = await fake((idea: string) => {
      const designs = [...window.ponzuFake!.backend.designs.values()];
      return designs.find((d) =>
        d.thread.some(({ item }) => item.kind === "message" && item.payload.text === idea),
      )!.id;
    }, IDEA);

    // The agent works: its reply streams in while it draws a board, then it asks.
    await fake((designId) => {
      const agent = window.ponzuFake!.backend.agent(designId);
      agent.work([], "Drawing Checkout");
      agent.tool("Drawing Checkout", { id: "ti_walk_work_00001" });
      agent.say("Putting the summary", { id: "ti_walk_reply_0001", streaming: true });
    }, id);
    await rail().getByText("Putting the summary").waitFor();
    await shoot("design-reply-streaming");
    await fake((designId) => {
      const world = window.ponzuFake!;
      const agent = world.backend.agent(designId);
      world.drawBoard(designId, "Checkout", "#f4f3ef");
      agent.tool("Drew Checkout", { id: "ti_walk_work_00001", streaming: false, steps: 4 });
      agent.say("Putting the summary on the right, with the total pinned as you scroll.", {
        id: "ti_walk_reply_0001",
        streaming: false,
      });
    }, id);
    await page.locator('[data-board-name][title="Checkout"]').waitFor();
    await rail().getByText("with the total pinned as you scroll").waitFor();
    const question = await fake(
      (designId) =>
        window.ponzuFake!.backend.agent(designId).ask(
          {
            kind: "question",
            payload: {
              questions: [
                {
                  header: "Payment",
                  question: "Where should payment go?",
                  options: [
                    { label: "Below the address", description: "One column, top to bottom." },
                    { label: "Beside the summary", description: "Pay where the total is." },
                  ],
                  multiSelect: false,
                },
              ],
            },
          },
          "Payment",
        ),
      id,
    );
    const asked = page.getByRole("region", { name: "Ponzu needs you: Payment" });
    await asked.getByText("Where should payment go?").waitFor();
    await shoot("design-question", { dark: true });

    // Answer it: the answer goes to the API, and the composer comes back.
    await asked.getByRole("radio", { name: /Beside the summary/ }).click();
    await asked.getByRole("button", { name: "Send" }).click();
    await waitUntil(() =>
      fake(
        ([designId, q]) =>
          window.ponzuFake!.backend.design(designId!).questions.find((x) => x.id === q)?.status ===
          "answered",
        [id, question] as const,
      ),
    );
    await rail().getByPlaceholder("Steer, or ask more").waitFor();
    await shoot("design-answered");

    // It pushes and its turn ends: Create PR, then Ready.
    await fake((designId) => {
      const agent = window.ponzuFake!.backend.agent(designId);
      agent.push([{ path: "src/checkout.tsx", additions: 64, deletions: 12 }]);
      agent.idle();
    }, id);
    await action("Create PR").waitFor();
    await shoot("design-pushed");
    await action("Create PR").click();
    await action("Ready").click();
    await rail()
      .getByText(/Pull request\s+#\d+\s+opened as a draft/)
      .waitFor();

    // The pull request tab, and a file's diff.
    await page.locator("header").getByRole("button", { name: /#\d+/ }).click();
    await page.getByRole("heading", { name: /Make checkout one page/ }).waitFor();
    await shoot("pull-request", { dark: true });
    await page.getByRole("button", { name: /src\/checkout\.tsx/ }).click();
    await page.getByText("context", { exact: true }).waitFor();
    await shoot("pull-request-diff");

    // Merge: the design settles on its own.
    await action("Merge").click();
    await page
      .getByText(/Merged/)
      .first()
      .waitFor();
    await waitUntil(() =>
      fake((designId) => window.ponzuFake!.backend.design(designId).settledAt !== null, id),
    );
    expect(await action("Merge").count()).toBe(0);
    await page.getByRole("tab", { name: "Page 1" }).click();
    await rail()
      .getByText(/Pull request\s+#\d+\s+merged/)
      .waitFor();
    await shoot("design-settled");

    // Settings: every section, in the personal workspace and then the team's.
    await fake(() => {
      const { backend, me, personalId } = window.ponzuFake!;
      const repo = backend.workspaces.get(personalId)!.repos[0]!;
      backend.settings.setBase(repo.id, {
        status: "ready",
        builtAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        stack: [
          { slug: "nodedotjs", label: "Node 22" },
          { slug: "pnpm", label: "pnpm" },
          { slug: "postgresql", label: "Postgres 16" },
        ],
      });
      backend.settings.use(personalId, me.id, 340);
    });
    await page.keyboard.press("Meta+,");
    await nav().waitFor();
    await page.getByText("Signed in with").waitFor();
    await shoot("settings-account");
    await page.getByRole("button", { name: "Delete" }).click();
    await page.getByLabel("Type maya to confirm").fill("maya");
    await page.getByRole("button", { name: "Delete account" }).click();
    // The only admin of a team others are in can't leave it without one.
    await page.getByText("You're the only admin of Northbrook").waitFor();
    await shoot("settings-account-delete-blocked");
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("alertdialog").waitFor({ state: "detached" });

    await nav().getByRole("button", { name: "Agents" }).click();
    await page.getByText("Defaults for new designs").waitFor();
    await shoot("settings-agents");

    await nav().getByRole("button", { name: "Notifications" }).click();
    await page.getByText("Ping me when").waitFor();
    await shoot("settings-notifications");
    const needsYou = page.getByRole("switch", { name: "Ponzu needs you" });
    await needsYou.click();
    await waitUntil(() =>
      fake(
        () =>
          window.ponzuFake!.backend.settings.prefs.get(window.ponzuFake!.me.id)?.needsYou === false,
      ),
    );
    // No iPhone yet: the row leads to getting one.
    await page.getByRole("button", { name: "Get Ponzu on your iPhone" }).click();
    await page.getByText("Scan with your iPhone").waitFor();
    await shoot("settings-notifications-get-iphone");
    await page.getByRole("button", { name: "Done" }).click();
    await page.getByText("Scan with your iPhone").waitFor({ state: "detached" });

    await nav().getByRole("button", { name: "Plan and usage" }).click();
    await page
      .getByText(/credits/)
      .first()
      .waitFor();
    await shoot("settings-plan", { dark: true });
    await page.getByRole("button", { name: "Change cap" }).click();
    const cap = page.getByLabel("Monthly cap in dollars");
    await cap.fill("250");
    await cap.press("Enter");
    await waitUntil(() =>
      fake(() => window.ponzuFake!.backend.settings.caps.get(window.ponzuFake!.personalId) === 250),
    );
    await page.getByText("$250").first().waitFor();

    await nav().getByRole("button", { name: "GitHub", exact: true }).click();
    await page.getByText("Repositories Ponzu can open").waitFor();
    await shoot("settings-github");

    await nav().getByRole("button", { name: "Environments" }).click();
    await page.getByRole("button", { name: /kettle/ }).click();
    await page.getByText("Node 22").waitFor();
    await page.getByRole("button", { name: "Add" }).click();
    await page.getByLabel("Name", { exact: true }).fill("stripe key");
    await page.getByLabel("Value", { exact: true }).fill("sk_test_e2e");
    await page.getByLabel("Value", { exact: true }).press("Enter");
    await page.getByText("STRIPE_KEY").waitFor();
    await page.getByText("a changed secret reaches it at its next start").waitFor();
    await shoot("settings-environments");
    // A value is written, never read back.
    expect(await page.getByText("sk_test_e2e").count()).toBe(0);
    await page.getByRole("button", { name: "Rebuild" }).click();
    await page.getByText("Rebuilds at the next start").waitFor();

    // The team's sections, through Settings' own switcher.
    await nav().getByRole("button", { name: "Workspace: Personal" }).click();
    await page.getByRole("menuitemradio", { name: "Northbrook" }).click();
    await page.getByRole("menu").waitFor({ state: "detached" });
    await nav().getByRole("button", { name: "Members" }).click();
    await page.getByText("Everyone with access to its repos is in Northbrook").waitFor();
    await shoot("settings-members");
    await nav().getByRole("button", { name: "Plan and usage" }).click();
    await page.getByText("By person · only admins see this").waitFor();
    await shoot("settings-plan-team");
    await page.keyboard.press("Escape");
    await nav().waitFor({ state: "detached" });

    // Switch workspace: the team's designs.
    await page.getByRole("button", { name: "Workspace: Personal" }).click();
    await page.getByRole("menuitemradio", { name: "Northbrook" }).click();
    const onboarding = page.getByRole("button", { name: /Onboarding flow/ });
    await onboarding.waitFor();
    await shoot("team-workspace");

    // A design waiting on Maya's own Claude: Connect, from its composer, and it wakes.
    await fake(() => {
      const { backend } = window.ponzuFake!;
      const design = [...backend.designs.values()].find(
        (d) => d.sequencer.doc.name === "Onboarding flow",
      )!;
      backend.agent(design.id).block("claude_expired");
    });
    await onboarding.click();
    await rail().getByText("Your Claude sign-in has run out. This design waits.").waitFor();
    await shoot("design-waits-on-claude");
    await rail().getByRole("button", { name: "Connect" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Add key" }).click();
    await dialog.getByLabel("Paste your Anthropic API key").fill("sk-ant-api03-walk-4f2a");
    await shoot("design-connect-claude");
    await dialog.getByRole("button", { name: "Connect" }).click();
    await dialog.waitFor({ state: "detached" });
    await rail().getByPlaceholder("Steer, or ask more").waitFor();
    expect(
      await rail().getByText("Your Claude sign-in has run out. This design waits.").count(),
    ).toBe(0);

    // The team menu: Plan and usage, then sign out.
    await page.getByRole("button", { name: "Workspace: Northbrook" }).click();
    await page.getByRole("menuitem", { name: "Plan and usage" }).click();
    await nav().getByRole("button", { name: "Plan and usage" }).waitFor();
    expect(
      await nav().getByRole("button", { name: "Plan and usage" }).getAttribute("aria-current"),
    ).toBe("page");
    await page.keyboard.press("Escape");
    await nav().waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Workspace: Northbrook" }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await page.waitForSelector('[data-screen="sign-in"]');
    expect(await page.locator("#sidebar").count()).toBe(0);
    await shoot("signed-out");
    expect(errors).toEqual([]);
  });
});

/**
 * Watches every frame from now for the open design showing nothing of itself: past the create
 * page, a canvas pane or a thread rail without the first message in it.
 */
async function watchForAnEmptyDesign(page: Page, message: string) {
  await page.evaluate((text) => {
    const seen: string[] = [];
    (window as unknown as { emptyDesign: string[] }).emptyDesign = seen;
    const started = performance.now();
    const look = () => {
      const creating = document.body.textContent?.includes("What do you want to design?");
      const thread = document.querySelector("#thread");
      if (!creating) {
        const said = thread?.textContent?.includes(text);
        if (!said) seen.push(thread ? "a thread without the message" : "no thread");
      }
      if (performance.now() - started < 4000) requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  }, message);
}

async function sawAnEmptyDesign(page: Page): Promise<string[]> {
  await page.waitForTimeout(100);
  return page.evaluate(() => [
    ...new Set((window as unknown as { emptyDesign: string[] }).emptyDesign),
  ]);
}
