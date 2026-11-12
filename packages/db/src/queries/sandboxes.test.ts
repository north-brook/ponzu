import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { emptyDoc } from "@ponzu/core";
import { eq } from "drizzle-orm";
import { seedCanvas } from "../fixtures.ts";
import { canvases, usageEvents } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { upsertMembership } from "./accounts.ts";
import { createCanvas, deleteCanvas } from "./canvases.ts";
import { appendEvent } from "./events.ts";
import { reportRunnerState, takeRunnerLease } from "./runners.ts";
import {
  beginSandbox,
  claimSandbox,
  deleteSandboxRow,
  getSandbox,
  getSandboxOwners,
  getWakeContext,
  moveSandbox,
  type SandboxRow,
  setSandboxExpiry,
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
const usageOf = (canvasId: string) =>
  db.select().from(usageEvents).where(eq(usageEvents.canvasId, canvasId));
const ROOMY = { perWorkspace: 100, perOwner: 100 };

/** The canvas's sandbox row, begun by the wake `by`. */
async function begin(canvasId: string, by = "job_a", now = at(0)): Promise<SandboxRow> {
  const claim = await beginSandbox(db, { canvasId, now, by, limits: ROOMY });
  if (!claim || "full" in claim) throw new Error("no sandbox was begun");
  return claim.sandbox;
}

describe("beginSandbox", () => {
  test("makes one row however many ask", async () => {
    const { canvas } = await seedCanvas(db);
    const begun = await Promise.all(
      ["job_a", "job_b", "job_c"].map((by) =>
        beginSandbox(db, { canvasId: canvas.id, now: at(0), by, limits: ROOMY }),
      ),
    );
    const made = begun.flatMap((claim) => (claim && "sandbox" in claim ? [claim.sandbox] : []));
    expect(made).toHaveLength(1);
    expect(begun.filter((claim) => claim === null)).toHaveLength(2);
    expect(made[0]).toMatchObject({ canvasId: canvas.id, state: "waking", sessionId: null });
  });

  test("goes with its canvas", async () => {
    const { canvas } = await seedCanvas(db);
    await begin(canvas.id);
    await deleteCanvas(db, canvas.id);
    expect(await getSandbox(db, canvas.id)).toBeNull();
  });
});

describe("a wake's claim", () => {
  test("is the wake's alone while it holds it, and anyone's once it sat a lease", async () => {
    const { canvas } = await seedCanvas(db);
    await begin(canvas.id, "job_a");
    const claim = (by: string, now: Date) =>
      claimSandbox(db, { canvasId: canvas.id, from: ["waking"], now, by, limits: ROOMY });
    const awake = (by: string, now: Date) =>
      moveSandbox(db, { canvasId: canvas.id, from: ["waking"], to: "awake", now, by });

    expect(await claim("job_b", at(10))).toBeNull();
    // Its own wake tried again: still its own, and the lease starts over.
    expect(await claim("job_a", at(20))).toMatchObject({ sandbox: { wakingBy: "job_a" } });
    expect(await awake("job_b", at(21))).toBeNull();

    const later = new Date(at(20).getTime() + WAKING_LEASE_MS + 1000);
    expect(await claim("job_b", later)).toMatchObject({ sandbox: { wakingBy: "job_b" } });
    // The wake that lost it moves it no more.
    expect(await awake("job_a", later)).toBeNull();
    expect(await awake("job_b", later)).toMatchObject({ state: "awake", wakingBy: null });
  });

  test("waits for room: so many up in a workspace, and so many for one owner", async () => {
    const { user, workspace, canvas: first } = await seedCanvas(db);
    const another = (ownerId: string) =>
      createCanvas(db, {
        workspaceId: workspace.id,
        repoId: null,
        ownerId,
        claudeAccountId: null,
        name: "Porto",
        branch: null,
        doc: emptyDoc("Porto"),
      });
    const { user: teammate } = await seedCanvas(db);
    const limits = { perWorkspace: 2, perOwner: 1 };
    const start = (canvasId: string) =>
      beginSandbox(db, { canvasId, now: at(0), by: "job", limits });

    expect(await start(first.id)).toMatchObject({ sandbox: { state: "waking" } });
    const second = await another(user.id);
    expect(await start(second.id)).toEqual({ full: true });
    const theirs = await another(teammate.id);
    expect(await start(theirs.id)).toMatchObject({ sandbox: { state: "waking" } });
    const third = await another(teammate.id);
    expect(await start(third.id)).toEqual({ full: true });

    // One goes to sleep, and the owner's next may start. A sleeping one takes no room.
    await moveSandbox(db, {
      canvasId: first.id,
      from: ["waking"],
      to: "asleep",
      now: at(1),
      by: "job",
    });
    expect(await start(second.id)).toMatchObject({ sandbox: { state: "waking" } });
    expect(
      await claimSandbox(db, {
        canvasId: first.id,
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
    const { canvas } = await seedCanvas(db);
    await begin(canvas.id);
    const moves = await Promise.all([
      moveSandbox(db, { canvasId: canvas.id, from: ["waking"], to: "awake", now: at(5) }),
      moveSandbox(db, { canvasId: canvas.id, from: ["waking"], to: "asleep", now: at(5) }),
    ]);
    expect(moves.filter((move) => move !== null)).toHaveLength(1);
  });

  test("a repair moves only what nobody has moved since it looked", async () => {
    const { canvas } = await seedCanvas(db);
    await begin(canvas.id, "job_a", at(0));
    await moveSandbox(db, {
      canvasId: canvas.id,
      from: ["waking"],
      to: "waking",
      now: at(30),
      by: "job_a",
    });
    expect(
      await moveSandbox(db, {
        canvasId: canvas.id,
        from: ["waking"],
        to: "asleep",
        now: at(400),
        stateBefore: at(1),
      }),
    ).toBeNull();
  });

  test("a retire takes the row from whoever holds it, and the holder's moves fail", async () => {
    const { canvas } = await seedCanvas(db);
    await begin(canvas.id, "job_a", at(0));
    const held = await moveSandbox(db, {
      canvasId: canvas.id,
      from: ["asleep", "waking", "awake", "stopping"],
      to: "stopping",
      now: at(1),
      hold: "retire:job_r",
    });
    expect(held).toMatchObject({ state: "stopping", wakingBy: "retire:job_r" });
    expect(
      await moveSandbox(db, {
        canvasId: canvas.id,
        from: ["waking", "stopping"],
        to: "awake",
        now: at(2),
        by: "job_a",
      }),
    ).toBeNull();
    // Only the retire holding it deletes it.
    expect(await deleteSandboxRow(db, { canvasId: canvas.id, by: "job_a" })).toBe(false);
    expect(await deleteSandboxRow(db, { canvasId: canvas.id, by: "retire:job_r" })).toBe(true);
    expect(await getSandbox(db, canvas.id)).toBeNull();
  });

  test("records the session it is awake on, and forgets its address asleep", async () => {
    const { canvas } = await seedCanvas(db);
    await begin(canvas.id);
    const awake = await moveSandbox(db, {
      canvasId: canvas.id,
      from: ["waking"],
      to: "awake",
      now: at(4),
      by: "job_a",
      changes: {
        sessionId: "sbx_1",
        sessionStartedAt: at(3),
        address: "https://sb-1.vercel.run",
        encryptedPortToken: "sealed",
        expiresAt: at(1803),
        image: "ponzu-runner@sha256:aa",
        runnerTokenId: null,
        claudeCredential: "cla_1@2026",
      },
    });
    expect(awake).toMatchObject({
      sessionId: "sbx_1",
      sessionStartedAt: at(3),
      address: "https://sb-1.vercel.run",
      expiresAt: at(1803),
    });
    // An extend for another session, or a row asleep, records nothing.
    expect(
      await setSandboxExpiry(db, { canvasId: canvas.id, sessionId: "sbx_0", expiresAt: at(9) }),
    ).toBe(false);
    expect(
      await setSandboxExpiry(db, { canvasId: canvas.id, sessionId: "sbx_1", expiresAt: at(3003) }),
    ).toBe(true);
    // A move pinned to another session does not happen.
    expect(
      await moveSandbox(db, {
        canvasId: canvas.id,
        from: ["awake"],
        to: "asleep",
        now: at(5),
        sessionId: "sbx_0",
      }),
    ).toBeNull();
    const asleep = await moveSandbox(db, {
      canvasId: canvas.id,
      from: ["awake"],
      to: "asleep",
      now: at(6),
      sessionId: "sbx_1",
      changes: { failure: "it would not start" },
    });
    expect(asleep).toMatchObject({
      state: "asleep",
      sessionId: "sbx_1",
      address: null,
      encryptedPortToken: null,
      expiresAt: null,
      failure: "it would not start",
      image: "ponzu-runner@sha256:aa",
    });
  });

  test("meters each awake stretch once, put down to the person behind the feed", async () => {
    const { canvas, user, workspace } = await seedCanvas(db);
    await appendEvent(db, {
      canvasId: canvas.id,
      kind: "message",
      priority: "now",
      payload: { text: "hi" },
      userId: user.id,
    });
    await begin(canvas.id);
    const awake = await moveSandbox(db, {
      canvasId: canvas.id,
      from: ["waking"],
      to: "awake",
      now: at(4),
      changes: { sessionId: "sbx_1", address: "https://sb-1.vercel.run" },
    });
    expect(awake).toMatchObject({ state: "awake", awakeSince: at(4), sessionId: "sbx_1" });

    await moveSandbox(db, { canvasId: canvas.id, from: ["awake"], to: "stopping", now: at(304) });
    // A second move out of awake, as from a racing sweep, finds nothing to meter.
    await moveSandbox(db, {
      canvasId: canvas.id,
      from: ["awake", "stopping"],
      to: "asleep",
      now: at(306),
    });
    const [used] = await usageOf(canvas.id);
    expect(used).toMatchObject({
      id: `${canvas.id}/${at(4).getTime()}`,
      workspaceId: workspace.id,
      userId: user.id,
      kind: "sandbox",
      seconds: 300,
      payer: "ponzu",
      credits: 0,
      occurredAt: at(4),
    });

    await moveSandbox(db, { canvasId: canvas.id, from: ["asleep"], to: "waking", now: at(900) });
    await moveSandbox(db, { canvasId: canvas.id, from: ["waking"], to: "awake", now: at(901) });
    // A restart in place meters what was awake, and the next awake starts a new stretch.
    await moveSandbox(db, { canvasId: canvas.id, from: ["awake"], to: "waking", now: at(961) });
    await moveSandbox(db, { canvasId: canvas.id, from: ["waking"], to: "awake", now: at(962) });
    await moveSandbox(db, { canvasId: canvas.id, from: ["awake"], to: "asleep", now: at(1022) });
    expect((await usageOf(canvas.id)).map((use) => use.seconds).sort()).toEqual([300, 60, 60]);
  });

  test("a stop that is not idle any more does not happen", async () => {
    const { canvas } = await seedCanvas(db);
    await begin(canvas.id);
    await moveSandbox(db, { canvasId: canvas.id, from: ["waking"], to: "awake", now: at(1) });
    await touchSandbox(db, { canvasId: canvas.id, now: at(250) });
    const stopped = await moveSandbox(db, {
      canvasId: canvas.id,
      from: ["awake"],
      to: "stopping",
      now: at(400),
      idleBefore: at(100),
    });
    expect(stopped).toBeNull();
    expect((await getSandbox(db, canvas.id))!.lastActivityAt).toEqual(at(250));
  });
});

test("a heartbeat that says working keeps the sandbox awake; one that says idle does not", async () => {
  const { canvas } = await seedCanvas(db);
  await begin(canvas.id);
  await moveSandbox(db, { canvasId: canvas.id, from: ["waking"], to: "awake", now: at(1) });
  await takeRunnerLease(db, { canvasId: canvas.id, now: at(2) });
  const report = { status: null, artboards: [], claudeSessionId: null };

  await reportRunnerState(db, { canvasId: canvas.id, now: at(60), state: "working", ...report });
  expect((await getSandbox(db, canvas.id))!.lastActivityAt).toEqual(at(60));
  await reportRunnerState(db, { canvasId: canvas.id, now: at(90), state: "idle", ...report });
  expect((await getSandbox(db, canvas.id))!.lastActivityAt).toEqual(at(60));
});

test("the head shows waking and why it waits, and goes back to idle", async () => {
  const { canvas } = await seedCanvas(db);
  const head = async () => (await db.select().from(canvases).where(eq(canvases.id, canvas.id)))[0]!;

  await showAgentWaiting(db, { canvasId: canvas.id, waking: true, blocker: "sandbox_busy" });
  expect(await head()).toMatchObject({ agentState: "waking", agentBlocker: "sandbox_busy" });
  await showAgentWaiting(db, { canvasId: canvas.id, waking: false, blocker: "claude_expired" });
  expect(await head()).toMatchObject({ agentState: "idle", agentBlocker: "claude_expired" });
});

test("the wake context finds the owner's Claude for a canvas that records none", async () => {
  const { canvas, user, workspace } = await seedCanvas(db);
  const context = await getWakeContext(db, canvas.id);
  expect(context).toMatchObject({ canvasId: canvas.id, ownerId: user.id, claude: null });
  expect(context!.sandbox).toBeNull();
  // It says whether the owner is still in the canvas's workspace.
  expect(context!.ownerMember).toBe(false);
  await upsertMembership(db, { workspaceId: workspace.id, userId: user.id, role: "admin" });
  expect((await getWakeContext(db, canvas.id))!.ownerMember).toBe(true);
});

test("reconcile learns what each name's canvas and sign-in are", async () => {
  const { canvas } = await seedCanvas(db);
  await begin(canvas.id);
  const owners = await getSandboxOwners(db, {
    canvasIds: [canvas.id, "cnv_gone"],
    signInIds: ["auth_gone"],
  });
  expect(owners.canvases.get(canvas.id)).toMatchObject({
    exists: true,
    status: "active",
    sandbox: { state: "waking" },
  });
  expect(owners.canvases.get("cnv_gone")).toEqual({ exists: false, status: null, sandbox: null });
  expect(owners.signIns.get("auth_gone")).toEqual({
    exists: false,
    consumedAt: null,
    createdAt: null,
  });
});
