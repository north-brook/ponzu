/*
 * The billing wall, walked (the billing plan, §8 and §13): the studio built as it ships, in a
 * real Chromium, on Ponzu Cloud in memory (fake-host.ts) with billing switched on. The month's
 * free credits are used up; a prompt sent from the create page meets 402 `billing_required`;
 * the dialog keeps it, opens Stripe's page "in the browser" and waits; once the card is added
 * the prompt goes, once, and the canvas opens on it. Plan and usage then shows the card.
 *
 * Billing off is the other e2e walks' world (walk.e2e.test.ts): nothing there meets a wall.
 * Skips where there is no Chrome or Chromium.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import { type Browser, chromiumPath, launch, type Page } from "../../scripts/visual-lib.ts";
import { buildApp, serve, waitUntil } from "./e2e-lib.ts";

setDefaultTimeout(240_000);

const PROMPT = "A pricing page with three plans";

describe.skipIf(!chromiumPath)("free credits used up, with billing on", () => {
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
    await page.goto(`${server.url}?as=returning`);
  });
  afterAll(async () => {
    await browser?.close();
    server?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const fake = <T>(run: (arg: any) => T, arg?: unknown): Promise<T> =>
    page.evaluate(run as (arg: unknown) => T, arg);
  const dialog = () => page.getByRole("dialog");

  test("a send at the wall waits for the card, then goes once", async () => {
    await page.getByText("Make something").waitFor();
    await page.getByRole("button", { name: "Workspace: Northbrook" }).click();
    await page.getByRole("menuitemradio", { name: "Personal" }).click();
    // Billing on, and the person's own free credits used up: no card yet.
    await fake(() => {
      const { backend, me, personalId } = window.ponzuFake!;
      backend.features = { ...backend.features, billing: "on" };
      backend.settings.use(personalId, me.id, 150);
    });

    const field = page.getByPlaceholder(/Describe what you want to make/);
    await field.fill(PROMPT);
    await field.press("Enter");
    await page.getByRole("dialog", { name: "You've used this month's free credits" }).waitFor();
    // Nothing was made, and the prompt is still on the create page behind the dialog.
    expect(
      await fake(() => {
        const { backend, personalId } = window.ponzuFake!;
        return [...backend.canvases.values()].filter((c) => c.workspaceId === personalId).length;
      }),
    ).toBe(0);
    expect(await field.inputValue()).toBe(PROMPT);

    await dialog().getByRole("button", { name: "Add card and continue" }).click();
    await dialog()
      .getByText("Finish adding your card in your browser.", { exact: false })
      .waitFor();
    await dialog().getByRole("button", { name: "Waiting for your card" }).waitFor();
    expect(await fake(() => window.ponzuFake!.opened.at(-1))).toMatch(
      /^https:\/\/checkout\.stripe\.com\//,
    );

    // Stripe's page finishes: the app hears it by asking, the dialog goes, and the prompt is sent.
    await fake(() => {
      const { settings } = window.ponzuFake!.backend;
      const id = [...settings.cardSetups.keys()].at(-1)!;
      settings.completeCardSetup(id);
    });
    await dialog().waitFor({ state: "detached" });
    await page.locator("#thread").getByText(PROMPT).first().waitFor();
    await waitUntil(async () =>
      fake(() => {
        const { backend, personalId } = window.ponzuFake!;
        return (
          [...backend.canvases.values()].filter((c) => c.workspaceId === personalId).length === 1
        );
      }),
    );

    // Plan and usage: the card, which Stripe's portal manages.
    await page.keyboard.press("Meta+,");
    const nav = page.getByRole("navigation", { name: "Settings" });
    await nav.getByRole("button", { name: "Plan and usage" }).click();
    await page.getByText("Visa ending 4242").waitFor();
    await page.getByRole("button", { name: "Manage in Stripe" }).waitFor();
    expect(errors).toEqual([]);
  });
});
