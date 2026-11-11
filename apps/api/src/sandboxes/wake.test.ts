import { afterAll, beforeAll, expect, test } from "bun:test";
import { sampleDoc } from "@ponzu/core/fixtures";
import { designIn, workspaceWithRepo } from "../testing/designs.ts";
import { createTestApp, TEST_CRON_SECRET, type TestApp } from "../testing/index.ts";
import { requestWake } from "./wake.ts";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

const wakes = async (designId: string) => {
  const result = await t.db.execute(
    `select completed_at, failed_at from jobs where kind = 'sandbox.wake' and key = '${designId}'`,
  );
  return (result as unknown as { rows: { completed_at: unknown; failed_at: unknown }[] }).rows;
};

test("one wake waits per design; the cron runs it, and a later reason records a new one", async () => {
  const ws = await workspaceWithRepo(t, { maya: "write" });
  const design = await designIn(t, ws, "maya", sampleDoc());

  await requestWake(t.deps, design.id, "message");
  await requestWake(t.deps, design.id, "comment");
  await requestWake(t.deps, design.id, "edit");
  expect(await wakes(design.id)).toHaveLength(1);

  // A minute on, the cron takes it up: until sandboxes are woken, it completes, never fails.
  t.clock.advance(60_000);
  const cron = await t.app.request("/v1/cron/minute", {
    headers: { authorization: `Bearer ${TEST_CRON_SECRET}` },
  });
  expect((await cron.json()).ran).toBe(1);
  const [ran] = await wakes(design.id);
  expect(ran!.completed_at).not.toBeNull();
  expect(ran!.failed_at).toBeNull();

  await requestWake(t.deps, design.id, "answer");
  expect(await wakes(design.id)).toHaveLength(2);
  // Without an awake sandbox there is nobody to poke.
  await t.backgroundDone();
  expect(t.poke.pokes).toEqual([]);
});
