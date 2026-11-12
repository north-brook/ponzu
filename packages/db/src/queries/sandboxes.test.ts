import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { emptyDoc } from "@ponzu/core";
import { eq } from "drizzle-orm";
import { seedDesign } from "../fixtures.ts";
import { designs, usageEvents } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { upsertMembership } from "./accounts.ts";
import { createDesign, deleteDesign } from "./designs.ts";
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
const usageOf = (designId: string) =>
  db.select().from(usageEvents).where(eq(usageEvents.designId, designId));
const ROOMY = { perWorkspace: 100, perOwner: 100 };

/** The design's sandbox row, begun by the wake `by`. */
async function begin(designId: string, by = "job_a", now = at(0)): Promise<SandboxRow> {
  const claim = await beginSandbox(db, { designId, now, by, limits: ROOMY });
  if (!claim || "full" in claim) throw new Error("no sandbox was begun");
  return claim.sandbox;
}

describe("beginSandbox", () => {
  test("makes one row however many ask", async () => {
    const { design } = await seedDesign(db);
    const begun = await Promise.all(
      ["job_a", "job_b", "job_c"].map((by) =>
        beginSandbox(db, { designId: design.id, now: at(0), by, limits: ROOMY }),
      ),
    );
    const made = begun.flatMap((claim) => (claim && "sandbox" in claim ? [claim.sandbox] : []));
    expect(made).toHaveLength(1);
    expect(begun.filter((claim) => claim === null)).toHaveLength(2);
    expect(made[0]).toMatchObject({ designId: design.id, state: "waking", sessionId: null });
  });

  test("goes with its design", async () => {
    const { design } = await seedDesign(db);
    await begin(design.id);
    await deleteDesign(db, design.id);
    expect(await getSandbox(db, design.id)).toBeNull();
  });
});

describe("a wake's claim", () => {
  test("is the wake's alone while it holds it, and anyone's once it sat a lease", async () => {
    const { design } = await seedDesign(db);
    await begin(design.id, "job_a");
    const claim = (by: string, now: Date) =>
      claimSandbox(db, { designId: design.id, from: ["waking"], now, by, limits: ROOMY });
    const awake = (by: string, now: Date) =>
      moveSandbox(db, { designId: design.id, from: ["waking"], to: "awake", now, by });

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
      beginSandbox(db, { designId, now: at(0), by: "job", limits });

    expect(await start(first.id)).toMatchObject({ sandbox: { state: "waking" } });
    const second = await another(user.id);
    expect(await start(second.id)).toEqual({ full: true });
    const theirs = await another(teammate.id);
    expect(await start(theirs.id)).toMatchObject({ sandbox: { state: "waking" } });
    const third = await another(teammate.id);
    expect(await start(third.id)).toEqual({ full: true });

    // One goes to sleep, and the owner's next may start. A sleeping one takes no room.
    await moveSandbox(db, {
      designId: first.id,
      from: ["waking"],
      to: "asleep",
      now: at(1),
      by: "job",
    });
    expect(await start(second.id)).toMatchObject({ sandbox: { state: "waking" } });
    expect(
      await claimSandbox(db, {
        designId: first.id,
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
    await begin(design.id);
    const moves = await Promise.all([
      moveSandbox(db, { designId: design.id, from: ["waking"], to: "awake", now: at(5) }),
      moveSandbox(db, { designId: design.id, from: ["waking"], to: "asleep", now: at(5) }),
    ]);
    expect(moves.filter((move) => move !== null)).toHaveLength(1);
  });

  test("a repair moves only what nobody has moved since it looked", async () => {
    const { design } = await seedDesign(db);
    await begin(design.id, "job_a", at(0));
    await moveSandbox(db, {
      designId: design.id,
      from: ["waking"],
      to: "waking",
      now: at(30),
      by: "job_a",
    });
    expect(
      await moveSandbox(db, {
        designId: design.id,
        from: ["waking"],
        to: "asleep",
        now: at(400),
        stateBefore: at(1),
      }),
    ).toBeNull();
  });

  test("a retire takes the row from whoever holds it, and the holder's moves fail", async () => {
    const { design } = await seedDesign(db);
    await begin(design.id, "job_a", at(0));
    const held = await moveSandbox(db, {
      designId: design.id,
      from: ["asleep", "waking", "awake", "stopping"],
      to: "stopping",
      now: at(1),
      hold: "retire:job_r",
    });
    expect(held).toMatchObject({ state: "stopping", wakingBy: "retire:job_r" });
    expect(
      await moveSandbox(db, {
        designId: design.id,
        from: ["waking", "stopping"],
        to: "awake",
        now: at(2),
        by: "job_a",
      }),
    ).toBeNull();
    // Only the retire holding it deletes it.
    expect(await deleteSandboxRow(db, { designId: design.id, by: "job_a" })).toBe(false);
    expect(await deleteSandboxRow(db, { designId: design.id, by: "retire:job_r" })).toBe(true);
    expect(await getSandbox(db, design.id)).toBeNull();
  });

  test("records the session it is awake on, and forgets its address asleep", async () => {
    const { design } = await seedDesign(db);
    await begin(design.id);
    const awake = await moveSandbox(db, {
      designId: design.id,
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
      await setSandboxExpiry(db, { designId: design.id, sessionId: "sbx_0", expiresAt: at(9) }),
    ).toBe(false);
    expect(
      await setSandboxExpiry(db, { designId: design.id, sessionId: "sbx_1", expiresAt: at(3003) }),
    ).toBe(true);
    // A move pinned to another session does not happen.
    expect(
      await moveSandbox(db, {
        designId: design.id,
        from: ["awake"],
        to: "asleep",
        now: at(5),
        sessionId: "sbx_0",
      }),
    ).toBeNull();
    const asleep = await moveSandbox(db, {
      designId: design.id,
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
    const { design, user, workspace } = await seedDesign(db);
    await appendEvent(db, {
      designId: design.id,
      kind: "message",
      priority: "now",
      payload: { text: "hi" },
      userId: user.id,
    });
    await begin(design.id);
    const awake = await moveSandbox(db, {
      designId: design.id,
      from: ["waking"],
      to: "awake",
      now: at(4),
      changes: { sessionId: "sbx_1", address: "https://sb-1.vercel.run" },
    });
    expect(awake).toMatchObject({ state: "awake", awakeSince: at(4), sessionId: "sbx_1" });

    await moveSandbox(db, { designId: design.id, from: ["awake"], to: "stopping", now: at(304) });
    // A second move out of awake, as from a racing sweep, finds nothing to meter.
    await moveSandbox(db, {
      designId: design.id,
      from: ["awake", "stopping"],
      to: "asleep",
      now: at(306),
    });
    const [used] = await usageOf(design.id);
    expect(used).toMatchObject({
      id: `${design.id}/${at(4).getTime()}`,
      workspaceId: workspace.id,
      userId: user.id,
      kind: "sandbox",
      seconds: 300,
      payer: "ponzu",
      credits: 0,
      occurredAt: at(4),
    });

    await moveSandbox(db, { designId: design.id, from: ["asleep"], to: "waking", now: at(900) });
    await moveSandbox(db, { designId: design.id, from: ["waking"], to: "awake", now: at(901) });
    // A restart in place meters what was awake, and the next awake starts a new stretch.
    await moveSandbox(db, { designId: design.id, from: ["awake"], to: "waking", now: at(961) });
    await moveSandbox(db, { designId: design.id, from: ["waking"], to: "awake", now: at(962) });
    await moveSandbox(db, { designId: design.id, from: ["awake"], to: "asleep", now: at(1022) });
    expect((await usageOf(design.id)).map((use) => use.seconds).sort()).toEqual([300, 60, 60]);
  });

  test("a stop that is not idle any more does not happen", async () => {
    const { design } = await seedDesign(db);
    await begin(design.id);
    await moveSandbox(db, { designId: design.id, from: ["waking"], to: "awake", now: at(1) });
    await touchSandbox(db, { designId: design.id, now: at(250) });
    const stopped = await moveSandbox(db, {
      designId: design.id,
      from: ["awake"],
      to: "stopping",
      now: at(400),
      idleBefore: at(100),
    });
    expect(stopped).toBeNull();
    expect((await getSandbox(db, design.id))!.lastActivityAt).toEqual(at(250));
  });
});

test("a heartbeat that says working keeps the sandbox awake; one that says idle does not", async () => {
  const { design } = await seedDesign(db);
  await begin(design.id);
  await moveSandbox(db, { designId: design.id, from: ["waking"], to: "awake", now: at(1) });
  await takeRunnerLease(db, { designId: design.id, now: at(2) });
  const report = { status: null, artboards: [], claudeSessionId: null };

  await reportRunnerState(db, { designId: design.id, now: at(60), state: "working", ...report });
  expect((await getSandbox(db, design.id))!.lastActivityAt).toEqual(at(60));
  await reportRunnerState(db, { designId: design.id, now: at(90), state: "idle", ...report });
  expect((await getSandbox(db, design.id))!.lastActivityAt).toEqual(at(60));
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
  // It says whether the owner is still in the design's workspace.
  expect(context!.ownerMember).toBe(false);
  await upsertMembership(db, { workspaceId: workspace.id, userId: user.id, role: "admin" });
  expect((await getWakeContext(db, design.id))!.ownerMember).toBe(true);
});

test("reconcile learns what each name's design and sign-in are", async () => {
  const { design } = await seedDesign(db);
  await begin(design.id);
  const owners = await getSandboxOwners(db, {
    designIds: [design.id, "des_gone"],
    signInIds: ["auth_gone"],
  });
  expect(owners.designs.get(design.id)).toMatchObject({
    exists: true,
    status: "active",
    sandbox: { state: "waking" },
  });
  expect(owners.designs.get("des_gone")).toEqual({ exists: false, status: null, sandbox: null });
  expect(owners.signIns.get("auth_gone")).toEqual({
    exists: false,
    consumedAt: null,
    createdAt: null,
  });
});
