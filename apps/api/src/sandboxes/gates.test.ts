import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sampleDoc } from "@ponzu/core/fixtures";
import {
  type AgentBlocker,
  appendEvent,
  getCanvas,
  getSandbox,
  getWakeContext,
  type WakeContext,
} from "@ponzu/db";
import { canvasSandboxName } from "@ponzu/sandbox";
import { call, canvasIn, type Workspace, workspaceWithRepo } from "../testing/canvases.ts";
import { createTestApp, TEST_CRON_SECRET, TEST_SCOPE, type TestApp } from "../testing/index.ts";
import {
  askWakeGates,
  claimableKinds,
  claudeGate,
  type NamedWakeGate,
  ownerGate,
  WAKE_GATES,
  type WakeGate,
} from "./gates.ts";
import { WAKE_JOB, wakeCanvas } from "./orchestrate.ts";
import { RESUME_AT_ONCE, resumeBlocked } from "./wake.ts";

/*
 * The wake gates: asked in order before a wake claims the sandbox's row, the first refusal
 * deciding, and `resumeBlocked` for when what a gate waited on has changed. On PGlite, the fake
 * sandboxes and the test's clock.
 */

let t: TestApp;
let ws: Workspace;
const KEY = "sk-ant-api03-maya-gates-key-00000000000";
const MINUTE = 60_000;

beforeAll(async () => {
  t = await createTestApp();
  ws = await workspaceWithRepo(t, { maya: "write" });
  t.anthropic.keys.add(KEY);
  const connected = await call(t, await as("maya"), "POST", "/v1/claude/api-key", { key: KEY });
  expect(connected.status).toBe(200);
  await t.backgroundDone();
});
afterAll(() => t.close());

const as = async (login: string) => (await t.signInAs({ login })).headers;
const fresh = (workspace = ws) => canvasIn(t, workspace, "maya", sampleDoc());
const head = async (canvasId: string) => (await getCanvas(t.db, canvasId))!;
const nameOf = (canvasId: string) => canvasSandboxName(TEST_SCOPE, canvasId);

async function say(canvasId: string, text = "Make the header calmer") {
  const said = await call(t, await as("maya"), "POST", `/v1/canvases/${canvasId}/messages`, {
    text,
  });
  expect(said.status).toBe(201);
  await t.backgroundDone();
}

async function cron() {
  const ran = await t.app.request("/v1/cron/minute", {
    headers: { authorization: `Bearer ${TEST_CRON_SECRET}` },
  });
  expect(ran.status).toBe(200);
  await t.backgroundDone();
}

async function rows(statement: string): Promise<Record<string, unknown>[]> {
  return ((await t.db.execute(statement)) as unknown as { rows: Record<string, unknown>[] }).rows;
}

const wakeJobs = (canvasId: string) =>
  rows(`select attempts, run_at, completed_at, failed_at, payload from jobs
         where kind = '${WAKE_JOB}' and key = '${canvasId}' order by created_at`);

/** Fill one of the wake's own gates for the length of a test, as its feature will. */
async function filling<T>(name: string, gate: WakeGate, run: () => Promise<T>): Promise<T> {
  const slot = WAKE_GATES.find((g) => g.name === name)! as { gate: WakeGate };
  const was = slot.gate;
  slot.gate = gate;
  try {
    return await run();
  } finally {
    slot.gate = was;
  }
}

/** A canvas's head made to say it waits on `blocker`, as a gate would have left it. */
async function block(canvasId: string, blocker: AgentBlocker) {
  await t.db.execute(`update canvases set agent_blocker = '${blocker}' where id = '${canvasId}'`);
}

/** Something in the feed its agent must take up, written without waking anything. */
async function owe(canvasId: string) {
  await appendEvent(t.db, {
    canvasId,
    kind: "message",
    priority: "now",
    payload: { text: "Waiting for you" },
  });
}

describe("the gates", () => {
  const context = (over: Partial<WakeContext> = {}): WakeContext => ({
    canvasId: "cnv_1",
    workspaceId: "ws_1",
    status: "active",
    ownerId: "usr_1",
    claude: null,
    sandbox: null,
    ownerMember: true,
    agentBlocker: null,
    agentBlockedUntil: null,
    ...over,
  });
  const now = new Date("2026-11-12T12:00:00Z");
  const ask = () => ({ deps: t.deps, reason: "message" });

  test("are asked in order, and the first that refuses stops the rest", () => {
    const later = new Date(now.getTime() + MINUTE);
    const table: {
      answers: ({ blocker: AgentBlocker; retryAt?: Date } | null)[];
      decided: { gate: string; blocker: AgentBlocker; retryAt?: Date } | null;
      asked: string[];
    }[] = [
      { answers: [null, null, null], decided: null, asked: ["a", "b", "c"] },
      {
        answers: [{ blocker: "paused", retryAt: later }, { blocker: "cap_reached" }, null],
        decided: { gate: "a", blocker: "paused", retryAt: later },
        asked: ["a"],
      },
      {
        answers: [null, { blocker: "cap_reached" }, { blocker: "claude_limited" }],
        decided: { gate: "b", blocker: "cap_reached" },
        asked: ["a", "b"],
      },
      {
        answers: [null, null, { blocker: "claude_limited", retryAt: later }],
        decided: { gate: "c", blocker: "claude_limited", retryAt: later },
        asked: ["a", "b", "c"],
      },
    ];
    for (const { answers, decided, asked } of table) {
      const seen: string[] = [];
      const gates: NamedWakeGate[] = ["a", "b", "c"].map((name, i) => ({
        name,
        gate: () => {
          seen.push(name);
          return answers[i]!;
        },
      }));
      expect(askWakeGates(context(), now, ask(), gates)).toEqual(decided);
      expect(seen).toEqual(asked);
    }
  });

  test("the wake's are the owner, Claude, maintenance, billing and Claude's limit, in that order", () => {
    expect(WAKE_GATES.map((g) => g.name)).toEqual([
      "owner",
      "claude",
      "maintenance",
      "billing",
      "claudeLimit",
    ]);
    // The three a feature fills let everything through until it does.
    const connected = context({
      claude: {
        id: "cla_1",
        userId: "usr_1",
        kind: "api_key",
        status: "connected",
        connectedAt: now,
        expiresAt: null,
        encryptedCredential: "sealed",
      },
    });
    expect(askWakeGates(connected, now, ask())).toBeNull();
  });

  test("an owner who left says so whatever their Claude's state, as the wake always has", () => {
    expect(ownerGate(context({ ownerMember: false }), now, ask())).toEqual({
      blocker: "claude_owner_left",
    });
    expect(askWakeGates(context({ ownerMember: false }), now, ask())).toMatchObject({
      gate: "owner",
      blocker: "claude_owner_left",
    });
    expect(claudeGate(context(), now, ask())).toEqual({ blocker: "claude_not_connected" });
  });

  test("a claim may hand out every kind until a feature narrows it", async () => {
    expect(await claimableKinds(t.deps, { canvasId: "cnv_1" })).toBe("all");
  });
});

describe("a wake a gate refuses", () => {
  test("never claims the sandbox, says why on the head, and asks no gate after it", async () => {
    const canvas = await fresh();
    let after = 0;
    await filling(
      "claudeLimit",
      () => {
        after++;
        return null;
      },
      () =>
        filling(
          "billing",
          () => ({ blocker: "cap_reached" }),
          () => say(canvas.id),
        ),
    );

    expect(after).toBe(0);
    expect(await getSandbox(t.db, canvas.id)).toBeNull();
    expect(t.sandboxes.commands(nameOf(canvas.id))).toEqual([]);
    expect(await head(canvas.id)).toMatchObject({
      agentBlocker: "cap_reached",
      agentBlockedUntil: null,
      agentState: "idle",
    });
    // Without a time to try again, the wake is over: what the gate waits on resumes it.
    const [job] = await wakeJobs(canvas.id);
    expect(job!.completed_at).not.toBeNull();
    expect(t.logs.findLast((l) => l.event === "wake_blocked" && l.canvasId === canvas.id)).toEqual(
      expect.objectContaining({ blocker: "cap_reached" }),
    );
  });

  test("with a time to try again is put off to then, once, and wakes when the gate lets it", async () => {
    const canvas = await fresh();
    const retryAt = new Date(t.clock.now() + 10 * MINUTE);
    // Claude's limit, not maintenance: the cron lifts `paused` whenever the switch is off.
    await filling(
      "claudeLimit",
      () => ({ blocker: "claude_limited", retryAt }),
      async () => {
        await say(canvas.id);
        expect(await head(canvas.id)).toMatchObject({
          agentBlocker: "claude_limited",
          agentBlockedUntil: retryAt,
        });
        const [job, ...more] = await wakeJobs(canvas.id);
        expect(more).toEqual([]);
        expect(job).toMatchObject({ attempts: 1, completed_at: null, failed_at: null });
        expect(new Date(job!.run_at as string).getTime()).toBe(retryAt.getTime());

        // A minute on, the cron leaves it be: it is not due.
        t.clock.advance(MINUTE);
        await cron();
        expect((await wakeJobs(canvas.id))[0]).toMatchObject({ attempts: 1, completed_at: null });
        expect(await getSandbox(t.db, canvas.id)).toBeNull();
      },
    );

    // The switch is off by then. At the time the gate said, the same wake runs, once.
    t.clock.advance(10 * MINUTE);
    await cron();
    const [job, ...more] = await wakeJobs(canvas.id);
    expect(more).toEqual([]);
    expect(job).toMatchObject({ attempts: 2 });
    expect(job!.completed_at).not.toBeNull();
    expect((await getSandbox(t.db, canvas.id))!.state).toBe("awake");
    expect(await head(canvas.id)).toMatchObject({ agentBlocker: null, agentBlockedUntil: null });
  });

  test("on its last attempt is over, not put off again", async () => {
    const canvas = await fresh();
    const retryAt = new Date(t.clock.now() + MINUTE);
    await filling(
      "maintenance",
      () => ({ blocker: "paused", retryAt }),
      () => wakeCanvas(t.deps, canvas.id, { id: "job_last_gate", attempts: 40, maxAttempts: 40 }),
    );
    expect(await head(canvas.id)).toMatchObject({ agentBlocker: "paused" });
    expect(await getSandbox(t.db, canvas.id)).toBeNull();
  });

  test("leaves a turn already running to finish, and a later wake lifts what the gate said", async () => {
    const canvas = await fresh();
    await say(canvas.id);
    expect((await getSandbox(t.db, canvas.id))!.state).toBe("awake");
    await t.db.execute(`update canvases set agent_state = 'working' where id = '${canvas.id}'`);

    await filling(
      "billing",
      () => ({ blocker: "cap_reached" }),
      () => say(canvas.id, "And the footer"),
    );
    // The gate's line shows, but the turn the runner is in is not said to have stopped.
    expect(await head(canvas.id)).toMatchObject({
      agentBlocker: "cap_reached",
      agentState: "working",
    });
    expect((await getSandbox(t.db, canvas.id))!.state).toBe("awake");

    // The gate lets it through now. The sandbox is awake already, so the wake has nothing to
    // start, and lifting the stale blocker is all that clears the line.
    await say(canvas.id, "Now the nav");
    expect(await head(canvas.id)).toMatchObject({ agentBlocker: null, agentBlockedUntil: null });
  });

  test("is told the wake's reason", async () => {
    const canvas = await fresh();
    const reasons: (string | null)[] = [];
    await filling(
      "billing",
      (_ctx, _now, ask) => {
        reasons.push(ask.reason);
        return { blocker: "payment_failed" };
      },
      () => say(canvas.id),
    );
    expect(reasons).toEqual(["message"]);
  });
});

describe("resumeBlocked", () => {
  test("wakes up to 20 canvases with something owed, queues the rest, and only lifts the others", async () => {
    const billing: AgentBlocker[] = ["credits_used_up", "cap_reached", "payment_failed"];
    const team = await workspaceWithRepo(t, { maya: "write" });
    const owed: string[] = [];
    for (let i = 0; i < RESUME_AT_ONCE + 2; i++) {
      const canvas = await fresh(team);
      await block(canvas.id, i % 2 ? "cap_reached" : "credits_used_up");
      await owe(canvas.id);
      // The first made is the most recently active.
      await t.db.execute(
        `update canvases set last_activity_at = now() - interval '${i} minutes' where id = '${canvas.id}'`,
      );
      owed.push(canvas.id);
    }
    const nothingOwed = await fresh(team);
    await block(nothingOwed.id, "payment_failed");
    const paused = await fresh(team);
    await block(paused.id, "paused");
    await owe(paused.id);
    const elsewhere = await workspaceWithRepo(t, { maya: "write" });
    const other = await fresh(elsewhere);
    await block(other.id, "cap_reached");
    await owe(other.id);

    const resumed = await resumeBlocked(t.deps, { workspaceId: team.id, blockers: billing });
    await t.backgroundDone();

    expect(resumed).toEqual({ lifted: RESUME_AT_ONCE + 3, started: RESUME_AT_ONCE, queued: 2 });
    for (const [i, canvasId] of owed.entries()) {
      const [job, ...more] = await wakeJobs(canvasId);
      expect(more).toEqual([]);
      expect(job!.payload).toMatchObject({ reason: "resume" });
      // The two least recently active wait for the cron; the rest were run at once.
      expect(job!.attempts).toBe(i < RESUME_AT_ONCE ? 1 : 0);
      expect((await head(canvasId)).agentBlocker).not.toBe("cap_reached");
    }
    // Nothing owed: lifted, and nothing woken.
    expect(await head(nothingOwed.id)).toMatchObject({ agentBlocker: null });
    expect(await wakeJobs(nothingOwed.id)).toEqual([]);
    // Another blocker, or another workspace: left as they were.
    expect((await head(paused.id)).agentBlocker).toBe("paused");
    expect(await wakeJobs(paused.id)).toEqual([]);
    expect((await head(other.id)).agentBlocker).toBe("cap_reached");
    expect(await wakeJobs(other.id)).toEqual([]);
  });

  test("on a Claude account brings forward the wake a gate put off, and the cron runs it", async () => {
    const canvas = await fresh();
    const until = new Date(t.clock.now() + 60 * MINUTE);
    await filling(
      "claudeLimit",
      () => ({ blocker: "claude_limited", retryAt: until }),
      () => say(canvas.id),
    );
    expect(await head(canvas.id)).toMatchObject({
      agentBlocker: "claude_limited",
      agentBlockedUntil: until,
    });
    const accountId = (await getWakeContext(t.db, canvas.id))!.claude!.id;

    const resumed = await resumeBlocked(t.deps, { accountId, blockers: ["claude_limited"] });
    expect(resumed).toMatchObject({ lifted: 1, started: 0, queued: 1 });
    expect(await head(canvas.id)).toMatchObject({ agentBlocker: null, agentBlockedUntil: null });
    const [job] = await wakeJobs(canvas.id);
    expect(new Date(job!.run_at as string).getTime()).toBe(t.clock.now());

    await cron();
    expect((await getSandbox(t.db, canvas.id))!.state).toBe("awake");
    expect(await wakeJobs(canvas.id)).toHaveLength(1);
  });

  test("never wakes a canvas whose feed holds nothing its agent must take up", async () => {
    const quiet = await workspaceWithRepo(t, { maya: "write" });
    const canvas = await fresh(quiet);
    await block(canvas.id, "paused");
    // A person's edit is in the feed, but it starts no turn.
    await appendEvent(t.db, {
      canvasId: canvas.id,
      kind: "edit",
      priority: "later",
      payload: {},
    });
    const resumed = await resumeBlocked(t.deps, { workspaceId: quiet.id, blockers: ["paused"] });
    expect(resumed).toEqual({ lifted: 1, started: 0, queued: 0 });
    expect(await wakeJobs(canvas.id)).toEqual([]);
    expect((await head(canvas.id)).agentBlocker).toBeNull();
  });
});
