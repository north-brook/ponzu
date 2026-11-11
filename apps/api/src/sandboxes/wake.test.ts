import { afterAll, beforeAll, expect, test } from "bun:test";
import { sampleDoc } from "@ponzu/core/fixtures";
import { listThreadItems } from "@ponzu/db";
import { call, designIn, workspaceWithRepo } from "../testing/designs.ts";
import { createTestApp, type TestApp } from "../testing/index.ts";
import { requestWake } from "./wake.ts";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

const wakes = async (designId: string) => {
  const result = await t.db.execute(
    `select completed_at, failed_at, locked_by from jobs where kind = 'sandbox.wake' and key = '${designId}'`,
  );
  return (result as unknown as { rows: { completed_at: unknown; failed_at: unknown }[] }).rows;
};

test("a wake that cannot be recorded is logged, and never fails what was already written", async () => {
  const ws = await workspaceWithRepo(t, { maya: "write" });
  const design = await designIn(t, ws, "maya", sampleDoc());
  await t.db.execute(`
    create function jobs_refuse() returns trigger language plpgsql as $$
    begin raise exception 'the database went away'; end $$`);
  await t.db.execute(
    "create trigger jobs_refuse before insert on jobs for each row execute function jobs_refuse()",
  );
  try {
    const message = { text: "Make it blue" };
    const path = `/v1/designs/${design.id}/messages`;
    const posted = await call(t, ws.people.maya!.headers, "POST", path, message);

    expect(posted.status).toBe(201);
    expect(await listThreadItems(t.db, { designId: design.id })).toHaveLength(1);
    expect(t.logs.findLast((line) => line.event === "wake_failed")).toMatchObject({
      designId: design.id,
      reason: "message",
    });
  } finally {
    await t.db.execute("drop trigger jobs_refuse on jobs");
    await t.db.execute("drop function jobs_refuse()");
  }
});

test("only a message, an answer or a comment records a wake, and it runs at once", async () => {
  const ws = await workspaceWithRepo(t, { maya: "write" });
  const design = await designIn(t, ws, "maya", sampleDoc());

  await requestWake(t.deps, design.id, "edit");
  await requestWake(t.deps, design.id, "stop");
  expect(await wakes(design.id)).toHaveLength(0);

  await requestWake(t.deps, design.id, "comment");
  await t.backgroundDone();
  // Nobody connected Claude, so the wake is over at once: the design says why it waits.
  const [ran] = await wakes(design.id);
  expect(ran!.completed_at).not.toBeNull();
  expect(ran!.failed_at).toBeNull();
  // Without an awake sandbox there is nobody to poke.
  expect(t.poke.pokes).toEqual([]);
});
