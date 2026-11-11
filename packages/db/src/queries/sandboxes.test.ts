import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { emptyDoc } from "@ponzu/core";
import { eq } from "drizzle-orm";
import { seedDesign } from "../fixtures.ts";
import { designs, usageEvents } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { upsertMembership } from "./accounts.ts";
import { createDesign } from "./designs.ts";
import { appendEvent } from "./events.ts";
import { reportRunnerState, takeRunnerLease } from "./runners.ts";
import {
  beginSandbox,
  claimSandbox,
  getLiveSandbox,
  getWakeContext,
  isSandboxKnown,
  moveSandbox,
  type Sandbox,
  showAgentWaiting,
  touchSandbox,
  WAKING_LEASE_MS,
} from "./sandboxes.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1) + seconds * 1000);
const usageOf = (designId: string) =>
  db.select().from(usageEvents).where(eq(usageEvents.designId, designId));
const ROOMY = { perWorkspace: 100, perOwner: 100 };

/** The design's first sandbox, begun by the wake `by`. */
async function begin(designId: string, by = "job_a", now = at(0)): Promise<Sandbox> {
  const claim = await beginSandbox(db, { designId, provider: "boat", now, by, limits: ROOMY });
  if (!claim || "full" in claim) throw new Error("no sandbox was begun");
  return claim.sandbox;
}

describe("beginSandbox", () => {
  test("makes one live sandbox however many ask, and the design points at it", async () => {
    const { design } = await seedDesign(db);
    const begun = await Promise.all(
      ["job_a", "job_b", "job_c"].map((by) =>
        beginSandbox(db, { designId: design.id, provider: "boat", now: at(0), by, limits: ROOMY }),
      ),
    );
    const made = begun.flatMap((claim) => (claim && "sandbox" in claim ? [claim.sandbox] : []));
    expect(made).toHaveLength(1);
    expect(begun.filter((claim) => claim === null)).toHaveLength(2);
    expect(made[0]).toMatchObject({ generation: 1, state: "waking", providerId: null });
    const [row] = await db.select().from(designs).where(eq(designs.id, design.id));
    expect(row!.sandboxId).toBe(made[0]!.id);
  });

  test("counts generations on, past sandboxes that are gone", async () => {
    const { design } = await seedDesign(db);
    const first = await begin(design.id);
    await moveSandbox(db, { id: first.id, from: ["waking"], to: "gone", now: at(1) });
    expect((await begin(design.id, "job_b", at(2))).generation).toBe(2);
  });
});

describe("a wake's claim", () => {
  test("is the wake's alone while it holds it, and anyone's once it sat a lease", async () => {
    const { design } = await seedDesign(db);
    const row = await begin(design.id, "job_a");
    const claim = (by: string, now: Date) =>
      claimSandbox(db, { id: row.id, from: ["waking"], now, by, limits: ROOMY });

    expect(await claim("job_b", at(10))).toBeNull();
    // Its own wake tried again: still its own, and the lease starts over.
    expect(await claim("job_a", at(20))).toMatchObject({ sandbox: { wakingBy: "job_a" } });
    expect(
      await moveSandbox(db, {
        id: row.id,
        from: ["waking"],
        to: "awake",
        now: at(21),
        by: "job_b",
      }),
    ).toBeNull();

    const later = new Date(at(20).getTime() + WAKING_LEASE_MS + 1000);
    expect(await claim("job_b", later)).toMatchObject({ sandbox: { wakingBy: "job_b" } });
    // The wake that lost it moves it no more.
    expect(
      await moveSandbox(db, { id: row.id, from: ["waking"], to: "awake", now: later, by: "job_a" }),
    ).toBeNull();
    const awake = await moveSandbox(db, {
      id: row.id,
      from: ["waking"],
      to: "awake",
      now: later,
      by: "job_b",
    });
    expect(awake).toMatchObject({ state: "awake", wakingBy: null });
  });

  test("waits for room: so many up in a workspace, and so many for one owner", async () => {
    const { user, workspace, design: first } = await seedDesign(db);
    const another = (ownerId: string) =>
      createDesign(db, {
        workspaceId: workspace.id,
        repoId: null,
        ownerId,
        claudeAccountId: null,
        name: "Porto",
        branch: null,
        doc: emptyDoc("Porto"),
      });
    const { user: teammate } = await seedDesign(db);
    const limits = { perWorkspace: 2, perOwner: 1 };
    const start = (designId: string) =>
      beginSandbox(db, { designId, provider: "boat", now: at(0), by: "job", limits });

    expect(await start(first.id)).toMatchObject({ sandbox: { state: "waking" } });
    const second = await another(user.id);
    expect(await start(second.id)).toEqual({ full: true });
    const theirs = await another(teammate.id);
    expect(await start(theirs.id)).toMatchObject({ sandbox: { state: "waking" } });
    const third = await another(teammate.id);
    expect(await start(third.id)).toEqual({ full: true });

    // One goes to sleep, and the owner's next may start. A sleeping one takes no room.
    const asleep = (await getLiveSandbox(db, first.id))!;
    await moveSandbox(db, { id: asleep.id, from: ["waking"], to: "asleep", now: at(1) });
    expect(await start(second.id)).toMatchObject({ sandbox: { state: "waking" } });
    expect(
      await claimSandbox(db, {
        id: asleep.id,
        from: ["asleep"],
        now: at(2),
        by: "job",
        limits,
      }),
    ).toEqual({ full: true });
  });
});

describe("moveSandbox", () => {
  test("moves only from the states it is told, so of two racing moves one wins", async () => {
    const { design } = await seedDesign(db);
    const row = await begin(design.id);
    const moves = await Promise.all([
      moveSandbox(db, { id: row.id, from: ["waking"], to: "awake", now: at(5) }),
      moveSandbox(db, { id: row.id, from: ["waking"], to: "failed", now: at(5) }),
    ]);
    expect(moves.filter((move) => move !== null)).toHaveLength(1);
  });

  test("a repair moves only what nobody has moved since it looked", async () => {
    const { design } = await seedDesign(db);
    const row = await begin(design.id, "job_a", at(0));
    await moveSandbox(db, { id: row.id, from: ["waking"], to: "waking", now: at(30), by: "job_a" });
    expect(
      await moveSandbox(db, {
        id: row.id,
        from: ["waking"],
        to: "failed",
        now: at(400),
        stateBefore: at(1),
      }),
    ).toBeNull();
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
    const row = await begin(design.id);
    const awake = await moveSandbox(db, {
      id: row.id,
      from: ["waking"],
      to: "awake",
      now: at(4),
      changes: { providerId: "bx_1", address: "https://bx-1.test" },
    });
    expect(awake).toMatchObject({ state: "awake", awakeSince: at(4), providerId: "bx_1" });

    await moveSandbox(db, { id: row.id, from: ["awake"], to: "stopping", now: at(304) });
    // A second move out of awake, as from a racing sweep, finds nothing to meter.
    await moveSandbox(db, { id: row.id, from: ["awake", "stopping"], to: "asleep", now: at(306) });
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

    await moveSandbox(db, { id: row.id, from: ["asleep"], to: "waking", now: at(900) });
    await moveSandbox(db, { id: row.id, from: ["waking"], to: "awake", now: at(901) });
    await moveSandbox(db, { id: row.id, from: ["awake"], to: "gone", now: at(961) });
    expect((await usageOf(design.id)).map((use) => use.seconds).sort()).toEqual([300, 60]);
  });

  test("a stop that is not idle any more does not happen", async () => {
    const { design } = await seedDesign(db);
    const row = await begin(design.id);
    await moveSandbox(db, { id: row.id, from: ["waking"], to: "awake", now: at(1) });
    await touchSandbox(db, { designId: design.id, now: at(250) });
    const stopped = await moveSandbox(db, {
      id: row.id,
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
  const row = await begin(design.id);
  await moveSandbox(db, { id: row.id, from: ["waking"], to: "awake", now: at(1) });
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
  const { design, user, workspace } = await seedDesign(db);
  const context = await getWakeContext(db, design.id);
  expect(context).toMatchObject({ designId: design.id, ownerId: user.id, claude: null });
  expect(context!.sandbox).toBeNull();
  expect(context!.runnerTokenGood).toBe(false);
  // It says whether the owner is still in the design's workspace.
  expect(context!.ownerMember).toBe(false);
  await upsertMembership(db, { workspaceId: workspace.id, userId: user.id, role: "admin" });
  expect((await getWakeContext(db, design.id))!.ownerMember).toBe(true);
});

test("a sandbox being made is known for a lease, and a failed one shields nothing", async () => {
  const { design } = await seedDesign(db);
  const row = await begin(design.id, "job_a", at(0));
  const known = (now: Date) => isSandboxKnown(db, { designId: design.id, providerId: "bx_9", now });
  expect(await known(at(60))).toBe(true);
  expect(await known(new Date(at(0).getTime() + WAKING_LEASE_MS + 1000))).toBe(false);
  await moveSandbox(db, { id: row.id, from: ["waking"], to: "failed", now: at(61) });
  expect(await known(at(62))).toBe(false);
});
