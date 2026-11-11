import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { seedDesign } from "../fixtures.ts";
import { designs, usageEvents } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { appendEvent } from "./events.ts";
import { reportRunnerState, takeRunnerLease } from "./runners.ts";
import {
  beginSandbox,
  getLiveSandbox,
  getWakeContext,
  moveSandbox,
  showAgentWaiting,
  touchSandbox,
} from "./sandboxes.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1) + seconds * 1000);
const usageOf = (designId: string) =>
  db.select().from(usageEvents).where(eq(usageEvents.designId, designId));

describe("beginSandbox", () => {
  test("makes one live sandbox however many ask, and the design points at it", async () => {
    const { design } = await seedDesign(db);
    const begun = await Promise.all(
      [1, 2, 3].map(() => beginSandbox(db, { designId: design.id, provider: "boat", now: at(0) })),
    );
    const made = begun.filter((row) => row !== null);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ generation: 1, state: "waking", providerId: null });
    const [row] = await db.select().from(designs).where(eq(designs.id, design.id));
    expect(row!.sandboxId).toBe(made[0]!.id);
  });

  test("counts generations on, past sandboxes that are gone", async () => {
    const { design } = await seedDesign(db);
    const first = await beginSandbox(db, { designId: design.id, provider: "boat", now: at(0) });
    await moveSandbox(db, { id: first!.id, from: ["waking"], to: "gone", now: at(1) });
    const second = await beginSandbox(db, { designId: design.id, provider: "boat", now: at(2) });
    expect(second!.generation).toBe(2);
  });
});

describe("moveSandbox", () => {
  test("moves only from the states it is told, so of two racing moves one wins", async () => {
    const { design } = await seedDesign(db);
    const row = await beginSandbox(db, { designId: design.id, provider: "boat", now: at(0) });
    const moves = await Promise.all([
      moveSandbox(db, { id: row!.id, from: ["waking"], to: "awake", now: at(5) }),
      moveSandbox(db, { id: row!.id, from: ["waking"], to: "failed", now: at(5) }),
    ]);
    expect(moves.filter((move) => move !== null)).toHaveLength(1);
  });

  test("meters each awake stretch once, put down to the person behind the feed", async () => {
    const { design, user, workspace } = await seedDesign(db);
    await appendEvent(db, {
      designId: design.id,
      kind: "message",
      priority: "now",
      payload: { text: "hi" },
      userId: user.id,
    });
    const row = await beginSandbox(db, { designId: design.id, provider: "boat", now: at(0) });
    const awake = await moveSandbox(db, {
      id: row!.id,
      from: ["waking"],
      to: "awake",
      now: at(4),
      changes: { providerId: "bx_1", address: "https://bx-1.test" },
    });
    expect(awake).toMatchObject({ state: "awake", awakeSince: at(4), providerId: "bx_1" });

    await moveSandbox(db, { id: row!.id, from: ["awake"], to: "stopping", now: at(304) });
    // A second move out of awake, as from a racing sweep, finds nothing to meter.
    await moveSandbox(db, { id: row!.id, from: ["awake", "stopping"], to: "asleep", now: at(306) });
    expect(await usageOf(design.id)).toEqual([
      expect.objectContaining({
        workspaceId: workspace.id,
        userId: user.id,
        kind: "sandbox",
        seconds: 300,
        payer: "ponzu",
        credits: 0,
        occurredAt: at(4),
      }),
    ]);

    await moveSandbox(db, { id: row!.id, from: ["asleep"], to: "waking", now: at(900) });
    await moveSandbox(db, { id: row!.id, from: ["waking"], to: "awake", now: at(901) });
    await moveSandbox(db, { id: row!.id, from: ["awake"], to: "gone", now: at(961) });
    expect((await usageOf(design.id)).map((use) => use.seconds).sort()).toEqual([300, 60]);
  });

  test("a stop that is not idle any more does not happen", async () => {
    const { design } = await seedDesign(db);
    const row = await beginSandbox(db, { designId: design.id, provider: "boat", now: at(0) });
    await moveSandbox(db, { id: row!.id, from: ["waking"], to: "awake", now: at(1) });
    await touchSandbox(db, { designId: design.id, now: at(250) });
    const stopped = await moveSandbox(db, {
      id: row!.id,
      from: ["awake"],
      to: "stopping",
      now: at(400),
      idleBefore: at(100),
    });
    expect(stopped).toBeNull();
    expect((await getLiveSandbox(db, design.id))!.lastActivityAt).toEqual(at(250));
  });
});

test("a heartbeat that says working keeps the sandbox awake; one that says idle does not", async () => {
  const { design } = await seedDesign(db);
  const row = await beginSandbox(db, { designId: design.id, provider: "boat", now: at(0) });
  await moveSandbox(db, { id: row!.id, from: ["waking"], to: "awake", now: at(1) });
  await takeRunnerLease(db, { designId: design.id, now: at(2) });
  const report = { status: null, artboards: [], claudeSessionId: null };

  await reportRunnerState(db, { designId: design.id, now: at(60), state: "working", ...report });
  expect((await getLiveSandbox(db, design.id))!.lastActivityAt).toEqual(at(60));
  await reportRunnerState(db, { designId: design.id, now: at(90), state: "idle", ...report });
  expect((await getLiveSandbox(db, design.id))!.lastActivityAt).toEqual(at(60));
});

test("the head shows waking and why it waits, and goes back to idle", async () => {
  const { design } = await seedDesign(db);
  const head = async () => (await db.select().from(designs).where(eq(designs.id, design.id)))[0]!;

  await showAgentWaiting(db, { designId: design.id, waking: true, blocker: "sandbox_busy" });
  expect(await head()).toMatchObject({ agentState: "waking", agentBlocker: "sandbox_busy" });
  await showAgentWaiting(db, { designId: design.id, waking: false, blocker: "claude_expired" });
  expect(await head()).toMatchObject({ agentState: "idle", agentBlocker: "claude_expired" });
});

test("the wake context finds the owner's Claude for a design that records none", async () => {
  const { design, user } = await seedDesign(db);
  const context = await getWakeContext(db, design.id);
  expect(context).toMatchObject({ designId: design.id, ownerId: user.id, claude: null });
  expect(context!.sandbox).toBeNull();
  expect(context!.runnerTokenGood).toBe(false);
});
