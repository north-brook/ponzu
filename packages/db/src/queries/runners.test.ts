import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { seedCanvas } from "../fixtures.ts";
import { newId } from "../ids.ts";
import { canvases, canvasRunners } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { getCanvasHead } from "./canvases.ts";
import { appendEvent, claimEvents, markEventsDelivered } from "./events.ts";
import {
  getSavedPoint,
  recordCheckpoint,
  reportRunnerState,
  type SavedPoint,
  takeRunnerLease,
} from "./runners.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

const runnerOf = async (canvasId: string) =>
  (await db.select().from(canvasRunners).where(eq(canvasRunners.canvasId, canvasId)))[0];

test("each lease is a new runner id that replaces the last, and keeps the canvas's session", async () => {
  const { canvas } = await seedCanvas(db);
  const first = await takeRunnerLease(db, { canvasId: canvas.id, now: new Date(1_000) });
  await markEventsDelivered(db, {
    canvasId: canvas.id,
    runnerId: first.runnerId,
    ids: [],
    claudeSessionId: "sess-1",
  });

  const second = await takeRunnerLease(db, { canvasId: canvas.id, now: new Date(5_000) });

  expect(first).toEqual({
    runnerId: expect.stringMatching(/^rnr_[0-9a-z]{16}$/),
    claudeSessionId: null,
    saved: null,
  });
  expect(second.runnerId).not.toBe(first.runnerId);
  expect(second.claudeSessionId).toBe("sess-1");
  expect(await runnerOf(canvas.id)).toMatchObject({
    runnerId: second.runnerId,
    startedAt: new Date(5_000),
    heardAt: new Date(5_000),
  });
});

const working = {
  state: "working" as const,
  status: 'Drawing "Pricing"',
  artboards: ["ab_1", "ab_2"],
  claudeSessionId: null,
};

test("a state report shows on the canvas's head and answers its seq", async () => {
  const { canvas } = await seedCanvas(db);
  await takeRunnerLease(db, { canvasId: canvas.id, now: new Date(1_000) });

  const answer = await reportRunnerState(db, {
    canvasId: canvas.id,
    now: new Date(2_000),
    ...working,
  });

  expect(answer).toEqual({ seq: 0 });
  expect(await getCanvasHead(db, canvas.id)).toMatchObject({
    agentState: "working",
    agentStatus: 'Drawing "Pricing"',
    agentArtboards: ["ab_1", "ab_2"],
  });
  expect((await runnerOf(canvas.id))!.heardAt).toEqual(new Date(2_000));
});

test("a heartbeat that says the same again touches only the runner's row", async () => {
  const { canvas } = await seedCanvas(db);
  await takeRunnerLease(db, { canvasId: canvas.id, now: new Date(1_000) });
  await reportRunnerState(db, { canvasId: canvas.id, now: new Date(2_000), ...working });
  const before = (await db.select().from(canvases).where(eq(canvases.id, canvas.id)))[0]!;

  await reportRunnerState(db, { canvasId: canvas.id, now: new Date(32_000), ...working });

  const after = (await db.select().from(canvases).where(eq(canvases.id, canvas.id)))[0]!;
  expect(after.updatedAt).toEqual(before.updatedAt);
  expect((await runnerOf(canvas.id))!.heardAt).toEqual(new Date(32_000));

  await reportRunnerState(db, {
    canvasId: canvas.id,
    now: new Date(33_000),
    state: "idle",
    status: null,
    artboards: [],
    claudeSessionId: "sess-9",
  });
  expect(await getCanvasHead(db, canvas.id)).toMatchObject({
    agentState: "idle",
    agentStatus: null,
    agentArtboards: [],
  });
  expect((await runnerOf(canvas.id))!.claudeSessionId).toBe("sess-9");
  // A report that names no session keeps the one there is.
  await reportRunnerState(db, { canvasId: canvas.id, now: new Date(34_000), ...working });
  expect((await runnerOf(canvas.id))!.claudeSessionId).toBe("sess-9");
});

test("a canvas without a runner takes no report", async () => {
  const { canvas } = await seedCanvas(db);

  expect(
    await reportRunnerState(db, { canvasId: canvas.id, now: new Date(), ...working }),
  ).toBeNull();
  expect((await getCanvasHead(db, canvas.id))!.agentState).toBe("idle");
});

describe("checkpoints", () => {
  const point = (turn: number, over: Partial<SavedPoint> = {}) => ({
    turn,
    claudeSessionId: "sess-1",
    wipCommit: null,
    sessionUploadId: `up_${turn}`,
    workspaceUploadId: null,
    ...over,
  });

  test("a new canvas has none, and the lease answers the one recorded", async () => {
    const { canvas } = await seedCanvas(db);
    const lease = await takeRunnerLease(db, { canvasId: canvas.id, now: new Date(1_000) });
    expect(lease.saved).toBeNull();
    expect(await getSavedPoint(db, canvas.id)).toBeNull();

    const recorded = await recordCheckpoint(db, {
      canvasId: canvas.id,
      runnerId: lease.runnerId,
      now: new Date(2_000),
      ...point(1, { wipCommit: "c1" }),
    });
    expect(recorded).toEqual({
      saved: { ...point(1, { wipCommit: "c1" }), at: new Date(2_000) },
      replaced: null,
    });
    const again = await takeRunnerLease(db, { canvasId: canvas.id, now: new Date(3_000) });
    expect(again.saved).toEqual({ ...point(1, { wipCommit: "c1" }), at: new Date(2_000) });
  });

  test("a turn marker only goes up, and a superseded runner records nothing", async () => {
    const { canvas } = await seedCanvas(db);
    const { runnerId } = await takeRunnerLease(db, { canvasId: canvas.id, now: new Date(1_000) });
    const at = (ms: number) => ({ canvasId: canvas.id, runnerId, now: new Date(ms) });
    await recordCheckpoint(db, { ...at(2_000), ...point(3) });

    const newer = await recordCheckpoint(db, { ...at(3_000), ...point(4) });
    expect(newer!.saved!.turn).toBe(4);
    expect(newer!.replaced!.sessionUploadId).toBe("up_3");

    // Late, or sent again: the newer one stays.
    const late = await recordCheckpoint(db, { ...at(4_000), ...point(2) });
    expect(late).toEqual({ saved: { ...point(4), at: new Date(3_000) }, replaced: null });
    const repeated = await recordCheckpoint(db, { ...at(5_000), ...point(4) });
    expect(repeated!.replaced).toBeNull();

    await takeRunnerLease(db, { canvasId: canvas.id, now: new Date(6_000) });
    expect(await recordCheckpoint(db, { ...at(7_000), ...point(9) })).toBeNull();
    expect((await getSavedPoint(db, canvas.id))!.turn).toBe(4);
  });
  describe("what a checkpoint holds (`saved_through`)", () => {
    /** A canvas whose runner was handed four messages and delivered the first three. */
    async function delivered() {
      const { canvas, user } = await seedCanvas(db);
      const { runnerId } = await takeRunnerLease(db, { canvasId: canvas.id, now: new Date(1_000) });
      const seqs: number[] = [];
      for (let i = 0; i < 4; i++) {
        const event = await appendEvent(db, {
          canvasId: canvas.id,
          kind: "message",
          priority: "now",
          payload: { text: `m${i}` },
          userId: user.id,
        });
        seqs.push(event.seq);
      }
      const claimed = await claimEvents(db, {
        canvasId: canvas.id,
        runnerId,
        claimId: newId("clm"),
      });
      const ids = claimed!.events.map((event) => event.id);
      await markEventsDelivered(db, {
        canvasId: canvas.id,
        runnerId,
        ids: ids.slice(0, 3),
        claudeSessionId: "sess-1",
      });
      const record = (heldThrough?: number) =>
        recordCheckpoint(db, {
          canvasId: canvas.id,
          runnerId,
          now: new Date(2_000),
          ...point(1),
          ...(heldThrough === undefined ? {} : { heldThrough }),
        });
      return { canvasId: canvas.id, seqs, record };
    }

    test("a runner that does not say counts every event delivered by now, as before", async () => {
      const { canvasId, seqs, record } = await delivered();
      await record();
      expect((await runnerOf(canvasId))!.savedThrough).toBe(seqs[2]!);
    });

    test("a runner that says records what its session held, below what was delivered", async () => {
      const { canvasId, seqs, record } = await delivered();
      await record(seqs[1]!);
      expect((await runnerOf(canvasId))!.savedThrough).toBe(seqs[1]!);
    });

    test("never above what was delivered: a runner cannot count as held what never went out", async () => {
      const { canvasId, seqs, record } = await delivered();
      await record(seqs[3]! + 100);
      expect((await runnerOf(canvasId))!.savedThrough).toBe(seqs[2]!);
    });

    test("with nothing delivered there is nothing held, whatever the runner says", async () => {
      const { canvas } = await seedCanvas(db);
      const { runnerId } = await takeRunnerLease(db, { canvasId: canvas.id, now: new Date(1_000) });
      await recordCheckpoint(db, {
        canvasId: canvas.id,
        runnerId,
        now: new Date(2_000),
        ...point(1),
        heldThrough: 5,
      });
      expect((await runnerOf(canvas.id))!.savedThrough).toBeNull();
    });
  });
});
