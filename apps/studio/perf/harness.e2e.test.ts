/*
 * The harness still runs against the studio as it is: a suite set up, a gesture and an action
 * measured, every number there. It asserts nothing about how fast the studio is (the comment
 * reports that, and never fails); only that the comment would have numbers to show. Skips where
 * there is no Chrome or Chromium.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import { chromiumPath } from "../scripts/visual-lib.ts";
import { buildApp } from "../src/app/e2e-lib.ts";
import { openStudio, type Studio } from "./app.ts";
import { SUITES, type SuiteState } from "./scenarios.ts";

setDefaultTimeout(120_000);

describe.skipIf(!chromiumPath)("the performance harness", () => {
  let dir: string;
  let studio: Studio;
  let state: SuiteState;
  const huge = SUITES.find((s) => s.id === "huge")!;
  const scenario = (id: string) => huge.scenarios.find((s) => s.id === id)!;

  beforeAll(async () => {
    dir = await buildApp("e2e");
    studio = await openStudio(dir, chromiumPath ?? undefined);
    state = await huge.setup(studio);
  });
  afterAll(async () => {
    await studio?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("opening a canvas is timed and counted", async () => {
    const m = await scenario("huge.open").run(studio, state);
    expect(m.latencyMs).toBeGreaterThan(0);
    expect(m.domNodes).toBeGreaterThan(0);
    expect(m.mainMs).toBeGreaterThan(0);
  });

  test("a pinch is traced, frame by frame", async () => {
    const m = await scenario("huge.zoom").run(studio, state);
    expect(m.fps).toBeGreaterThan(0);
    expect(m.mainMs).toBeGreaterThan(0);
    expect(m.restyledPerFrame).toBeGreaterThanOrEqual(0);
    expect(m.commits).toBeGreaterThanOrEqual(0);
  });
});
