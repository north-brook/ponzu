import { afterAll, beforeAll, expect, test } from "bun:test";
import { sampleDoc } from "@ponzu/core/fixtures";
import { listThreadItems } from "@ponzu/db";
import { FakeClock } from "@ponzu/sandbox";
import { createPoke } from "../deps/poke.ts";
import { call, canvasIn, workspaceWithRepo } from "../testing/canvases.ts";
import { createTestApp, type TestApp } from "../testing/index.ts";
import { requestWake } from "./wake.ts";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

const wakes = async (canvasId: string) => {
  const result = await t.db.execute(
    `select completed_at, failed_at, locked_by from jobs where kind = 'sandbox.wake' and key = '${canvasId}'`,
  );
  return (result as unknown as { rows: { completed_at: unknown; failed_at: unknown }[] }).rows;
};

test("a wake that cannot be recorded is logged, and never fails what was already written", async () => {
  const ws = await workspaceWithRepo(t, { maya: "write" });
  const canvas = await canvasIn(t, ws, "maya", sampleDoc());
  await t.db.execute(`
    create function jobs_refuse() returns trigger language plpgsql as $$
    begin raise exception 'the database went away'; end $$`);
  await t.db.execute(
    "create trigger jobs_refuse before insert on jobs for each row execute function jobs_refuse()",
  );
  try {
    const message = { text: "Make it blue" };
    const path = `/v1/canvases/${canvas.id}/messages`;
    const posted = await call(t, ws.people.maya!.headers, "POST", path, message);

    expect(posted.status).toBe(201);
    expect(await listThreadItems(t.db, { canvasId: canvas.id })).toHaveLength(1);
    expect(t.logs.findLast((line) => line.event === "wake_failed")).toMatchObject({
      canvasId: canvas.id,
      reason: "message",
    });
  } finally {
    await t.db.execute("drop trigger jobs_refuse on jobs");
    await t.db.execute("drop function jobs_refuse()");
  }
});

test("only a message, an answer or a comment records a wake, and it runs at once", async () => {
  const ws = await workspaceWithRepo(t, { maya: "write" });
  const canvas = await canvasIn(t, ws, "maya", sampleDoc());

  await requestWake(t.deps, canvas.id, "edit");
  await requestWake(t.deps, canvas.id, "stop");
  expect(await wakes(canvas.id)).toHaveLength(0);

  await requestWake(t.deps, canvas.id, "comment");
  await t.backgroundDone();
  // Nobody connected Claude, so the wake is over at once: the canvas says why it waits.
  const [ran] = await wakes(canvas.id);
  expect(ran!.completed_at).not.toBeNull();
  expect(ran!.failed_at).toBeNull();
  // Without an awake sandbox there is nobody to poke.
  expect(t.poke.pokes).toEqual([]);
});

test("a poke carries the port's bearer, and a 502 or 503 just after a start is tried again for a second", async () => {
  const clock = new FakeClock();
  const seen: { url: string; authorization: string | null; method: string }[] = [];
  let answers = [502, 503, 204];
  const poke = createPoke({
    clock,
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      seen.push({
        url: String(url),
        authorization: headers.get("authorization"),
        method: init!.method!,
      });
      return new Response(null, { status: answers.shift() ?? 204 });
    },
  });
  await poke({ url: "https://sb-1.vercel.run", token: "port-token" });
  expect(seen).toHaveLength(3);
  expect(seen[0]).toEqual({
    url: "https://sb-1.vercel.run/poke",
    authorization: "Bearer port-token",
    method: "POST",
  });

  // Past a second it gives up; and a 401 is not tried again at all.
  answers = Array(20).fill(502);
  await expect(poke({ url: "https://sb-1.vercel.run", token: "port-token" })).rejects.toThrow(
    "502",
  );
  seen.length = 0;
  answers = [401];
  await expect(poke({ url: "https://sb-1.vercel.run", token: "wrong" })).rejects.toThrow("401");
  expect(seen).toHaveLength(1);
});
