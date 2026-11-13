import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sampleDoc } from "@ponzu/core/fixtures";
import {
  appendEvent,
  getCanvas,
  getSandbox,
  moveSandbox,
  newId,
  notifications,
  recordCheckpoint,
  type SweptSandbox,
} from "@ponzu/db";
import { IMAGE_COMMANDS, RUNNER_HEADER, RUNNER_PORT } from "@ponzu/runner/protocol";
import { canvasSandboxName, SandboxError, type Sandboxes } from "@ponzu/sandbox";
import { call, canvasIn, type Workspace, workspaceWithRepo } from "../testing/canvases.ts";
import {
  createTestApp,
  TEST_API_URL,
  TEST_BUNDLE,
  TEST_CRON_SECRET,
  TEST_IMAGE,
  TEST_SCOPE,
  type TestApp,
} from "../testing/index.ts";
import {
  EXTEND_BY_MS,
  MAX_SESSION_MS,
  SESSION_TIMEOUT_MS,
  SNAPSHOT_EXPIRATION_MS,
  STOP_COMMAND_MS,
} from "./constants.ts";
import { sandboxSpec, wakeCanvas } from "./orchestrate.ts";
import { finishRetire, holdForRetire, retire } from "./retire.ts";
import { putToSleep } from "./stop.ts";
import { extendBy, LAPSED_GIVE_UP, reconcile, STALLED_MS, STALLED_SAID, STEPS } from "./sweep.ts";

/*
 * A canvas's sandbox from its first message to its retirement, through the routes and the
 * minute's cron, on FakeSandboxes (which models Vercel as the live suite recorded it) and the
 * test's clock.
 */

let t: TestApp;
let ws: Workspace;
const KEY = "sk-ant-api03-maya-first-key-0000000000";
const OTHER_KEY = "sk-ant-api03-maya-second-key-000000000";
const MINUTE = 60_000;

beforeAll(async () => {
  t = await createTestApp();
  ws = await workspaceWithRepo(t, { maya: "write", ines: "write" });
  await connectKey("maya", KEY);
});
afterAll(() => t.close());

/** A fresh sign-in: the test clock runs past an access token's five minutes. */
const as = async (login: string) => (await t.signInAs({ login })).headers;
const fresh = () => canvasIn(t, ws, "maya", sampleDoc());
const row = async (canvasId: string) => (await getSandbox(t.db, canvasId))!;
const head = async (canvasId: string) => (await getCanvas(t.db, canvasId))!;
const nameOf = (canvasId: string) => canvasSandboxName(TEST_SCOPE, canvasId);
const commands = (canvasId: string) => t.sandboxes.commands(nameOf(canvasId));
const starts = (canvasId: string) => commands(canvasId).filter((c) => c.kind === "start");
const stops = (canvasId: string) =>
  commands(canvasId).filter((c) => c.kind === "exec" && c.command.cmd === IMAGE_COMMANDS.stop);
const status = async (canvasId: string) => (await t.sandboxes.status(nameOf(canvasId)))?.status;

/** The newest line about this canvas with this event. */
const logged = (event: string, canvasId: string) =>
  t.logs.findLast((line) => line.event === event && line.canvasId === canvasId);

/** The inbox rows about this canvas: who was told what. */
const pingsAbout = async (canvasId: string) =>
  (await t.db.select().from(notifications))
    .filter((ping) => ping.canvasId === canvasId)
    .map(({ userId, dedupeKey, body }) => ({ userId, dedupeKey, body }));

/** The newest capture of `event` about this canvas. */
const captured = (event: "sandbox woke" | "sandbox slept", canvasId: string) =>
  t.analytics.of(event).findLast((e) => e.properties.canvas_id === canvasId)?.properties;

/** Rows of a statement the test writes itself. */
async function rows(statement: string): Promise<Record<string, unknown>[]> {
  return ((await t.db.execute(statement)) as unknown as { rows: Record<string, unknown>[] }).rows;
}

async function connectKey(login: string, key: string) {
  t.anthropic.keys.add(key);
  const connected = await call(t, await as(login), "POST", "/v1/claude/api-key", { key });
  expect(connected.status).toBe(200);
  await t.backgroundDone();
}

/** A person's message, and everything it set going. */
async function say(canvasId: string, text = "Draw a calmer pricing page", who = "maya") {
  const said = await call(t, await as(who), "POST", `/v1/canvases/${canvasId}/messages`, { text });
  expect(said.status).toBe(201);
  await t.backgroundDone();
}

async function cron() {
  const ran = await t.app.request("/v1/cron/minute", {
    headers: { authorization: `Bearer ${TEST_CRON_SECRET}` },
  });
  expect(ran.status).toBe(200);
  await t.backgroundDone();
  return (await ran.json()) as { steps: Record<string, Record<string, number>> };
}

/** On to a minute the sweep reconciles in (every tenth), and sweep. */
async function reconcileCron() {
  const minute = new Date(t.clock.now()).getUTCMinutes();
  t.clock.advance(((10 - (minute % 10)) % 10) * MINUTE + 1000);
  return cron();
}

/** The env of the canvas's last runner start. */
const startEnv = (canvasId: string) => starts(canvasId).at(-1)!.command.env!;

/** The runner the last start started: it takes the lease with the token its env carries. */
async function runnerIn(canvasId: string) {
  const token = startEnv(canvasId).PONZU_RUNNER_TOKEN!;
  const started = await call(t, { authorization: `Bearer ${token}` }, "POST", "/v1/runner/session");
  const headers = { authorization: `Bearer ${token}`, [RUNNER_HEADER]: started.body?.runnerId };
  const beat = (state: "working" | "idle" = "idle") =>
    call(t, headers, "PUT", "/v1/runner/state", {
      state,
      status: null,
      artboards: [],
      claudeSessionId: "session-1",
    });
  await beat();
  return {
    status: started.status,
    token,
    headers,
    beat,
    claim: () => call(t, headers, "POST", "/v1/runner/events/claim", { claimId: newId("clm") }),
    ack: (ids: string[]) =>
      call(t, headers, "POST", "/v1/runner/events/ack", { ids, claudeSessionId: "session-1" }),
    answer: (text = "On it.") =>
      call(t, headers, "POST", "/v1/runner/thread", {
        items: [{ id: newId("ti"), kind: "assistant", payload: { text }, streaming: false }],
      }),
  };
}
type Runner = Awaited<ReturnType<typeof runnerIn>>;

/**
 * A canvas whose sandbox is awake with its runner started, as after a first message. Its runner
 * has taken the message and answered it, unless `answered` is false.
 */
async function awakeCanvas({ answered = true }: { answered?: boolean } = {}) {
  const canvas = await fresh();
  await say(canvas.id);
  expect((await row(canvas.id)).state).toBe("awake");
  const runner = await runnerIn(canvas.id);
  if (answered) await answerAll(runner);
  return { canvas, runner };
}

/** The runner saves a checkpoint through everything it has delivered. */
async function checkpoint(canvasId: string, runner: Runner, turn: number) {
  await recordCheckpoint(t.db, {
    canvasId,
    runnerId: runner.headers[RUNNER_HEADER] as string,
    now: new Date(t.clock.now()),
    turn,
    claudeSessionId: "session-1",
    wipCommit: null,
    sessionUploadId: null,
    workspaceUploadId: null,
  });
}

/** The runner takes what the feed holds and answers it. */
async function answerAll(runner: Runner) {
  const claimed = await runner.claim();
  const ids = claimed.body.events.map((event: { id: string }) => event.id);
  if (ids.length === 0) return;
  await runner.ack(ids);
  await runner.answer();
}

/** Lets the sandbox idle past its five minutes while its runner keeps beating, then sweeps. */
async function idleToSleep(runner: Runner) {
  for (let i = 0; i < 11; i++) {
    t.clock.advance(30_000);
    await runner.beat();
  }
  await cron();
}

/** The thread after the person's last message. */
async function threadAfterLastMessage(canvasId: string) {
  const all = await rows(
    `select kind, payload from thread_items where canvas_id = '${canvasId}' order by seq`,
  );
  const last = all.findLastIndex((item) => item.kind === "message");
  return all.slice(last + 1) as { kind: string; payload: Record<string, unknown> }[];
}

/** The canvas's feed, oldest first. */
const feed = async (canvasId: string) =>
  (await rows(
    `select id, kind, payload, delivered_at, lapsed_at from events
      where canvas_id = '${canvasId}' order by seq`,
  )) as { id: string; kind: string; payload: Record<string, unknown>; lapsed_at: unknown }[];

/** The runner beats for `ms` in `state`, and the cron sweeps every minute. */
async function beatFor(runner: Runner, ms: number, state: "working" | "idle" = "idle") {
  for (let at = 0; at < ms; at += 30_000) {
    t.clock.advance(30_000);
    await runner.beat(state);
    if ((at / 30_000) % 2 === 1) await cron();
  }
}

/** While `work` runs, every `clock.sleep` also runs `onSleep` (once each, by count). */
async function withSleeps<T>(onSleep: (count: number) => Promise<void>, work: () => Promise<T>) {
  const sleep = t.clock.sleep.bind(t.clock);
  let count = 0;
  t.clock.sleep = async (ms: number) => {
    await sleep(ms);
    await onSleep(++count);
  };
  try {
    return await work();
  } finally {
    t.clock.sleep = sleep;
  }
}

describe("the first wake", () => {
  test("a message creates the sandbox, and starts the runner with its environment in the one command", async () => {
    const canvas = await fresh();
    await say(canvas.id);
    const name = nameOf(canvas.id);
    const sandbox = await row(canvas.id);
    expect(sandbox).toMatchObject({
      state: "awake",
      image: TEST_IMAGE,
      address: `https://${name}-${RUNNER_PORT}.fake.vercel.run`,
      failure: null,
    });
    expect(sandbox.sessionId).toBeString();
    expect(sandbox.sessionStartedAt).toEqual(sandbox.awakeSince);
    expect(sandbox.expiresAt!.getTime()).toBe(
      sandbox.sessionStartedAt!.getTime() + SESSION_TIMEOUT_MS,
    );
    expect(t.sandboxes.config(name).spec).toEqual({
      persistent: true,
      ports: [RUNNER_PORT],
      timeoutMs: SESSION_TIMEOUT_MS,
      snapshotExpirationMs: SNAPSHOT_EXPIRATION_MS,
      vcpus: 2,
    });
    // One command, detached, as root, on the session the row holds: nothing ran before it.
    expect(commands(canvas.id)).toEqual([
      {
        sessionId: sandbox.sessionId!,
        kind: "start",
        command: { cmd: IMAGE_COMMANDS.start, env: expect.any(Object), sudo: true },
      },
    ]);
    const env = startEnv(canvas.id);
    // Exactly one Claude credential, and the bundle this API serves.
    expect(Object.keys(env).toSorted()).toEqual([
      "ANTHROPIC_API_KEY",
      "PONZU_API_URL",
      "PONZU_CANVAS_ID",
      "PONZU_PORT_TOKEN",
      "PONZU_RUNNER_BUNDLE",
      "PONZU_RUNNER_TOKEN",
    ]);
    expect(env).toMatchObject({
      ANTHROPIC_API_KEY: KEY,
      PONZU_API_URL: TEST_API_URL,
      PONZU_CANVAS_ID: canvas.id,
      PONZU_RUNNER_BUNDLE: TEST_BUNDLE.sha256,
    });
    expect(env.PONZU_PORT_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Nothing of it is in the row, and the port's token only sealed.
    expect(JSON.stringify(sandbox)).not.toContain(env.PONZU_PORT_TOKEN);
    expect(captured("sandbox woke", canvas.id)).toMatchObject({
      start: "create",
      fresh: true,
      recreated: false,
      image: TEST_IMAGE,
    });
    expect((await head(canvas.id)).agentState).toBe("waking");

    // The runner takes the lease with its token; the next message pokes it with the port's.
    const runner = await runnerIn(canvas.id);
    expect(runner.status).toBe(200);
    t.poke.pokes.length = 0;
    await say(canvas.id, "And the footer");
    expect(t.poke.pokes).toEqual([{ url: sandbox.address!, token: env.PONZU_PORT_TOKEN! }]);
    expect(starts(canvas.id)).toHaveLength(1);
  });

  test("two wakes at once make one up(): the rest leave it be", async () => {
    const canvas = await fresh();
    await Promise.all([1, 2, 3].map((n) => wakeCanvas(t.deps, canvas.id, job(`job_race_${n}`))));
    expect(starts(canvas.id)).toHaveLength(1);
    expect(t.sandboxes.resumes(nameOf(canvas.id))).toBe(0);
  });

  test("a name that is there without a row is taken on, and its configuration brought up to date", async () => {
    const canvas = await fresh();
    const name = nameOf(canvas.id);
    // Made with another timeout, and stopped: as if by an older API.
    const old = await t.sandboxes.up(name, { ...sandboxSpec(TEST_IMAGE), timeoutMs: 5 * MINUTE });
    await t.sandboxes.stop({ name, sessionId: old.sessionId });
    await say(canvas.id);
    expect(t.sandboxes.config(name)).toMatchObject({
      spec: { timeoutMs: SESSION_TIMEOUT_MS },
      updates: 1,
    });
    expect((await row(canvas.id)).state).toBe("awake");
    expect(captured("sandbox woke", canvas.id)).toMatchObject({ start: "resume" });
  });
});

const job = (id: string) => ({ id, attempts: 1, maxAttempts: 40 });

describe("sleep and wake", () => {
  test("five minutes idle shuts the runner down, then stops; a message resumes it on its disk", async () => {
    const { canvas, runner } = await awakeCanvas();
    const first = await row(canvas.id);
    await idleToSleep(runner);
    const asleep = await row(canvas.id);
    expect(asleep).toMatchObject({
      state: "asleep",
      address: null,
      encryptedPortToken: null,
      sessionId: first.sessionId,
    });
    // ponzu-stop, as root and waited, pinned to the session; then Vercel's stop.
    expect(stops(canvas.id)).toEqual([
      {
        sessionId: first.sessionId!,
        kind: "exec",
        command: { cmd: IMAGE_COMMANDS.stop, sudo: true },
      },
    ]);
    expect(await status(canvas.id)).toBe("stopped");
    // The runner's token goes with it.
    expect((await runner.beat()).status).toBe(401);
    expect(captured("sandbox slept", canvas.id)).toMatchObject({
      why: "idle",
    });
    const [used] = await rows(
      `select id, seconds from usage_events where canvas_id = '${canvas.id}' and kind = 'sandbox'`,
    );
    expect(used!.id).toBe(`${canvas.id}/${first.awakeSince!.getTime()}`);

    await say(canvas.id, "Now the header");
    const woke = await row(canvas.id);
    expect(woke.state).toBe("awake");
    expect(woke.sessionId).not.toBe(first.sessionId);
    expect(t.sandboxes.resumes(nameOf(canvas.id))).toBe(1);
    expect(captured("sandbox woke", canvas.id)).toMatchObject({
      start: "resume",
      fresh: false,
      recreated: false,
    });
    // A new token and port token at every start.
    expect(startEnv(canvas.id).PONZU_RUNNER_TOKEN).not.toBe(runner.token);
  });

  test("an idle stop loses to a fresh message", async () => {
    const { canvas } = await awakeCanvas();
    const before = await row(canvas.id);
    t.clock.advance(6 * MINUTE);
    await say(canvas.id, "One more thing");
    expect(
      await putToSleep(t.deps, before, "idle", {
        idleBefore: new Date(t.clock.now() - 5 * MINUTE),
      }),
    ).toBe(false);
    expect((await row(canvas.id)).state).toBe("awake");
    expect(stops(canvas.id)).toEqual([]);
  });

  test("an agent that keeps working keeps it awake, and its session is extended", async () => {
    const { canvas, runner } = await awakeCanvas();
    const before = await row(canvas.id);
    for (let i = 0; i < 50; i++) {
      t.clock.advance(30_000);
      await runner.beat("working");
      if (i % 2 === 1) await cron();
    }
    const after = await row(canvas.id);
    expect(after.state).toBe("awake");
    expect(after.sessionId).toBe(before.sessionId);
    expect(after.expiresAt!.getTime()).toBeGreaterThan(before.expiresAt!.getTime());
    expect(after.expiresAt!.getTime()).toBeGreaterThan(t.clock.now() + 10 * MINUTE - 1);
  });

  test("a wake during a stop waits for it to land, then resumes", async () => {
    const { canvas } = await awakeCanvas();
    const awake = await row(canvas.id);
    await moveSandbox(t.db, {
      canvasId: canvas.id,
      from: ["awake"],
      to: "stopping",
      now: new Date(t.clock.now()),
      hold: "stop:elsewhere",
    });
    const resumes = t.sandboxes.resumes(nameOf(canvas.id));
    await withSleeps(
      async (count) => {
        if (count !== 3) return;
        // The stop lands, three seconds in.
        await t.sandboxes.stop({ name: nameOf(canvas.id), sessionId: awake.sessionId! });
        await moveSandbox(t.db, {
          canvasId: canvas.id,
          from: ["stopping"],
          to: "asleep",
          now: new Date(t.clock.now()),
          by: "stop:elsewhere",
        });
      },
      () => wakeCanvas(t.deps, canvas.id, job("job_after_stop")),
    );
    expect((await row(canvas.id)).state).toBe("awake");
    expect(t.sandboxes.resumes(nameOf(canvas.id))).toBe(resumes + 1);
  });

  test("a stop still under way after its wait is tried again later", async () => {
    const { canvas } = await awakeCanvas();
    await moveSandbox(t.db, {
      canvasId: canvas.id,
      from: ["awake"],
      to: "stopping",
      now: new Date(t.clock.now()),
      hold: "stop:stuck",
    });
    await expect(wakeCanvas(t.deps, canvas.id, job("job_stuck"))).rejects.toMatchObject({
      name: "RetryLater",
    });
    expect((await head(canvas.id)).agentState).toBe("waking");
  });

  test("the sweep never resumes a sandbox", async () => {
    const { canvas, runner } = await awakeCanvas();
    await idleToSleep(runner);
    const resumes = t.sandboxes.resumes(nameOf(canvas.id));
    for (let i = 0; i < 12; i++) {
      t.clock.advance(MINUTE);
      await cron();
    }
    await reconcileCron();
    expect(t.sandboxes.resumes(nameOf(canvas.id))).toBe(resumes);
    expect(await status(canvas.id)).toBe("stopped");
  });
});

describe("a restart in place", () => {
  test("a credential changed while it is awake shuts the runner down and starts it again in the same session", async () => {
    const { canvas, runner } = await awakeCanvas();
    const before = await row(canvas.id);
    t.clock.advance(MINUTE);
    await connectKey("maya", OTHER_KEY);
    await say(canvas.id, "Carry on");
    const after = await row(canvas.id);
    expect(after).toMatchObject({ state: "awake", sessionId: before.sessionId });
    // The session's start is kept: the cycle and the extend clamp count from it.
    expect(after.sessionStartedAt).toEqual(before.sessionStartedAt);
    const [stop, start] = commands(canvas.id).slice(-2);
    expect(stop).toMatchObject({ kind: "exec", command: { cmd: IMAGE_COMMANDS.stop } });
    expect(start).toMatchObject({ kind: "start", sessionId: before.sessionId });
    expect(startEnv(canvas.id).ANTHROPIC_API_KEY).toBe(OTHER_KEY);
    expect(captured("sandbox woke", canvas.id)).toMatchObject({ start: "restart" });
    // The runner it replaced is done.
    expect((await runner.beat()).status).toBe(401);
    await connectKey("maya", KEY);
  });

  test("a session left running behind an asleep row is shut down before the runner starts", async () => {
    const { canvas, runner } = await awakeCanvas();
    await idleToSleep(runner);
    t.sandboxes.resumeBehindOurBack(nameOf(canvas.id));
    const running = (await t.sandboxes.status(nameOf(canvas.id)))!;
    await say(canvas.id, "Again");
    const [stop, start] = commands(canvas.id).slice(-2);
    expect(stop).toMatchObject({
      sessionId: running.sessionId,
      command: { cmd: IMAGE_COMMANDS.stop },
    });
    expect(start).toMatchObject({ sessionId: running.sessionId, kind: "start" });
  });
});

describe("a dead runner", () => {
  test("is shut down and started again, and after three in a row the sandbox fails", async () => {
    const { canvas } = await awakeCanvas();
    for (let restart = 1; restart <= 3; restart++) {
      t.clock.advance(2 * MINUTE);
      await cron();
      expect(logged("runner_dead", canvas.id)).toMatchObject({ restarts: restart });
      expect((await row(canvas.id)).state).toBe("awake");
    }
    expect(starts(canvas.id)).toHaveLength(4);
    // A message no runner took waits in the feed: the failure is not woken straight back up.
    await appendEvent(t.db, {
      canvasId: canvas.id,
      kind: "message",
      priority: "now",
      payload: { text: "Hello?" },
      userId: ws.people.maya!.userId,
    });
    t.clock.advance(2 * MINUTE);
    await cron();
    expect(await row(canvas.id)).toMatchObject({
      state: "asleep",
      failure: "Its runner stopped answering 4 times in a row.",
    });
    expect((await head(canvas.id)).agentBlocker).toBe("sandbox_failed");
    // Whoever's message waits on it is asked to try again.
    expect(await pingsAbout(canvas.id)).toEqual([
      {
        userId: ws.people.maya!.userId,
        dedupeKey: expect.stringMatching(new RegExp(`^wake_failed:${canvas.id}:`)),
        body: "Ponzu couldn't start. Send a message to try again.",
      },
    ]);
    expect(await status(canvas.id)).toBe("stopped");
    t.clock.advance(2 * MINUTE);
    await cron();
    expect(starts(canvas.id)).toHaveLength(4);
    expect((await row(canvas.id)).state).toBe("asleep");
  });
});

describe("the session's own clock", () => {
  test("an extend stays inside Vercel's cap, counted from the session's start", () => {
    const start = new Date(0);
    expect(extendBy({ sessionStartedAt: start, expiresAt: new Date(SESSION_TIMEOUT_MS) })).toBe(
      EXTEND_BY_MS,
    );
    expect(
      extendBy({ sessionStartedAt: start, expiresAt: new Date(MAX_SESSION_MS - 15 * MINUTE) }),
    ).toBe(10 * MINUTE);
    expect(
      extendBy({ sessionStartedAt: start, expiresAt: new Date(MAX_SESSION_MS - 2 * MINUTE) }),
    ).toBeLessThan(0);
  });

  test("a session 23.5 hours old is slept before it is extended, and woken again for its work", async () => {
    const { canvas } = await awakeCanvas();
    const before = await row(canvas.id);
    const now = t.clock.now();
    await rows(
      `update sandboxes set session_started_at = '${new Date(now - 23.6 * 3600_000).toISOString()}',
              expires_at = '${new Date(now + 2 * MINUTE).toISOString()}'
        where canvas_id = '${canvas.id}'`,
    );
    await appendEvent(t.db, {
      canvasId: canvas.id,
      kind: "message",
      priority: "now",
      payload: { text: "Still here" },
      userId: ws.people.maya!.userId,
    });
    await cron();
    expect(captured("sandbox slept", canvas.id)).toMatchObject({ why: "cycle" });
    // The pending rule: a new session for the message no runner took.
    const after = await row(canvas.id);
    expect(after.state).toBe("awake");
    expect(after.sessionId).not.toBe(before.sessionId);
  });

  test("an extend that finds the session stopped sends the row to sleep, and the pending rule wakes it", async () => {
    const { canvas, runner } = await awakeCanvas();
    const before = await row(canvas.id);
    // Thirty minutes of work with no sweep: Vercel's own timeout ends the session.
    for (let i = 0; i < 62; i++) {
      t.clock.advance(30_000);
      await runner.beat("working");
    }
    expect(await status(canvas.id)).toBe("stopped");
    await appendEvent(t.db, {
      canvasId: canvas.id,
      kind: "message",
      priority: "now",
      payload: { text: "Are you there?" },
      userId: ws.people.maya!.userId,
    });
    await cron();
    expect(logged("sandbox_expired", canvas.id)).toMatchObject({ sessionId: before.sessionId });
    expect(captured("sandbox slept", canvas.id)).toMatchObject({ why: "expired" });
    const after = await row(canvas.id);
    expect(after.state).toBe("awake");
    expect(after.sessionId).not.toBe(before.sessionId);
  });
});

describe("a fresh disk", () => {
  test("an expired snapshot, or a sandbox Vercel removed, wakes on an empty disk", async () => {
    const { canvas, runner } = await awakeCanvas();
    await idleToSleep(runner);
    t.sandboxes.expire(nameOf(canvas.id));
    await say(canvas.id, "After a long while");
    expect(captured("sandbox woke", canvas.id)).toMatchObject({
      start: "create",
      fresh: true,
    });
    const again = await runnerIn(canvas.id);
    await answerAll(again);
    await idleToSleep(again);
    t.sandboxes.retain(nameOf(canvas.id));
    await say(canvas.id, "After longer still");
    expect((await row(canvas.id)).state).toBe("awake");
    expect(captured("sandbox woke", canvas.id)).toMatchObject({
      start: "create",
      fresh: true,
    });
  });
});

describe("a new image", () => {
  const NEXT = `ponzu-runner@sha256:${"c".repeat(64)}`;
  const onImage = async <T>(image: string, work: () => Promise<T>) => {
    const was = t.deps.config.sandbox.image;
    t.deps.config.sandbox.image = image;
    try {
      return await work();
    } finally {
      t.deps.config.sandbox.image = was;
    }
  };

  test("is taken at the next wake by recreating the sandbox, without booting the old one", async () => {
    const { canvas, runner } = await awakeCanvas();
    await checkpoint(canvas.id, runner, 1);
    await idleToSleep(runner);
    const resumes = t.sandboxes.resumes(nameOf(canvas.id));
    await onImage(NEXT, () => say(canvas.id, "On the new image"));
    expect(t.sandboxes.resumes(nameOf(canvas.id))).toBe(resumes);
    expect(t.sandboxes.config(nameOf(canvas.id)).image).toEndWith(NEXT);
    expect(await row(canvas.id)).toMatchObject({ state: "awake", image: NEXT });
    expect(captured("sandbox woke", canvas.id)).toMatchObject({
      fresh: true,
      recreated: true,
      image: NEXT,
    });
  });

  test("waits while the last checkpoint does not hold everything that went into the session", async () => {
    const { canvas, runner } = await awakeCanvas();
    await idleToSleep(runner);
    // No checkpoint at all: the old image, and the log says why.
    await onImage(NEXT, () => say(canvas.id, "Not yet"));
    expect(await row(canvas.id)).toMatchObject({ image: TEST_IMAGE });
    expect(logged("sandbox_move_held", canvas.id)).toMatchObject({ reason: "no_checkpoint" });

    // A checkpoint through everything delivered: the next wake moves it.
    const next = await runnerIn(canvas.id);
    await answerAll(next);
    await checkpoint(canvas.id, next, 2);
    await idleToSleep(next);
    await onImage(NEXT, () => say(canvas.id, "Now"));
    expect(await row(canvas.id)).toMatchObject({ image: NEXT });
  });
});

describe("disconnecting Claude", () => {
  test("puts every awake runner holding it to sleep at once, and leaves asleep ones be", async () => {
    const asleep = await awakeCanvas();
    await idleToSleep(asleep.runner);
    const awake = await awakeCanvas();
    const asleepCommands = commands(asleep.canvas.id).length;
    const disconnected = await call(t, await as("maya"), "DELETE", "/v1/claude");
    expect(disconnected.status).toBe(204);
    await t.backgroundDone();
    expect((await row(awake.canvas.id)).state).toBe("asleep");
    expect(await status(awake.canvas.id)).toBe("stopped");
    expect(stops(awake.canvas.id)).toHaveLength(1);
    expect(captured("sandbox slept", awake.canvas.id)).toMatchObject({
      why: "claude_disconnected",
    });
    // Not destroyed: its disk holds the canvas's work, and no credential.
    expect(await status(asleep.canvas.id)).toBe("stopped");
    expect(commands(asleep.canvas.id)).toHaveLength(asleepCommands);
    expect((await head(asleep.canvas.id)).agentBlocker).toBe("claude_not_connected");
    await connectKey("maya", KEY);
  });
});

describe("the end of a canvas", () => {
  test("settling holds the row while the sandbox is stopped and deleted, then deletes the row", async () => {
    const { canvas, runner } = await awakeCanvas();
    const settled = await call(t, await as("maya"), "PATCH", `/v1/canvases/${canvas.id}`, {
      settled: true,
    });
    expect(settled.status).toBe(200);
    await t.backgroundDone();
    expect(await getSandbox(t.db, canvas.id)).toBeNull();
    expect(await t.sandboxes.status(nameOf(canvas.id))).toBeNull();
    expect((await runner.beat()).status).toBe(401);
  });

  test("a canvas reopened during its retire waits for it, and its new sandbox is never deleted", async () => {
    const { canvas } = await awakeCanvas();
    await rows(
      `update canvases set status = 'settled', settled_at = now() where id = '${canvas.id}'`,
    );
    const by = await holdForRetire(t.deps, canvas.id);
    expect((await row(canvas.id)).wakingBy).toBe(by);
    await rows(
      `update canvases set status = 'active', settled_at = null where id = '${canvas.id}'`,
    );
    await withSleeps(
      async (count) => {
        // The retire finishes while the reopened canvas's wake waits for the row.
        if (count === 2) await finishRetire(t.deps, canvas.id, by);
      },
      () => wakeCanvas(t.deps, canvas.id, job("job_reopen")),
    );
    expect(await row(canvas.id)).toMatchObject({ state: "awake" });
    expect(await status(canvas.id)).toBe("running");
  });

  test("deleting the canvas deletes its sandbox and keeps its usage", async () => {
    const { canvas } = await awakeCanvas();
    t.clock.advance(MINUTE);
    const deleted = await call(t, await as("maya"), "DELETE", `/v1/canvases/${canvas.id}`);
    expect(deleted.status).toBe(204);
    await t.backgroundDone();
    expect(await t.sandboxes.status(nameOf(canvas.id))).toBeNull();
    expect(
      await rows(
        `select seconds from usage_events where canvas_id is null or canvas_id = '${canvas.id}'`,
      ),
    ).not.toEqual([]);
  });

  test("a sandbox whose canvas was deleted is removed by reconcile", async () => {
    const orphan = nameOf("cnv_deleted0000000");
    await t.sandboxes.up(orphan, sandboxSpec(TEST_IMAGE));
    await reconcileCron();
    expect(await t.sandboxes.status(orphan)).toBeNull();
    expect(t.logs.findLast((l) => l.event === "sandbox_orphan_removed")).toMatchObject({
      name: orphan,
    });
  });
});

describe("reconcile", () => {
  test("stops a sandbox resumed behind an asleep row, and leaves a waking one inside its lease", async () => {
    const leaked = await awakeCanvas();
    await idleToSleep(leaked.runner);
    t.sandboxes.resumeBehindOurBack(nameOf(leaked.canvas.id));

    const waking = await awakeCanvas();
    await moveSandbox(t.db, {
      canvasId: waking.canvas.id,
      from: ["awake"],
      to: "waking",
      now: new Date(t.clock.now()),
      by: "job_slow",
    });
    // A session the row does not know of yet: the wake holding it is making it.
    await rows(
      `update sandboxes set session_id = 'sbx_not_yet' where canvas_id = '${waking.canvas.id}'`,
    );

    await reconcileCron();
    expect(await status(leaked.canvas.id)).toBe("stopped");
    expect(t.logs.findLast((l) => l.event === "sandbox_leak")).toMatchObject({
      name: nameOf(leaked.canvas.id),
    });
    expect(await status(waking.canvas.id)).toBe("running");
  });

  test("looks only at this database's names", async () => {
    const theirs = canvasSandboxName("0123456789ab", "cnv_theirs00000000");
    await t.sandboxes.up(theirs, sandboxSpec(TEST_IMAGE));
    await reconcileCron();
    expect((await t.sandboxes.status(theirs))?.status).toBe("running");
    await t.sandboxes.remove(theirs);
  });

  test("a listing widened past this scope still stops and removes nothing of another's, and says so", async () => {
    // Another deployment's sandboxes in the same project: one whose canvas this database has
    // never heard of (reconcile would remove it as an orphan), and one named for a canvas of
    // ours that is asleep here (reconcile would stop it as a leak).
    const ours = await awakeCanvas();
    await idleToSleep(ours.runner);
    const other = "0123456789ab";
    const orphan = canvasSandboxName(other, "cnv_theirs00000001");
    const twin = canvasSandboxName(other, ours.canvas.id);
    await t.sandboxes.up(orphan, sandboxSpec(TEST_IMAGE));
    await t.sandboxes.up(twin, sandboxSpec(TEST_IMAGE));
    try {
      // A later change that lists every name, on a module with no guard of its own.
      const widened: Sandboxes = {
        ...bound(t.sandboxes),
        list: (_prefix, options) => t.sandboxes.list("pz-", options),
      };
      await reconcile({ ...t.deps, sandboxes: widened });
      expect((await t.sandboxes.status(orphan))?.status).toBe("running");
      expect((await t.sandboxes.status(twin))?.status).toBe("running");
      expect(t.logs.filter((l) => l.event === "sandbox_out_of_scope").map((l) => l.name)).toEqual(
        expect.arrayContaining([orphan, twin]),
      );
    } finally {
      await t.sandboxes.remove(orphan);
      await t.sandboxes.remove(twin);
    }
  });

  test("the deployment's own module refuses another scope's names and a wider listing", async () => {
    const theirs = canvasSandboxName("0123456789ab", "cnv_theirs00000002");
    const up = await t.sandboxes.up(theirs, sandboxSpec(TEST_IMAGE));
    const at = { name: theirs, sessionId: up.sessionId };
    try {
      const refused = async (work: Promise<unknown>) =>
        work.then(
          () => "done",
          (error: unknown) => (error instanceof SandboxError ? error.code : String(error)),
        );
      const mine = t.deps.sandboxes;
      expect(await refused(mine.list("pz-"))).toBe("out_of_scope");
      expect(await refused(mine.list(`pz-${TEST_SCOPE}`))).toBe("out_of_scope");
      expect(await refused(mine.status(theirs))).toBe("out_of_scope");
      expect(await refused(mine.stop(at))).toBe("out_of_scope");
      expect(await refused(mine.remove(theirs))).toBe("out_of_scope");
      expect(await refused(mine.exec(at, { cmd: "true", timeoutMs: 1_000 }))).toBe("out_of_scope");
      expect((await t.sandboxes.status(theirs))?.status).toBe("running");
      expect(t.sandboxes.commands(theirs)).toHaveLength(0);
    } finally {
      await t.sandboxes.remove(theirs);
    }
  });
});

/** The fake's methods bound to it, as a plain `Sandboxes` a test can override one call of. */
function bound(fake: TestApp["sandboxes"]): Sandboxes {
  return {
    up: fake.up.bind(fake),
    status: fake.status.bind(fake),
    list: fake.list.bind(fake),
    start: fake.start.bind(fake),
    exec: fake.exec.bind(fake),
    writeFile: fake.writeFile.bind(fake),
    readFile: fake.readFile.bind(fake),
    extend: fake.extend.bind(fake),
    stop: fake.stop.bind(fake),
    remove: fake.remove.bind(fake),
  };
}

describe("a turn that never came", () => {
  test("a message delivered with nothing after it is not slept on: it is said and sent again", async () => {
    const { canvas, runner } = await awakeCanvas({ answered: false });
    const claimed = await runner.claim();
    const [message] = claimed.body.events as { id: string }[];
    await runner.ack([message!.id]);
    // Past the idle window, its runner idle and silent: never slept, and lapsed at two minutes.
    await idleToSleep(runner);
    expect((await row(canvas.id)).state).toBe("awake");
    expect(logged("turn_lapsed", canvas.id)).toMatchObject({ events: [message!.id] });
    const copy = (
      await rows(
        `select id, payload from events where canvas_id = '${canvas.id}' order by seq desc limit 1`,
      )
    )[0] as { id: string; payload: { retryOf: string } };
    expect(copy.payload.retryOf).toBe(message!.id);
    // The runner claims the copy as a new message and answers; then it sleeps.
    const again = await runner.claim();
    expect(again.body.events.map((e: { id: string }) => e.id)).toEqual([copy.id]);
    await runner.ack([copy.id]);
    await runner.answer();
    await idleToSleep(runner);
    expect((await row(canvas.id)).state).toBe("asleep");
  });

  test("a runner that says it works and writes nothing for fifteen minutes is started again", async () => {
    const { canvas, runner } = await awakeCanvas({ answered: false });
    const token = startEnv(canvas.id).PONZU_RUNNER_TOKEN;
    const claimed = await runner.claim();
    const [message] = claimed.body.events as { id: string }[];
    await runner.ack([message!.id]);
    // A long session's first answer can take minutes: working, it is waited for.
    await beatFor(runner, 10 * MINUTE, "working");
    expect(logged("turn_lapsed", canvas.id)).toBeUndefined();
    // When its runner is shut down, it has been let go already: the thread says the message
    // goes again, and the runner's own "send a message to pick it up" would contradict it.
    let heardAtStop: number | null = null;
    t.sandboxes.onExec(IMAGE_COMMANDS.stop, async () => {
      heardAtStop ??= (await runner.beat("working")).status;
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    try {
      await beatFor(runner, 6 * MINUTE, "working");
    } finally {
      t.sandboxes.onExec(IMAGE_COMMANDS.stop, () => ({ exitCode: 0, stdout: "", stderr: "" }));
    }
    expect(logged("turn_lapsed", canvas.id)).toMatchObject({ agentState: "working" });
    expect(heardAtStop as number | null).toBe(401);
    // Its runner shut down and started again; the copy is the next runner's.
    expect(stops(canvas.id).length).toBeGreaterThanOrEqual(1);
    expect(startEnv(canvas.id).PONZU_RUNNER_TOKEN).not.toBe(token);
    expect((await row(canvas.id)).state).toBe("awake");
    const copy = (await feed(canvas.id)).at(-1)!;
    expect(copy.payload.retryOf).toBe(message!.id);
    const next = await runnerIn(canvas.id);
    expect((await next.claim()).body.events.map((e: { id: string }) => e.id)).toEqual([copy.id]);
  });

  test("a copy that gets no turn either says to send it again, and is not sent a third time", async () => {
    const { canvas, runner } = await awakeCanvas({ answered: false });
    const [message] = (await runner.claim()).body.events as { id: string }[];
    await runner.ack([message!.id]);
    await idleToSleep(runner);
    const copy = (await feed(canvas.id)).at(-1)!;
    expect(copy.payload.retryOf).toBe(message!.id);

    await runner.ack((await runner.claim()).body.events.map((e: { id: string }) => e.id));
    await idleToSleep(runner);
    expect((await row(canvas.id)).state).toBe("awake");
    expect((await threadAfterLastMessage(canvas.id)).at(-1)).toEqual({
      kind: "notice",
      payload: { type: "error", code: "turn_failed", message: LAPSED_GIVE_UP },
    });
    expect(await feed(canvas.id)).toHaveLength(2);
    // Whoever sent it is pinged to send it again; the first lapse, sent again, pinged nobody.
    expect(await pingsAbout(canvas.id)).toEqual([
      {
        userId: ws.people.maya!.userId,
        dedupeKey: `lapsed:${canvas.id}:${copy.id}`,
        body: "Ponzu couldn't get to your message. Send it again.",
      },
    ]);
    // Nothing is owed now: the next idle sweep puts it to sleep.
    await idleToSleep(runner);
    expect((await row(canvas.id)).state).toBe("asleep");
  });

  test("a turn that wrote and then went quiet for an hour, its runner still saying working, is started again", async () => {
    const { canvas, runner } = await awakeCanvas({ answered: false });
    const token = startEnv(canvas.id).PONZU_RUNNER_TOKEN;
    const [message] = (await runner.claim()).body.events as { id: string }[];
    await runner.ack([message!.id]);
    await runner.answer("Looking at the pricing page.");

    // Swept every minute (other canvases' jobs move the shared clock on too) until it is stalled:
    // an hour after it last wrote, and not before.
    for (let i = 0; i < 70 && !logged("turn_stalled", canvas.id); i++) {
      await beatFor(runner, MINUTE, "working");
    }
    const stalledLine = logged("turn_stalled", canvas.id) as { saidMs: number } | undefined;
    expect(stalledLine?.saidMs).toBeGreaterThanOrEqual(STALLED_MS);
    expect(stalledLine!.saidMs).toBeLessThan(STALLED_MS + 3 * MINUTE);
    expect((await threadAfterLastMessage(canvas.id)).at(-1)).toEqual({
      kind: "notice",
      payload: { type: "error", code: "turn_failed", message: STALLED_SAID },
    });
    // Put to sleep and woken again at once, for the stall.
    expect(captured("sandbox slept", canvas.id)).toMatchObject({ why: "restart" });
    const [wake] = await rows(
      `select payload from jobs where kind = 'sandbox.wake' and key = '${canvas.id}'
        order by run_at desc limit 1`,
    );
    expect(wake!.payload).toMatchObject({ reason: "stalled" });
    expect(startEnv(canvas.id).PONZU_RUNNER_TOKEN).not.toBe(token);
    expect((await row(canvas.id)).state).toBe("awake");
  });

  test("a message answered is owed nothing, and its sandbox sleeps as before", async () => {
    const { canvas, runner } = await awakeCanvas({ answered: false });
    const [message] = (await runner.claim()).body.events as { id: string }[];
    await runner.ack([message!.id]);
    t.clock.advance(20_000);
    await runner.answer();
    await idleToSleep(runner);
    expect((await row(canvas.id)).state).toBe("asleep");
    expect(logged("turn_lapsed", canvas.id)).toBeUndefined();
  });

  test("a message the person stopped before anything was written is not sent again", async () => {
    // Stopped while it was starting: the runner ends it before the turn has said anything, and
    // writes no `stopped` notice for a turn that had not begun. The stop is the answer.
    const { canvas, runner } = await awakeCanvas({ answered: false });
    const [message] = (await runner.claim()).body.events as { id: string }[];
    await runner.ack([message!.id]);
    t.clock.advance(5_000);
    expect((await call(t, await as("maya"), "POST", `/v1/canvases/${canvas.id}/stop`)).status).toBe(
      204,
    );
    await t.backgroundDone();
    const stopped = (await runner.claim()).body.events as { id: string; kind: string }[];
    expect(stopped.map((e) => e.kind)).toEqual(["stop"]);
    await runner.ack(stopped.map((e) => e.id));
    await idleToSleep(runner);
    expect((await row(canvas.id)).state).toBe("asleep");
    expect(logged("turn_lapsed", canvas.id)).toBeUndefined();
  });
});

describe("nothing left running", () => {
  test("a session Vercel ended at its timeout is followed to sleep, not restarted", async () => {
    const { canvas } = await awakeCanvas();
    const before = await row(canvas.id);
    // Thirty-one minutes with no sweep and no runner beating: Vercel's timeout ends it.
    t.clock.advance(31 * MINUTE);
    const startsBefore = starts(canvas.id).length;
    await cron();
    expect(logged("sandbox_expired", canvas.id)).toMatchObject({ sessionId: before.sessionId });
    expect(captured("sandbox slept", canvas.id)).toMatchObject({ why: "expired" });
    // Nothing waits in its feed: it stays asleep, and its runner's token is gone.
    expect((await row(canvas.id)).state).toBe("asleep");
    expect(starts(canvas.id)).toHaveLength(startsBefore);
    const [token] = await rows(
      `select revoked_at from runner_tokens where canvas_id = '${canvas.id}'
        order by created_at desc limit 1`,
    );
    expect(token!.revoked_at).not.toBeNull();
  });

  test("a turn under way holds the cycle off until close to the cap", async () => {
    const { canvas, runner } = await awakeCanvas();
    const age = async (hours: number) =>
      rows(
        `update sandboxes set session_started_at = '${new Date(t.clock.now() - hours * 3600_000).toISOString()}',
                expires_at = '${new Date(t.clock.now() + 2 * MINUTE).toISOString()}'
          where canvas_id = '${canvas.id}'`,
      );
    await age(23.6);
    await runner.beat("working");
    await cron();
    expect(captured("sandbox slept", canvas.id)).toBeUndefined();
    expect((await row(canvas.id)).state).toBe("awake");
    t.clock.advance(30_000);
    await age(23.8);
    await runner.beat("working");
    await cron();
    expect(captured("sandbox slept", canvas.id)).toMatchObject({ why: "cycle" });
  });

  test("a wake that gives up on a refusal that would have passed stops the session it resumed", async () => {
    const canvas = await fresh();
    t.sandboxes.failNext("start", nameOf(canvas.id), "unavailable");
    await wakeCanvas(t.deps, canvas.id, { id: "job_last", attempts: 40, maxAttempts: 40 });
    expect(await row(canvas.id)).toMatchObject({ state: "asleep" });
    expect((await row(canvas.id)).failure).toContain("unavailable");
    expect(await status(canvas.id)).toBe("stopped");
  });

  test("a wake waiting out a refusal after up() leaves no session running between attempts", async () => {
    const canvas = await fresh();
    t.sandboxes.failNext("start", nameOf(canvas.id), "unavailable");
    await say(canvas.id);
    expect((await row(canvas.id)).state).toBe("waking");
    expect(await status(canvas.id)).toBe("stopped");
    t.clock.advance(MINUTE);
    await cron();
    expect((await row(canvas.id)).state).toBe("awake");
    expect(await status(canvas.id)).toBe("running");
  });

  test("a wake whose canvas was settled and retired while it started stops and removes what it made", async () => {
    const canvas = await fresh();
    const name = nameOf(canvas.id);
    const start = t.sandboxes.start.bind(t.sandboxes);
    t.sandboxes.start = async (at, command, options) => {
      const started = await start(at, command, options);
      if (at.name === name) {
        // The retire ran to the end between this wake's up() and its move to awake.
        await rows(
          `update canvases set status = 'settled', settled_at = now() where id = '${canvas.id}'`,
        );
        const by = await holdForRetire(t.deps, canvas.id);
        await finishRetire(t.deps, canvas.id, by);
        await t.sandboxes.up(name, sandboxSpec(TEST_IMAGE));
      }
      return started;
    };
    try {
      await wakeCanvas(t.deps, canvas.id, job("job_retired_under"));
    } finally {
      t.sandboxes.start = start;
    }
    expect(await getSandbox(t.db, canvas.id)).toBeNull();
    expect(await t.sandboxes.status(name)).toBeNull();
    expect(logged("wake_let_go", canvas.id)).toBeDefined();
  });

  test("a second retire of a settled canvas leaves the first's hold alone", async () => {
    const { canvas } = await awakeCanvas();
    await rows(
      `update canvases set status = 'settled', settled_at = now() where id = '${canvas.id}'`,
    );
    const first = await holdForRetire(t.deps, canvas.id, { whileSettled: true });
    await retire(t.deps, canvas.id);
    expect((await row(canvas.id)).wakingBy).toBe(first as string);
    expect(await status(canvas.id)).not.toBeNull();
    await finishRetire(t.deps, canvas.id, first as string);
    expect(await getSandbox(t.db, canvas.id)).toBeNull();
    expect(await t.sandboxes.status(nameOf(canvas.id))).toBeNull();
  });

  test("a retire that lost its hold deletes nothing at Vercel", async () => {
    const { canvas } = await awakeCanvas();
    const by = await holdForRetire(t.deps, canvas.id);
    // Taken over (a delete's retire, or the sweep after the lease).
    await rows(`update sandboxes set waking_by = 'retire:other' where canvas_id = '${canvas.id}'`);
    await finishRetire(t.deps, canvas.id, by);
    expect(await t.sandboxes.status(nameOf(canvas.id))).not.toBeNull();
    expect((await row(canvas.id)).wakingBy).toBe("retire:other");
  });

  test("a retire that comes after the canvas was reopened leaves it be", async () => {
    const { canvas } = await awakeCanvas();
    await rows(
      `update canvases set status = 'settled', settled_at = now() where id = '${canvas.id}'`,
    );
    await rows(
      `update canvases set status = 'active', settled_at = null where id = '${canvas.id}'`,
    );
    await retire(t.deps, canvas.id);
    expect((await row(canvas.id)).state).toBe("awake");
    expect(await status(canvas.id)).toBe("running");
  });

  test("a repair that finds the wake moved on since the sweep looked leaves its session be", async () => {
    const { canvas } = await awakeCanvas();
    const awake = await row(canvas.id);
    // As the sweep saw it: waking, past its lease.
    const seen = {
      ...awake,
      state: "waking" as const,
      stateAt: new Date(t.clock.now() - 7 * MINUTE),
    };
    expect(await STEPS.repair(t.deps, { sandbox: seen } as SweptSandbox, 0)).toBe(false);
    expect((await row(canvas.id)).state).toBe("awake");
    expect(await status(canvas.id)).toBe("running");
  });

  test("reconcile looks at the row again before it stops a session", async () => {
    const leaked = await awakeCanvas();
    await idleToSleep(leaked.runner);
    t.sandboxes.resumeBehindOurBack(nameOf(leaked.canvas.id));
    // A wake claims it between reconcile's list and its stop.
    const list = t.sandboxes.list.bind(t.sandboxes);
    t.sandboxes.list = async (prefix, options) => {
      const listed = await list(prefix, options);
      await moveSandbox(t.db, {
        canvasId: leaked.canvas.id,
        from: ["asleep"],
        to: "waking",
        now: new Date(t.clock.now()),
        hold: "job_between",
      });
      return listed;
    };
    try {
      await reconcileCron();
    } finally {
      t.sandboxes.list = list;
    }
    expect(await status(leaked.canvas.id)).toBe("running");
  });
});

describe("a Vercel that refuses", () => {
  test("rate limited, the message waits and says so, and the wake is tried again", async () => {
    const canvas = await fresh();
    t.sandboxes.failNext("up", nameOf(canvas.id), "rate_limited", 30);
    await say(canvas.id);
    expect((await head(canvas.id)).agentBlocker).toBe("sandbox_busy");
    expect(starts(canvas.id)).toHaveLength(0);
    t.clock.advance(31_000);
    await cron();
    expect((await row(canvas.id)).state).toBe("awake");
    expect((await head(canvas.id)).agentBlocker).toBeNull();
  });

  test("a refusal that will not pass leaves the row asleep with why, and the next message tries again", async () => {
    const canvas = await fresh();
    t.sandboxes.failNext("up", nameOf(canvas.id), "rejected");
    await say(canvas.id);
    expect(await row(canvas.id)).toMatchObject({ state: "asleep" });
    expect((await row(canvas.id)).failure).toContain("rejected");
    expect((await head(canvas.id)).agentBlocker).toBe("sandbox_failed");
    expect(await pingsAbout(canvas.id)).toEqual([
      {
        userId: ws.people.maya!.userId,
        dedupeKey: `wake_failed:${canvas.id}:${new Date(t.clock.now()).toISOString()}`,
        body: "Ponzu couldn't start. Send a message to try again.",
      },
    ]);
    await say(canvas.id, "Try again");
    expect(await row(canvas.id)).toMatchObject({ state: "awake", failure: null });
  });

  test("a session that ended between up() and the start is waited out, and its token revoked", async () => {
    const canvas = await fresh();
    t.sandboxes.failNext("start", nameOf(canvas.id), "not_running");
    await say(canvas.id);
    expect((await row(canvas.id)).state).toBe("waking");
    const [token] = await rows(
      `select revoked_at from runner_tokens where canvas_id = '${canvas.id}'`,
    );
    expect(token!.revoked_at).not.toBeNull();
    t.clock.advance(MINUTE);
    await cron();
    expect((await row(canvas.id)).state).toBe("awake");
  });
});

/** The stop command's own time: what ponzu-stop is given. */
test("ponzu-stop is given its thirty seconds", async () => {
  const { canvas, runner } = await awakeCanvas();
  const exec = t.sandboxes.exec.bind(t.sandboxes);
  const given: number[] = [];
  t.sandboxes.exec = async (at, command, options) => {
    if (at.name === nameOf(canvas.id)) given.push(command.timeoutMs);
    return exec(at, command, options);
  };
  try {
    await idleToSleep(runner);
  } finally {
    t.sandboxes.exec = exec;
  }
  expect(given).toEqual([STOP_COMMAND_MS]);
  expect((await row(canvas.id)).state).toBe("asleep");
});
