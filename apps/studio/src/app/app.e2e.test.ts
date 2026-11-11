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
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromiumPath, launch, type Page, STUDIO } from "../../scripts/visual-lib.ts";

setDefaultTimeout(60_000);

/**
 * Builds the app as the desktop package does, into a fresh directory. `e2e` keeps Ponzu Cloud in
 * memory in, which a production build leaves out.
 */
async function buildApp(mode: "e2e" | "production"): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "ponzu-studio-"));
  const build = Bun.spawn(["bunx", "vite", "build", "--mode", mode, "--outDir", dir], {
    cwd: STUDIO,
    // bun test sets NODE_ENV=test, which a packaging build never has.
    env: { ...process.env, NODE_ENV: undefined },
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await build.exited) !== 0) {
    throw new Error(`The studio didn't build:\n${await new Response(build.stderr).text()}`);
  }
  return dir;
}

/** Serves the built app with its routes falling back to index.html, as the desktop's scheme does. */
function serve(dir: string) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = decodeURIComponent(new URL(request.url).pathname);
      const file = Bun.file(join(dir, path));
      return path !== "/" && (await file.exists())
        ? new Response(file)
        : new Response(Bun.file(join(dir, "index.html")));
    },
  });
  return { url: `http://127.0.0.1:${server.port}/`, stop: () => server.stop(true) };
}

const PROMPT = "A pricing page with three plans";
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
    page.evaluate((prompt) => {
      const designs = [...window.ponzuFake!.backend.designs.values()];
      const design = designs.find((d) => d.sequencer.doc.name === prompt)!;
      return {
        id: design.id,
        said: design.thread.map(({ item }) => (item.kind === "message" ? item.payload.text : "")),
        threads: design.sequencer.doc.threads.map((t) => ({
          id: t.id,
          texts: t.messages.map((m) => m.text),
        })),
      };
    }, PROMPT);

  const shoot = async (name: string) => {
    if (!SHOTS) return;
    mkdirSync(SHOTS, { recursive: true });
    // Past what is still easing in.
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  };
  const frames: Awaited<ReturnType<typeof stepFrame>>[] = [];

  test("signed out, it asks to sign in, and shows nothing else", async () => {
    await page.waitForSelector('[data-screen="sign-in"]');
    expect(await page.textContent("h1")).toBe("Sign in to Ponzu");
    expect(await page.locator("#sidebar").count()).toBe(0);
    await shoot("1-sign-in");
  });

  test("first run: where they design, set up on GitHub and Ready on the way back", async () => {
    await page.getByRole("button", { name: "Continue with GitHub" }).click();
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

    await page.getByRole("button", { name: "Open sign-in again" }).click();
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
    // A brand-new personal workspace has no sidebar until its first design.
    expect(await page.locator("#sidebar").count()).toBe(0);
    expect(await page.getByRole("button", { name: "Project: kettle" }).count()).toBe(1);
    const idea = page.getByRole("button", { name: /Make checkout one page/ });
    await idea.waitFor();
    await shoot("5-fresh-start");
    await idea.click();
    expect(await page.getByPlaceholder(/Describe a screen/).inputValue()).toBe(
      "Make checkout one page, with the order summary on the right",
    );
  });

  test("Fresh start makes one design however often send is pressed, and opens it", async () => {
    await page.getByPlaceholder(/Describe a screen/).fill("A quieter checkout");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.locator("#sidebar").waitFor();
    await page.getByRole("button", { name: /A quieter checkout/ }).waitFor();
    const made = await page.evaluate(() =>
      [...window.ponzuFake!.backend.designs.values()]
        .filter((d) => d.sequencer.doc.name === "A quieter checkout")
        .map((d) => ({
          workspaceId: d.workspaceId,
          model: d.model,
          effort: d.effort,
          said: d.thread.map(({ item }) => (item.kind === "message" ? item.payload.text : "")),
        })),
    );
    const personalId = await page.evaluate(() => window.ponzuFake!.personalId);
    expect(made).toEqual([
      {
        workspaceId: personalId,
        model: "claude-opus-5-5",
        effort: "high",
        said: ["A quieter checkout"],
      },
    ]);
  });

  test("Settings opens with ⌘, on each section that has something behind it", async () => {
    await page.keyboard.press("Meta+,");
    const nav = page.getByRole("navigation", { name: "Settings" });
    await nav.waitFor();
    const sections = async () =>
      (await nav.locator("button:not([aria-label^='Workspace'])").allTextContents()).map((t) =>
        t.trim(),
      );
    // A personal workspace has nobody else in it, so no Members.
    expect(await sections()).toEqual(["Account", "Agents", "GitHub"]);
    await page.getByText("Signed in with").waitFor();
    await shoot("settings-account");
    await nav.getByRole("button", { name: "Agents" }).click();
    await page.getByText("Defaults for new designs").waitFor();
    await shoot("settings-agents");

    // Settings' own switcher changes only its workspace's sections.
    await nav.getByRole("button", { name: "Workspace: Personal" }).click();
    await page.getByRole("menuitemradio", { name: "Northbrook" }).click();
    // The rest of the window is hidden from the accessibility tree while the menu is open.
    await page.getByRole("menu").waitFor({ state: "detached" });
    await nav.getByRole("button", { name: "Members" }).waitFor();
    expect(await sections()).toEqual(["Account", "Agents", "Members", "GitHub"]);
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

  test("a design made on the create page opens, and the canvas draws what its agent commits", async () => {
    await page.getByPlaceholder(/Describe a screen/).fill(PROMPT);
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: new RegExp(PROMPT) }).waitFor();
    const design = await made();
    // The first message went to the agent.
    expect(design.said).toEqual([PROMPT]);

    await page.evaluate((id) => window.ponzuFake!.drawBoard(id, "Three plans"), design.id);
    await page.locator('[data-board-name][title="Three plans"]').waitFor();
    expect(await page.locator("[data-artboard-host]").count()).toBe(1);
  });

  test("a comment left on the canvas reaches the design, and a teammate's reply comes back", async () => {
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
    expect(await page.getByRole("button", { name: new RegExp(PROMPT) }).count()).toBe(0);
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

async function waitUntil(done: () => Promise<boolean>, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error("Gave up waiting.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
