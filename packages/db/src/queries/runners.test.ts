import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { seedDesign } from "../fixtures.ts";
import { designRunners, designs } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { getDesignHead } from "./designs.ts";
import { markEventsDelivered } from "./events.ts";
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

const runnerOf = async (designId: string) =>
  (await db.select().from(designRunners).where(eq(designRunners.designId, designId)))[0];

test("each lease is a new runner id that replaces the last, and keeps the design's session", async () => {
  const { design } = await seedDesign(db);
  const first = await takeRunnerLease(db, { designId: design.id, now: new Date(1_000) });
  await markEventsDelivered(db, {
    designId: design.id,
    runnerId: first.runnerId,
    ids: [],
    claudeSessionId: "sess-1",
  });

  const second = await takeRunnerLease(db, { designId: design.id, now: new Date(5_000) });

  expect(first).toEqual({
    runnerId: expect.stringMatching(/^rnr_[0-9a-z]{16}$/),
    claudeSessionId: null,
    saved: null,
  });
  expect(second.runnerId).not.toBe(first.runnerId);
  expect(second.claudeSessionId).toBe("sess-1");
  expect(await runnerOf(design.id)).toMatchObject({
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

test("a state report shows on the design's head and answers its seq", async () => {
  const { design } = await seedDesign(db);
  await takeRunnerLease(db, { designId: design.id, now: new Date(1_000) });

  const answer = await reportRunnerState(db, {
    designId: design.id,
    now: new Date(2_000),
    ...working,
  });

  expect(answer).toEqual({ seq: 0 });
  expect(await getDesignHead(db, design.id)).toMatchObject({
    agentState: "working",
    agentStatus: 'Drawing "Pricing"',
    agentArtboards: ["ab_1", "ab_2"],
  });
  expect((await runnerOf(design.id))!.heardAt).toEqual(new Date(2_000));
});

test("a heartbeat that says the same again touches only the runner's row", async () => {
  const { design } = await seedDesign(db);
  await takeRunnerLease(db, { designId: design.id, now: new Date(1_000) });
  await reportRunnerState(db, { designId: design.id, now: new Date(2_000), ...working });
  const before = (await db.select().from(designs).where(eq(designs.id, design.id)))[0]!;

  await reportRunnerState(db, { designId: design.id, now: new Date(32_000), ...working });

  const after = (await db.select().from(designs).where(eq(designs.id, design.id)))[0]!;
  expect(after.updatedAt).toEqual(before.updatedAt);
  expect((await runnerOf(design.id))!.heardAt).toEqual(new Date(32_000));

  await reportRunnerState(db, {
    designId: design.id,
    now: new Date(33_000),
    state: "idle",
    status: null,
    artboards: [],
    claudeSessionId: "sess-9",
  });
  expect(await getDesignHead(db, design.id)).toMatchObject({
    agentState: "idle",
    agentStatus: null,
    agentArtboards: [],
  });
  expect((await runnerOf(design.id))!.claudeSessionId).toBe("sess-9");
  // A report that names no session keeps the one there is.
  await reportRunnerState(db, { designId: design.id, now: new Date(34_000), ...working });
  expect((await runnerOf(design.id))!.claudeSessionId).toBe("sess-9");
});

test("a design without a runner takes no report", async () => {
  const { design } = await seedDesign(db);

  expect(
    await reportRunnerState(db, { designId: design.id, now: new Date(), ...working }),
  ).toBeNull();
  expect((await getDesignHead(db, design.id))!.agentState).toBe("idle");
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

  test("a new design has none, and the lease answers the one recorded", async () => {
    const { design } = await seedDesign(db);
    const lease = await takeRunnerLease(db, { designId: design.id, now: new Date(1_000) });
    expect(lease.saved).toBeNull();
    expect(await getSavedPoint(db, design.id)).toBeNull();

    const recorded = await recordCheckpoint(db, {
      designId: design.id,
      runnerId: lease.runnerId,
      now: new Date(2_000),
      ...point(1, { wipCommit: "c1" }),
    });
    expect(recorded).toEqual({
      saved: { ...point(1, { wipCommit: "c1" }), at: new Date(2_000) },
      replaced: null,
    });
    const again = await takeRunnerLease(db, { designId: design.id, now: new Date(3_000) });
    expect(again.saved).toEqual({ ...point(1, { wipCommit: "c1" }), at: new Date(2_000) });
  });

  test("a turn marker only goes up, and a superseded runner records nothing", async () => {
    const { design } = await seedDesign(db);
    const { runnerId } = await takeRunnerLease(db, { designId: design.id, now: new Date(1_000) });
    const at = (ms: number) => ({ designId: design.id, runnerId, now: new Date(ms) });
    await recordCheckpoint(db, { ...at(2_000), ...point(3) });

    const newer = await recordCheckpoint(db, { ...at(3_000), ...point(4) });
    expect(newer!.saved!.turn).toBe(4);
    expect(newer!.replaced!.sessionUploadId).toBe("up_3");

    // Late, or sent again: the newer one stays.
    const late = await recordCheckpoint(db, { ...at(4_000), ...point(2) });
    expect(late).toEqual({ saved: { ...point(4), at: new Date(3_000) }, replaced: null });
    const repeated = await recordCheckpoint(db, { ...at(5_000), ...point(4) });
    expect(repeated!.replaced).toBeNull();

    await takeRunnerLease(db, { designId: design.id, now: new Date(6_000) });
    expect(await recordCheckpoint(db, { ...at(7_000), ...point(9) })).toBeNull();
    expect((await getSavedPoint(db, design.id))!.turn).toBe(4);
  });
});
