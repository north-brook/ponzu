/*
 * The whole product past setup, in one go: the studio built as it ships, in a real Chromium, on
 * Ponzu Cloud in memory (fake-host.ts), with the backend playing GitHub, claude.ai, the agent and
 * a teammate. Fresh start with its ideas; pick one and send, and the canvas opens waking, never
 * empty; every section of Settings; a canvas waiting on Claude connects it; a teammate answers
 * first; switch workspace; sign out. The first run, and an agent's work through to a merge, are
 * app.e2e.test.ts's. Skips where there is no Chrome or Chromium.
 *
 * With PONZU_SHOTS set to a folder, it leaves a picture of each step there (and four in dark),
 * to look at beside the mockup's boards.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromiumPath, launch, type Page } from "../../scripts/visual-lib.ts";
import { buildApp, serve, waitUntil } from "./e2e-lib.ts";
import { KETTLE_IDEAS } from "./fake-host.ts";

setDefaultTimeout(240_000);

const SHOTS = process.env.PONZU_SHOTS;

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
    // Signed in past setup: the first run is app.e2e's and the slow-answer walks'.
    await page.goto(`${server.url}?as=returning`);
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
  const fake = <T>(run: (arg: any) => T, arg?: unknown): Promise<T> =>
    page.evaluate(run as (arg: unknown) => T, arg);
  const rail = () => page.locator("#thread");
  const nav = () => page.getByRole("navigation", { name: "Settings" });

  test("walks the whole product", async () => {
    // Fresh start, in their own account, with the ideas made for its repo.
    await page.getByText("Make something").waitFor();
    await page.getByRole("button", { name: "Workspace: Northbrook" }).click();
    await page.getByRole("menuitemradio", { name: "Personal" }).click();
    // They take turns as the composer's placeholder; Tab takes the one showing.
    await page.locator("[data-suggestion]").waitFor();
    await shoot("fresh-start", { dark: true });
    const field = page.getByPlaceholder(/Describe what you want to make/);
    await field.press("Tab");
    const IDEA = await field.inputValue();
    expect(KETTLE_IDEAS).toContain(IDEA);

    // Send: the canvas opens straight into its thread, the message there and the agent waking,
    // never an empty canvas on the way.
    // Picking it put the cursor at the end of the prompt.
    await waitUntil(
      async () => (await page.evaluate(() => document.activeElement?.tagName)) === "TEXTAREA",
    );
    // Every answer takes a moment, as over a network: the canvas must not wait on them to show.
    await fake(() => {
      window.ponzuFake!.backend.latencyMs = 400;
    });
    await watchForAnEmptyCanvas(page, IDEA);
    await page.keyboard.press("Enter");
    await rail().getByText(IDEA).waitFor();
    await rail().getByText("Waking up", { exact: true }).first().waitFor();
    expect(await sawAnEmptyCanvas(page)).toEqual([]);
    await fake(() => {
      window.ponzuFake!.backend.latencyMs = 0;
    });
    await shoot("canvas-waking");
    // Left alone, the thread's pane closes after its beat, having shown where the thread lives.
    await page.locator('button[aria-controls="thread"][aria-expanded="false"]').waitFor();
    // Maya opens it again, and that is remembered for the canvases she opens next.
    await page.click('button[aria-controls="thread"]');
    await page.locator('button[aria-controls="thread"][aria-expanded="true"]').waitFor();

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
    // Where the keyboard is when ⌘, opens Settings (a click on the chrome's tab took no focus).
    await page.evaluate(() => {
      (window as { focusBefore?: Element | null }).focusBefore = document.activeElement;
    });
    await page.keyboard.press("Meta+,");
    await nav().waitFor();
    await page.getByText("Signed in with").waitFor();
    await shoot("settings-account");
    await page.getByRole("button", { name: "Delete" }).click();
    // The only admin of a team others are in can't leave it without one: said at once, with
    // nothing to type.
    await page.getByText("You're the only admin of Northbrook").waitFor();
    expect(await page.getByLabel("Type maya to confirm").isDisabled()).toBe(true);
    expect(await page.getByRole("button", { name: "Delete account" }).isDisabled()).toBe(true);
    await shoot("settings-account-delete-blocked");
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("alertdialog").waitFor({ state: "detached" });

    await nav().getByRole("button", { name: "Agents" }).click();
    await page.getByText("Defaults for new canvases").waitFor();
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
    // The keyboard is back where ⌘, found it.
    await waitUntil(
      () =>
        page.evaluate(
          () => document.activeElement === (window as { focusBefore?: Element | null }).focusBefore,
        ),
      2000,
    );

    // Switch workspace: the team's canvases.
    await page.getByRole("button", { name: "Workspace: Personal" }).click();
    await page.getByRole("menuitemradio", { name: "Northbrook" }).click();
    const onboarding = page.getByRole("button", { name: /Onboarding flow/ });
    await onboarding.waitFor();
    await shoot("team-workspace");

    // A canvas waiting on Maya's own Claude: Connect, from its composer, and it wakes.
    await fake(() => {
      const { backend } = window.ponzuFake!;
      const canvas = [...backend.canvases.values()].find(
        (d) => d.sequencer.doc.name === "Onboarding flow",
      )!;
      backend.agent(canvas.id).block("claude_expired");
    });
    await onboarding.click();
    await rail().getByText("Your Claude sign-in has run out. This canvas waits.").waitFor();
    await shoot("canvas-waits-on-claude");
    await rail().getByRole("button", { name: "Connect" }).click();
    const dialog = page.getByRole("dialog");
    // Put as the strip put it, and it can be put away.
    await dialog.getByRole("heading", { name: "Your Claude sign-in ran out" }).last().waitFor();
    await dialog.getByRole("button", { name: "Cancel" }).waitFor();
    await dialog.getByRole("button", { name: "Add key" }).click();
    await dialog.getByLabel("Paste your Anthropic API key").fill("sk-ant-api03-walk-4f2a");
    await shoot("canvas-connect-claude");
    await dialog.getByRole("button", { name: "Connect" }).click();
    await dialog.waitFor({ state: "detached" });
    await rail().getByPlaceholder("Steer, or ask more").waitFor();
    expect(
      await rail().getByText("Your Claude sign-in has run out. This canvas waits.").count(),
    ).toBe(0);

    // It asks; Maya chooses, but Sam answers first: his name and his choice, not hers.
    const onboardingId = await fake(
      () =>
        [...window.ponzuFake!.backend.canvases.values()].find(
          (d) => d.sequencer.doc.name === "Onboarding flow",
        )!.id,
    );
    const tone = await fake(
      (canvasId) =>
        window.ponzuFake!.backend.agent(canvasId).ask(
          {
            kind: "question",
            payload: {
              questions: [
                {
                  header: "Tone",
                  question: "Warm or plain?",
                  options: [
                    { label: "Warm", description: "A friendly hello." },
                    { label: "Plain", description: "Just the steps." },
                  ],
                  multiSelect: false,
                },
              ],
            },
          },
          "Tone",
        ),
      onboardingId,
    );
    const toneAsk = page.getByRole("region", { name: "Ponzu needs you: Tone" });
    await toneAsk.getByRole("radio", { name: /Warm/ }).click();
    await fake(
      ([canvasId, q]) => {
        const { backend, teammate } = window.ponzuFake!;
        return backend
          .connect(teammate)
          .api.canvases.answer(canvasId!, q!, { answers: { "Warm or plain?": "Plain" } });
      },
      [onboardingId, tone] as const,
    );
    await toneAsk.getByText("Sam answered.").waitFor();
    expect(await toneAsk.getByRole("radio", { name: /Plain/ }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(await toneAsk.getByRole("radio", { name: /Warm/ }).getAttribute("aria-checked")).toBe(
      "false",
    );
    await shoot("canvas-teammate-answered", { dark: true });
    await toneAsk.getByRole("button", { name: "OK" }).click();
    await rail().getByPlaceholder("Steer, or ask more").waitFor();

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
 * Watches every frame from now for the open canvas showing nothing of itself: past the create
 * page, a main pane or a thread rail without the first message in it.
 */
async function watchForAnEmptyCanvas(page: Page, message: string) {
  await page.evaluate((text) => {
    const seen: string[] = [];
    (window as unknown as { emptyCanvas: string[] }).emptyCanvas = seen;
    const started = performance.now();
    const look = () => {
      const creating = document.body.textContent?.includes("Make something");
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

async function sawAnEmptyCanvas(page: Page): Promise<string[]> {
  await page.waitForTimeout(100);
  return page.evaluate(() => [
    ...new Set((window as unknown as { emptyCanvas: string[] }).emptyCanvas),
  ]);
}
