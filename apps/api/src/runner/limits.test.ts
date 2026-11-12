import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sampleDoc } from "@ponzu/core/fixtures";
import { appendEvent, getCanvas, getSandbox, newId } from "@ponzu/db";
import { type ClaudeLimitReport, RUNNER_HEADER } from "@ponzu/runner/protocol";
import { canvasSandboxName } from "@ponzu/sandbox";
import { AT_A_CLAUDE_LIMIT, LIMIT_GRACE_MS } from "../sandboxes/gates.ts";
import { WAKE_JOB } from "../sandboxes/orchestrate.ts";
import { call, canvasIn, type Workspace, workspaceWithRepo } from "../testing/canvases.ts";
import { createTestApp, TEST_CRON_SECRET, TEST_SCOPE, type TestApp } from "../testing/index.ts";
import { MAX_RESET_AHEAD_MS } from "./limits.ts";

/*
 * Claude plan limits end to end on the API (docs/cloud.md, "Claude plan limits"): a runner on a
 * subscription reports what Claude Code said with its state; the account keeps it, only from a
 * runner on its current credential; canvases on it wait for everyone until the reset, their
 * wakes put off to just after it; and Settings reads the windows. On PGlite, the fake sandboxes
 * and the test's clock.
 */

let t: TestApp;
let ws: Workspace;
const KEY = "sk-ant-api03-maya-limits-key-000000000";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

beforeAll(async () => {
  t = await createTestApp();
  ws = await workspaceWithRepo(t, { maya: "write", ines: "write" });
  t.anthropic.keys.add(KEY);
  const connected = await call(t, await as("maya"), "POST", "/v1/claude/api-key", { key: KEY });
  expect(connected.status).toBe(200);
  await t.backgroundDone();
  await subscription(true);
});
afterAll(() => t.close());

const as = async (login: string) => (await t.signInAs({ login })).headers;
const fresh = () => canvasIn(t, ws, "maya", sampleDoc());
const head = async (canvasId: string) => (await getCanvas(t.db, canvasId))!;
const nameOf = (canvasId: string) => canvasSandboxName(TEST_SCOPE, canvasId);
const mayaId = () => ws.people.maya!.userId;

async function rows(statement: string): Promise<Record<string, unknown>[]> {
  return ((await t.db.execute(statement)) as unknown as { rows: Record<string, unknown>[] }).rows;
}

/**
 * Maya's Claude as a subscription, or back to an API key. Signing in through claude.ai takes a
 * sandbox of its own (claude.test.ts covers it); what matters here is the row's kind.
 */
async function subscription(on: boolean) {
  await t.db.execute(
    `update claude_accounts set kind = '${on ? "subscription" : "api_key"}' where user_id = '${mayaId()}'`,
  );
}

/** Forget what the plan said: each test starts from a plan with no limit known. */
async function clearLimits() {
  await t.db.execute(
    `update claude_accounts set limits = null, limits_observed_at = null, limited_until = null where user_id = '${mayaId()}'`,
  );
}

async function account() {
  const [row] = await rows(
    `select id, limits, limited_until from claude_accounts where user_id = '${mayaId()}'`,
  );
  return row as { id: string; limits: unknown; limited_until: string | Date | null };
}

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

const wakeJobs = (canvasId: string) =>
  rows(`select attempts, run_at, completed_at from jobs
         where kind = '${WAKE_JOB}' and key = '${canvasId}' order by created_at`);

/** The runner the canvas's last start started, holding its lease. */
async function runnerIn(canvasId: string) {
  const starts = t.sandboxes.commands(nameOf(canvasId)).filter((c) => c.kind === "start");
  const token = starts.at(-1)!.command.env!.PONZU_RUNNER_TOKEN!;
  const started = await call(t, { authorization: `Bearer ${token}` }, "POST", "/v1/runner/session");
  expect(started.status).toBe(200);
  const headers = { authorization: `Bearer ${token}`, [RUNNER_HEADER]: started.body.runnerId };
  const state = async (claudeLimit?: ClaudeLimitReport) => {
    const put = await call(t, headers, "PUT", "/v1/runner/state", {
      state: "idle",
      status: null,
      artboards: [],
      claudeSessionId: "session-1",
      ...(claudeLimit ? { claudeLimit } : {}),
    });
    await t.backgroundDone();
    return put;
  };
  const claim = async () => {
    const claimed = await call(t, headers, "POST", "/v1/runner/events/claim", {
      claimId: newId("clm"),
    });
    expect(claimed.status).toBe(200);
    return (claimed.body.events as { id: string; kind: string }[]).map((e) => e.kind);
  };
  return { state, claim };
}

/** A canvas of Maya's awake, its runner in, everything it was sent taken up. */
async function awake() {
  const canvas = await fresh();
  await say(canvas.id);
  expect((await getSandbox(t.db, canvas.id))!.state).toBe("awake");
  const runner = await runnerIn(canvas.id);
  await runner.state();
  await runner.claim();
  return { canvas, runner };
}

const rejected = (resetsAt: Date, window = "five_hour"): ClaudeLimitReport => ({
  status: "rejected",
  window,
  resetsAt: resetsAt.toISOString(),
  utilization: 1,
});

describe("a limit a runner reports", () => {
  test("is kept on the account, window by window, and Settings reads it", async () => {
    await clearLimits();
    const { runner } = await awake();
    const resets = new Date(t.clock.now() + 2 * HOUR);
    const week = new Date(t.clock.now() + 4 * 24 * HOUR);

    expect((await runner.state(rejected(resets))).status).toBe(200);
    expect(
      (
        await runner.state({
          status: "allowed_warning",
          window: "seven_day",
          resetsAt: week.toISOString(),
          utilization: 0.8,
        })
      ).status,
    ).toBe(200);

    const got = await call(t, await as("maya"), "GET", "/v1/claude");
    expect(got.body.account.limits).toEqual([
      { window: "five_hour", utilization: 1, resetsAt: resets.toISOString() },
      { window: "seven_day", utilization: 0.8, resetsAt: week.toISOString() },
    ]);
    // A warning lets requests through: nothing waits. (It cleared what the rejection set.)
    expect(got.body.account.limitedUntil).toBeNull();

    // The same window again replaces what was kept of it.
    await runner.state(rejected(resets));
    const again = await call(t, await as("maya"), "GET", "/v1/claude");
    expect(again.body.account.limits.map((l: { window: string }) => l.window)).toEqual([
      "seven_day",
      "five_hour",
    ]);
    expect(again.body.account.limitedUntil).toBe(resets.toISOString());
    // `/v1/me` says the same.
    const me = await call(t, await as("maya"), "GET", "/v1/me");
    expect(me.body.claudeAccount.limitedUntil).toBe(resets.toISOString());
    expect(t.logs.findLast((l) => l.event === "claude_limit_reported")).toMatchObject({
      status: "rejected",
      window: "five_hour",
      kept: true,
    });
  });

  test("from a sandbox on an older credential is ignored", async () => {
    await clearLimits();
    const { runner } = await awake();
    // Maya connected again since this sandbox started: its credential is not the account's now.
    await t.db.execute(
      `update claude_accounts set connected_at = connected_at + interval '1 second' where user_id = '${mayaId()}'`,
    );
    expect((await runner.state(rejected(new Date(t.clock.now() + HOUR)))).status).toBe(200);
    expect(await account()).toMatchObject({ limits: null, limited_until: null });
    expect(t.logs.findLast((l) => l.event === "claude_limit_reported")).toMatchObject({
      kept: false,
    });
  });

  test("on an API key is ignored, and Settings shows no limits for one", async () => {
    await clearLimits();
    const { runner } = await awake();
    await subscription(false);
    try {
      await runner.state(rejected(new Date(t.clock.now() + HOUR)));
      expect(await account()).toMatchObject({ limits: null, limited_until: null });
      const got = await call(t, await as("maya"), "GET", "/v1/claude");
      expect(got.body.account.limits).toBeNull();
    } finally {
      await subscription(true);
    }
  });

  test("with a reset further off than any window holds no canvas", async () => {
    await clearLimits();
    const { runner } = await awake();
    const later = new Date(t.clock.now() + MAX_RESET_AHEAD_MS + MINUTE);
    expect((await runner.state(rejected(later))).status).toBe(200);
    expect(await account()).toMatchObject({ limited_until: null });
    const got = await call(t, await as("maya"), "GET", "/v1/claude");
    expect(got.body.account.limits).toEqual([
      { window: "five_hour", utilization: 1, resetsAt: null },
    ]);
    // A week off is believed.
    const week = new Date(t.clock.now() + 7 * 24 * HOUR);
    await runner.state(rejected(week, "seven_day"));
    expect(new Date((await account()).limited_until!).getTime()).toBe(week.getTime());
    await clearLimits();
  });

  test("is refused when it is not the protocol's shape", async () => {
    const { runner } = await awake();
    const bad = await runner.state({
      status: "maybe",
      window: null,
      resetsAt: null,
      utilization: null,
    } as unknown as ClaudeLimitReport);
    expect(bad.status).toBe(400);
  });
});

describe("a plan at its limit", () => {
  test("puts a wake off until just after the reset, says so on the head, then wakes", async () => {
    await clearLimits();
    const { runner } = await awake();
    const resets = new Date(t.clock.now() + 2 * HOUR);
    await runner.state(rejected(resets));

    // Another canvas of Maya's: it waits for everyone, never claiming a sandbox.
    const other = await fresh();
    await say(other.id, "And the footer");
    expect(await getSandbox(t.db, other.id)).toBeNull();
    const retryAt = resets.getTime() + LIMIT_GRACE_MS;
    expect(await head(other.id)).toMatchObject({
      agentBlocker: "claude_limited",
      agentBlockedUntil: new Date(retryAt),
    });
    const [job, ...more] = await wakeJobs(other.id);
    expect(more).toEqual([]);
    expect(job).toMatchObject({ attempts: 1, completed_at: null });
    expect(new Date(job!.run_at as string).getTime()).toBe(retryAt);

    // An hour on it still waits: the cron leaves the wake be.
    t.clock.advance(HOUR);
    await cron();
    expect(await getSandbox(t.db, other.id)).toBeNull();

    // Past the reset and the grace, the same wake runs and clears the line.
    t.clock.advance(HOUR + LIMIT_GRACE_MS);
    await cron();
    expect((await getSandbox(t.db, other.id))!.state).toBe("awake");
    expect(await head(other.id)).toMatchObject({ agentBlocker: null, agentBlockedUntil: null });
    expect(await wakeJobs(other.id)).toHaveLength(1);
  });

  test("holds back what would begin a turn from a runner still awake, and hands it out at the reset", async () => {
    await clearLimits();
    const { canvas, runner } = await awake();
    const resets = new Date(t.clock.now() + HOUR);
    await runner.state(rejected(resets));

    await say(canvas.id, "Try again");
    for (const kind of ["edit", "stop"] as const) {
      await appendEvent(t.db, {
        canvasId: canvas.id,
        kind,
        priority: kind === "stop" ? "now" : "later",
        payload: {},
      });
    }
    expect(AT_A_CLAUDE_LIMIT).toEqual(["stop", "edit", "push"]);
    expect((await runner.claim()).sort()).toEqual(["edit", "stop"]);
    // The canvas's line says it waits; a turn already running is never cut.
    expect(await head(canvas.id)).toMatchObject({ agentBlocker: "claude_limited" });

    t.clock.advance(HOUR + LIMIT_GRACE_MS);
    expect(await runner.claim()).toEqual(["message"]);
    await cron();
    expect(await head(canvas.id)).toMatchObject({ agentBlocker: null, agentBlockedUntil: null });
  });

  test("is lifted early when a runner says the plan's requests go through again", async () => {
    await clearLimits();
    const { runner } = await awake();
    await runner.state(rejected(new Date(t.clock.now() + 3 * HOUR)));
    const other = await fresh();
    await say(other.id);
    expect(await head(other.id)).toMatchObject({ agentBlocker: "claude_limited" });

    await runner.state({
      status: "allowed",
      window: "five_hour",
      resetsAt: new Date(t.clock.now() + 3 * HOUR).toISOString(),
      utilization: 0.1,
    });
    expect(await account()).toMatchObject({ limited_until: null });
    // The wake that was put off is due now, and the cron runs it.
    await cron();
    expect(await head(other.id)).toMatchObject({ agentBlocker: null, agentBlockedUntil: null });
    expect((await getSandbox(t.db, other.id))!.state).toBe("awake");
  });

  test("is forgotten when its owner connects Claude again", async () => {
    await clearLimits();
    const { runner } = await awake();
    await runner.state(rejected(new Date(t.clock.now() + HOUR)));
    const key = "sk-ant-api03-maya-limits-again-0000000";
    t.anthropic.keys.add(key);
    const again = await call(t, await as("maya"), "POST", "/v1/claude/api-key", { key });
    expect(again.status).toBe(200);
    await t.backgroundDone();
    expect(again.body.account.limitedUntil).toBeNull();
    expect(await account()).toMatchObject({ limits: null, limited_until: null });
    await subscription(true);
  });
});
