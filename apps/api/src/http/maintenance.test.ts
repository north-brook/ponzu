import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sampleDoc } from "@ponzu/core/fixtures";
import { appendEvent, getCanvas, getSandbox, listThreadItems } from "@ponzu/db";
import type { Features } from "../features.ts";
import { MAINTENANCE_RETRY_MS, maintenanceGate } from "../sandboxes/gates.ts";
import { wakeCanvas } from "../sandboxes/orchestrate.ts";
import {
  call,
  canvasIn,
  startRunner,
  type Workspace,
  workspaceWithRepo,
} from "../testing/canvases.ts";
import { createTestApp, TEST_CRON_SECRET, type TestApp } from "../testing/index.ts";
import { askSteerGates, type SteerRequest } from "./gates.ts";
import { MAINTENANCE_MESSAGE, passesReadOnly } from "./maintenance.ts";

/*
 * The maintenance switch, PONZU_MAINTENANCE (production design §1.5): wakes paused, and read
 * only. One app on PGlite, the fake sandboxes and the test's clock; each test sets the switch
 * as a deployment's environment would, and it is read on every request and every wake.
 */

let t: TestApp;
let ws: Workspace;
const KEY = "sk-ant-api03-maya-maintenance-key-0000000";

beforeAll(async () => {
  t = await createTestApp();
  ws = await workspaceWithRepo(t, { maya: "write" });
  t.anthropic.keys.add(KEY);
  const connected = await call(t, await as("maya"), "POST", "/v1/claude/api-key", { key: KEY });
  expect(connected.status).toBe(200);
  await t.backgroundDone();
});
afterAll(() => t.close());
beforeEach(() => switchTo("off"));

function switchTo(mode: Features["maintenance"]) {
  t.deps.features.maintenance = mode;
}

const as = async (login: string) => (await t.signInAs({ login })).headers;
const fresh = () => canvasIn(t, ws, "maya", sampleDoc());
const head = async (canvasId: string) => (await getCanvas(t.db, canvasId))!;

async function cron() {
  const ran = await t.app.request("/v1/cron/minute", {
    headers: { authorization: `Bearer ${TEST_CRON_SECRET}` },
  });
  expect(ran.status).toBe(200);
  await t.backgroundDone();
  return (await ran.json()) as { steps: Record<string, Record<string, number>> };
}

async function wakeJobs(canvasId: string) {
  const answer = (await t.db.execute(
    `select attempts, run_at, completed_at, failed_at from jobs
      where kind = 'sandbox.wake' and key = '${canvasId}' order by created_at`,
  )) as unknown as { rows: Record<string, unknown>[] };
  return answer.rows;
}

const refusal = { error: { code: "maintenance", message: MAINTENANCE_MESSAGE } };

describe("what passes while Ponzu is read-only", () => {
  test("reads, health, the cron, sign-in, presence and a runner's heartbeat and saves; no other write", () => {
    const table: [method: string, path: string, passes: boolean][] = [
      ["GET", "/v1/canvases/cnv_1", true],
      ["HEAD", "/v1/canvases/cnv_1", true],
      ["OPTIONS", "/v1/canvases", true],
      ["GET", "/v1/health", true],
      ["POST", "/v1/health", true],
      ["GET", "/v1/cron/minute", true],
      ["POST", "/v1/auth/exchange", true],
      ["POST", "/v1/auth/sign-out", true],
      ["POST", "/v1/live", true],
      ["POST", "/v1/github/webhook", true],
      ["PUT", "/v1/canvases/cnv_1/presence", true],
      ["DELETE", "/v1/canvases/cnv_1/presence", true],
      ["POST", "/v1/runner/session", true],
      ["PUT", "/v1/runner/state", true],
      ["PUT", "/v1/runner/state/", true],
      ["POST", "/v1/runner/checkpoint", true],
      ["POST", "/v1/runner/restore", true],
      ["POST", "/v1/runner/restored", true],
      ["POST", "/v1/runner/uploads", true],
      ["POST", "/v1/runner/git-credential", true],
      ["POST", "/v1/runner/git-credential/erase", true],
      // A prefix is a whole segment: these only begin like one that passes.
      ["POST", "/v1/healthz", false],
      ["POST", "/v1/cronjob", false],
      ["POST", "/v1/canvases", false],
      ["POST", "/v1/canvases/cnv_1/messages", false],
      ["POST", "/v1/canvases/cnv_1/questions/q_1/answer", false],
      ["PATCH", "/v1/canvases/cnv_1", false],
      ["DELETE", "/v1/canvases/cnv_1", false],
      ["POST", "/v1/canvases/cnv_1/ops", false],
      ["POST", "/v1/canvases/cnv_1/presence", false],
      ["PUT", "/v1/canvases/cnv_1/presence/x", false],
      ["POST", "/v1/runner/thread", false],
      ["POST", "/v1/runner/events/claim", false],
      ["POST", "/v1/runner/events/ack", false],
      ["POST", "/v1/runner/questions", false],
      ["POST", "/v1/runner/usage", false],
      ["POST", "/v1/runner/models", false],
      ["POST", "/v1/runner/uploads/complete", false],
      ["POST", "/v1/runner/pull-request/merge", false],
      ["DELETE", "/v1/me", false],
      ["PATCH", "/v1/claude/defaults", false],
      ["POST", "/v1/github/sync", false],
    ];
    for (const [method, path, passes] of table) {
      expect({ method, path, passes: passesReadOnly(method, path) }).toEqual({
        method,
        path,
        passes,
      });
    }
  });
});

describe("read only", () => {
  test("refuses a message with 503 maintenance and the exact words, and writes nothing", async () => {
    const canvas = await fresh();
    const before = await listThreadItems(t.db, { canvasId: canvas.id });
    switchTo("read_only");
    const said = await call(t, await as("maya"), "POST", `/v1/canvases/${canvas.id}/messages`, {
      text: "Make the header calmer",
    });
    expect(said).toEqual({ status: 503, body: refusal });
    await t.backgroundDone();
    expect(await listThreadItems(t.db, { canvasId: canvas.id })).toEqual(before);
    expect(await wakeJobs(canvas.id)).toEqual([]);
    expect(await getSandbox(t.db, canvas.id)).toBeNull();
    // Logged as a refusal, not as the API failing: it sends nothing to error tracking.
    expect(t.logs.findLast((l) => l.event === "request_refused")).toMatchObject({
      level: "warn",
      status: 503,
      errorCode: "maintenance",
    });
    expect(t.logs.some((l) => l.event === "request_failed" && l.errorCode === "maintenance")).toBe(
      false,
    );
  });

  test("refuses a create and an edit of a canvas the same way", async () => {
    const canvas = await fresh();
    switchTo("read_only");
    const headers = await as("maya");
    const created = await call(t, headers, "POST", "/v1/canvases", {
      workspaceId: ws.id,
      repoId: ws.repo.id,
      message: { text: "A pricing page" },
    });
    expect(created).toEqual({ status: 503, body: refusal });
    const renamed = await call(t, headers, "PATCH", `/v1/canvases/${canvas.id}`, {
      name: "Renamed",
    });
    expect(renamed).toEqual({ status: 503, body: refusal });
    expect((await head(canvas.id)).name).toBe(canvas.name);
  });

  test("lets reads, health and the cron through", async () => {
    const canvas = await fresh();
    switchTo("read_only");
    const read = await call(t, await as("maya"), "GET", `/v1/canvases/${canvas.id}`);
    expect(read.status).toBe(200);
    const health = await t.app.request("/v1/health");
    expect(health.status).toBe(200);
    await cron();
  });

  test("lets a runner's heartbeat through, and refuses its acks, which it sends again later", async () => {
    const canvas = await fresh();
    const runner = await startRunner(t, canvas.id);
    switchTo("read_only");
    const beat = await call(t, runner.headers, "PUT", "/v1/runner/state", {
      state: "idle",
      status: null,
      artboards: [],
      claudeSessionId: null,
    });
    expect(beat.status).toBe(200);
    const ack = { ids: [], claudeSessionId: null };
    const acked = await call(t, runner.headers, "POST", "/v1/runner/events/ack", ack);
    expect(acked).toEqual({ status: 503, body: refusal });
    // The runner retries a 5xx unchanged: once the switch is off, the same call goes in.
    switchTo("off");
    const again = await call(t, runner.headers, "POST", "/v1/runner/events/ack", ack);
    expect(again.status).toBe(200);
  });

  test("the steer gate refuses too, so a steer is refused even if the route let it through", async () => {
    const request: SteerRequest = {
      action: "message",
      userId: "usr_1",
      workspaceId: ws.id,
      canvasId: "cnv_1",
      withMessage: true,
      request: new Request("http://api.test/v1/canvases/cnv_1/messages"),
    };
    await askSteerGates(t.deps, request);
    switchTo("wakes_paused");
    await askSteerGates(t.deps, request);
    switchTo("read_only");
    await expect(askSteerGates(t.deps, request)).rejects.toMatchObject({
      status: 503,
      code: "maintenance",
      message: MAINTENANCE_MESSAGE,
    });
  });
});

describe("wakes paused", () => {
  test("the gate answers paused, to be tried again in two minutes, and nothing when off", () => {
    const now = new Date("2026-11-12T12:00:00Z");
    const ctx = {} as Parameters<typeof maintenanceGate>[0];
    const ask = { deps: t.deps, reason: "message" };
    expect(maintenanceGate(ctx, now, ask)).toBeNull();
    for (const mode of ["wakes_paused", "read_only"] as const) {
      switchTo(mode);
      expect(maintenanceGate(ctx, now, ask)).toEqual({
        blocker: "paused",
        retryAt: new Date(now.getTime() + MAINTENANCE_RETRY_MS),
      });
    }
  });

  test("keeps the message, leaves the sandbox asleep on paused, and wakes it once the switch is off", async () => {
    const canvas = await fresh();
    switchTo("wakes_paused");
    const said = await call(t, await as("maya"), "POST", `/v1/canvases/${canvas.id}/messages`, {
      text: "Make the header calmer",
    });
    expect(said.status).toBe(201);
    await t.backgroundDone();
    const retryAt = new Date(t.clock.now() + MAINTENANCE_RETRY_MS);
    expect(await getSandbox(t.db, canvas.id)).toBeNull();
    expect(await head(canvas.id)).toMatchObject({
      agentBlocker: "paused",
      agentBlockedUntil: retryAt,
      agentState: "idle",
    });
    const [job, ...more] = await wakeJobs(canvas.id);
    expect(more).toEqual([]);
    expect(job).toMatchObject({ attempts: 1, completed_at: null, failed_at: null });
    expect(new Date(job!.run_at as string).getTime()).toBe(retryAt.getTime());

    // Still paused when it is tried again: asleep, and put off once more.
    t.clock.advance(MAINTENANCE_RETRY_MS);
    expect((await cron()).steps.maintenance).toEqual({ paused: 1 });
    expect(await getSandbox(t.db, canvas.id)).toBeNull();
    expect((await wakeJobs(canvas.id))[0]).toMatchObject({ attempts: 2, completed_at: null });
    expect((await head(canvas.id)).agentBlocker).toBe("paused");

    // The switch goes off. The next run wakes it, and the message is there for the runner.
    switchTo("off");
    t.clock.advance(MAINTENANCE_RETRY_MS);
    await cron();
    expect((await getSandbox(t.db, canvas.id))!.state).toBe("awake");
    expect(await head(canvas.id)).toMatchObject({ agentBlocker: null, agentBlockedUntil: null });
    const [done] = await wakeJobs(canvas.id);
    expect(done!.completed_at).not.toBeNull();
    const thread = await listThreadItems(t.db, { canvasId: canvas.id });
    expect(thread.some((i) => i.kind === "message")).toBe(true);
  });

  test("a wake that ran out of tries while paused is taken up by the cron once the switch is off", async () => {
    const canvas = await fresh();
    await appendEvent(t.db, {
      canvasId: canvas.id,
      kind: "message",
      priority: "now",
      payload: { text: "Waiting for you" },
    });
    switchTo("wakes_paused");
    await wakeCanvas(t.deps, canvas.id, { id: "job_last_paused", attempts: 40, maxAttempts: 40 });
    expect((await head(canvas.id)).agentBlocker).toBe("paused");
    expect(await wakeJobs(canvas.id)).toEqual([]);

    // Paused, the cron leaves it be.
    await cron();
    expect((await head(canvas.id)).agentBlocker).toBe("paused");
    expect(await getSandbox(t.db, canvas.id)).toBeNull();

    switchTo("off");
    const ran = await cron();
    expect(ran.steps.maintenance).toMatchObject({ lifted: 1, started: 1, queued: 0 });
    expect((await head(canvas.id)).agentBlocker).toBeNull();
    expect((await getSandbox(t.db, canvas.id))!.state).toBe("awake");
  });
});
