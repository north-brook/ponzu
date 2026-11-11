/*
 * What the window shows between the guided steps, frame by frame, with every answer from Ponzu
 * Cloud slowed as a real network is: the studio built as it ships, in a real Chromium, on the
 * API in memory (fake-host.ts). Between two steps the person sees the step they were on (its
 * action pending, perhaps) and then the next one: never an earlier step, the sign-in screen, an
 * empty window or a wait; the title and the line under it never move; and Fresh start's
 * composer stands still while the repo's ideas come in under it. A relaunch goes
 * straight to where the person belongs, holding a quiet empty window until it knows.
 * Skips where there is no Chrome or Chromium.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import { type Browser, chromiumPath, launch, type Page } from "../../../scripts/visual-lib.ts";
import { buildApp, serve, waitUntil } from "../e2e-lib.ts";

setDefaultTimeout(120_000);

/** Every answer takes this long: slow enough that any wait in between would be drawn. */
const LATENCY = 400;

type Screen = "blank" | "sign-in" | "where" | "claude" | "iphone" | "create" | string;

/**
 * Records, from the page's first frame, which screen every animation frame shows, keeping each
 * change once, and where a step's title and body sit.
 */
function record() {
  const w = window as unknown as {
    screens: string[];
    frames: { screen: string; title: number; body: number }[];
  };
  w.screens = [];
  w.frames = [];
  const STEPS: Record<string, string> = {
    "Where do you design?": "where",
    "Connect Claude": "claude",
    "Get Ponzu on your iPhone": "iphone",
  };
  const look = () => {
    let screen = "blank";
    const h1 = document.querySelector("h1");
    const title = h1?.textContent?.trim() ?? "";
    if (document.querySelector('[data-screen="sign-in"]')) screen = "sign-in";
    else if (STEPS[title]) screen = STEPS[title]!;
    else if (document.body?.textContent?.includes("What do you want to design?")) screen = "create";
    else if (document.querySelector("#sidebar")) screen = "app";
    else if (title) screen = `other: ${title}`;
    if (w.screens.at(-1) !== screen) w.screens.push(screen);
    if (h1 && STEPS[title]) {
      const body = h1.nextElementSibling;
      w.frames.push({
        screen,
        title: h1.getBoundingClientRect().top,
        body: body ? body.getBoundingClientRect().top : -1,
      });
    }
    requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
}

const screens = (page: Page) =>
  page.evaluate(() => (window as unknown as { screens: Screen[] }).screens.slice());

/** Clears what was seen so far, keeping the screen on now as the first. */
const mark = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { screens: string[] };
    w.screens = w.screens.slice(-1);
  });

/** The title's and body's places on every step frame seen, once each. */
const places = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { frames: { title: number; body: number }[] };
    return [...new Set(w.frames.map((f) => `${f.title}/${f.body}`))];
  });

describe.skipIf(!chromiumPath)("between the guided steps, with slow answers", () => {
  let dir: string;
  let server: ReturnType<typeof serve>;
  let browser: Browser;

  beforeAll(async () => {
    dir = await buildApp("e2e");
    server = serve(dir);
    browser = await launch();
  });
  afterAll(async () => {
    await browser?.close();
    server?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const open = async (query: string) => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.addInitScript(record);
    await page.goto(`${server.url}?latency=${LATENCY}${query}`);
    return { page, errors };
  };

  test("a new person sees each step, then the next, and nothing in between", async () => {
    const { page, errors } = await open("");
    await page.waitForSelector('[data-screen="sign-in"]');
    await page.getByRole("button", { name: "Continue with GitHub" }).click();
    // Signing in: the sign-in screen waits on until the first step can show.
    await page.getByRole("heading", { name: "Where do you design?" }).waitFor();
    expect(await screens(page)).toEqual(["blank", "sign-in", "where"]);

    // Where → Connect Claude.
    await page.getByRole("button", { name: "Set up" }).click();
    await waitUntil(() =>
      page.evaluate(() =>
        window.ponzuFake!.opened.some((url) => url.includes("installations/new")),
      ),
    );
    await page.evaluate(() =>
      window.ponzuFake!.link({
        kind: "github_setup",
        result: "installed",
        workspaceId: window.ponzuFake!.personalId,
      }),
    );
    await waitUntil(async () => (await page.getByText("Ready").count()) === 2);
    await mark(page);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("heading", { name: "Connect Claude" }).waitFor();
    await page.waitForTimeout(LATENCY * 4);
    expect(await screens(page)).toEqual(["where", "claude"]);

    // Connect Claude → the iPhone: the founder's flash.
    await page.getByRole("button", { name: "Sign in" }).click();
    const code = page.getByLabel("Paste the code from claude.ai");
    await code.fill("k7Hq2-Rw9xT-pL4mZ#state");
    await mark(page);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.getByRole("heading", { name: "Get Ponzu on your iPhone" }).waitFor();
    await page.waitForTimeout(LATENCY * 4);
    expect(await screens(page)).toEqual(["claude", "iphone"]);

    // The iPhone → Fresh start: the composer stands where it first appears while the repo's
    // ideas are made and rise in below it.
    await mark(page);
    await page.evaluate(() => {
      const w = window as unknown as { composer: number[] };
      w.composer = [];
      const look = () => {
        const box = document.querySelector("textarea")?.getBoundingClientRect();
        if (box) w.composer.push(box.top);
        requestAnimationFrame(look);
      };
      requestAnimationFrame(look);
    });
    await page.getByRole("button", { name: "Start designing" }).click();
    await page.getByText("What do you want to design?").waitFor();
    const idea = page.getByRole("list", { name: "Ideas" }).getByRole("button").first();
    await idea.waitFor();
    await page.waitForTimeout(LATENCY * 2);
    expect(await screens(page)).toEqual(["iphone", "create"]);
    const tops = await page.evaluate(() => [
      ...new Set((window as unknown as { composer: number[] }).composer),
    ]);
    expect(tops).toHaveLength(1);
    const picked = await idea.textContent();
    await idea.click();
    expect(await page.getByPlaceholder(/Describe a screen/).inputValue()).toBe(picked!);

    // The title and the line under it stood still on every step.
    expect(await places(page)).toHaveLength(1);
    expect(errors).toEqual([]);
    await page.close();
  });

  test("a relaunch part way through opens on that step, with a quiet window until then", async () => {
    const { page, errors } = await open("&as=claude");
    await page.getByRole("heading", { name: "Connect Claude" }).waitFor();
    await page.waitForTimeout(LATENCY * 4);
    expect(await screens(page)).toEqual(["blank", "claude"]);
    expect(errors).toEqual([]);
    await page.close();
  });

  test("a relaunch past setup opens the app, never a step on the way", async () => {
    const { page, errors } = await open("&as=returning");
    await page.getByText("What do you want to design?").waitFor();
    await page.waitForTimeout(LATENCY * 4);
    expect(await screens(page)).toEqual(["blank", "create"]);
    expect(errors).toEqual([]);
    await page.close();
  });
});
