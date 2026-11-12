import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sampleDoc } from "@ponzu/core/fixtures";
import {
  appendEvent,
  getDesign,
  getSandbox,
  moveSandbox,
  newId,
  recordCheckpoint,
  type SweptSandbox,
} from "@ponzu/db";
import { IMAGE_COMMANDS, RUNNER_HEADER, RUNNER_PORT } from "@ponzu/runner/protocol";
import { designSandboxName } from "@ponzu/sandbox";
import { call, designIn, type Workspace, workspaceWithRepo } from "../testing/designs.ts";
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
import { designSpec, wakeDesign } from "./orchestrate.ts";
import { finishRetire, holdForRetire, retire } from "./retire.ts";
import { putToSleep } from "./stop.ts";
import { extendBy, LAPSED_GIVE_UP, STALLED_MS, STALLED_SAID, STEPS } from "./sweep.ts";

/*
 * A design's sandbox from its first message to its retirement, through the routes and the
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
const fresh = () => designIn(t, ws, "maya", sampleDoc());
const row = async (designId: string) => (await getSandbox(t.db, designId))!;
const head = async (designId: string) => (await getDesign(t.db, designId))!;
const nameOf = (designId: string) => designSandboxName(TEST_SCOPE, designId);
const commands = (designId: string) => t.sandboxes.commands(nameOf(designId));
const starts = (designId: string) => commands(designId).filter((c) => c.kind === "start");
const stops = (designId: string) =>
  commands(designId).filter((c) => c.kind === "exec" && c.command.cmd === IMAGE_COMMANDS.stop);
const status = async (designId: string) => (await t.sandboxes.status(nameOf(designId)))?.status;

/** The newest line about this design with this event. */
const logged = (event: string, designId: string) =>
  t.logs.findLast((line) => line.event === event && line.designId === designId);

/** The newest capture of `event` about this design. */
const captured = (event: "sandbox woke" | "sandbox slept", designId: string) =>
  t.analytics.of(event).findLast((e) => e.properties.design_id === designId)?.properties;

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
async function say(designId: string, text = "Draw a calmer pricing page", who = "maya") {
  const said = await call(t, await as(who), "POST", `/v1/designs/${designId}/messages`, { text });
  expect(said.status).toBe(201);
  await t.backgroundDone();
}

async function cron() {
  const ran = await t.app.request("/v1/cron/minute", {
    headers: { authorization: `Bearer ${TEST_CRON_SECRET}` },
  });
  expect(ran.status).toBe(200);
  await t.backgroundDone();
  return (await ran.json()) as { ran: number; sandboxes: Record<string, number> };
}

/** On to a minute the sweep reconciles in (every tenth), and sweep. */
async function reconcileCron() {
  const minute = new Date(t.clock.now()).getUTCMinutes();
  t.clock.advance(((10 - (minute % 10)) % 10) * MINUTE + 1000);
  return cron();
}

/** The env of the design's last runner start. */
const startEnv = (designId: string) => starts(designId).at(-1)!.command.env!;

/** The runner the last start started: it takes the lease with the token its env carries. */
async function runnerIn(designId: string) {
  const token = startEnv(designId).PONZU_RUNNER_TOKEN!;
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
 * A design whose sandbox is awake with its runner started, as after a first message. Its runner
 * has taken the message and answered it, unless `answered` is false.
 */
async function awakeDesign({ answered = true }: { answered?: boolean } = {}) {
  const design = await fresh();
  await say(design.id);
  expect((await row(design.id)).state).toBe("awake");
  const runner = await runnerIn(design.id);
  if (answered) await answerAll(runner);
  return { design, runner };
}

/** The runner saves a checkpoint through everything it has delivered. */
async function checkpoint(designId: string, runner: Runner, turn: number) {
  await recordCheckpoint(t.db, {
    designId,
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
async function threadAfterLastMessage(designId: string) {
  const all = await rows(
    `select kind, payload from thread_items where design_id = '${designId}' order by seq`,
  );
  const last = all.findLastIndex((item) => item.kind === "message");
  return all.slice(last + 1) as { kind: string; payload: Record<string, unknown> }[];
}

/** The design's feed, oldest first. */
const feed = async (designId: string) =>
  (await rows(
    `select id, kind, payload, delivered_at, lapsed_at from events
      where design_id = '${designId}' order by seq`,
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
    const design = await fresh();
    await say(design.id);
    const name = nameOf(design.id);
    const sandbox = await row(design.id);
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
    expect(commands(design.id)).toEqual([
      {
        sessionId: sandbox.sessionId!,
        kind: "start",
        command: { cmd: IMAGE_COMMANDS.start, env: expect.any(Object), sudo: true },
      },
    ]);
    const env = startEnv(design.id);
    // Exactly one Claude credential, and the bundle this API serves.
    expect(Object.keys(env).toSorted()).toEqual([
      "ANTHROPIC_API_KEY",
      "PONZU_API_URL",
      "PONZU_DESIGN_ID",
      "PONZU_PORT_TOKEN",
      "PONZU_RUNNER_BUNDLE",
      "PONZU_RUNNER_TOKEN",
    ]);
    expect(env).toMatchObject({
      ANTHROPIC_API_KEY: KEY,
      PONZU_API_URL: TEST_API_URL,
      PONZU_DESIGN_ID: design.id,
      PONZU_RUNNER_BUNDLE: TEST_BUNDLE.sha256,
    });
    expect(env.PONZU_PORT_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Nothing of it is in the row, and the port's token only sealed.
    expect(JSON.stringify(sandbox)).not.toContain(env.PONZU_PORT_TOKEN);
    expect(captured("sandbox woke", design.id)).toMatchObject({
      start: "create",
      fresh: true,
      recreated: false,
      image: TEST_IMAGE,
    });
    expect((await head(design.id)).agentState).toBe("waking");

    // The runner takes the lease with its token; the next message pokes it with the port's.
    const runner = await runnerIn(design.id);
    expect(runner.status).toBe(200);
    t.poke.pokes.length = 0;
    await say(design.id, "And the footer");
    expect(t.poke.pokes).toEqual([{ url: sandbox.address!, token: env.PONZU_PORT_TOKEN! }]);
    expect(starts(design.id)).toHaveLength(1);
  });

  test("two wakes at once make one up(): the rest leave it be", async () => {
    const design = await fresh();
    await Promise.all([1, 2, 3].map((n) => wakeDesign(t.deps, design.id, job(`job_race_${n}`))));
    expect(starts(design.id)).toHaveLength(1);
    expect(t.sandboxes.resumes(nameOf(design.id))).toBe(0);
  });

  test("a name that is there without a row is taken on, and its configuration brought up to date", async () => {
    const design = await fresh();
    const name = nameOf(design.id);
    // Made with another timeout, and stopped: as if by an older API.
    const old = await t.sandboxes.up(name, { ...designSpec(TEST_IMAGE), timeoutMs: 5 * MINUTE });
    await t.sandboxes.stop({ name, sessionId: old.sessionId });
    await say(design.id);
    expect(t.sandboxes.config(name)).toMatchObject({
      spec: { timeoutMs: SESSION_TIMEOUT_MS },
      updates: 1,
    });
    expect((await row(design.id)).state).toBe("awake");
    expect(captured("sandbox woke", design.id)).toMatchObject({ start: "resume" });
  });
});

const job = (id: string) => ({ id, attempts: 1, maxAttempts: 40 });

describe("sleep and wake", () => {
  test("five minutes idle shuts the runner down, then stops; a message resumes it on its disk", async () => {
    const { design, runner } = await awakeDesign();
    const first = await row(design.id);
    await idleToSleep(runner);
    const asleep = await row(design.id);
    expect(asleep).toMatchObject({
      state: "asleep",
      address: null,
      encryptedPortToken: null,
      sessionId: first.sessionId,
    });
    // ponzu-stop, as root and waited, pinned to the session; then Vercel's stop.
    expect(stops(design.id)).toEqual([
      {
        sessionId: first.sessionId!,
        kind: "exec",
        command: { cmd: IMAGE_COMMANDS.stop, sudo: true },
      },
    ]);
    expect(await status(design.id)).toBe("stopped");
    // The runner's token goes with it.
    expect((await runner.beat()).status).toBe(401);
    expect(captured("sandbox slept", design.id)).toMatchObject({
      why: "idle",
    });
    const [used] = await rows(
      `select id, seconds from usage_events where design_id = '${design.id}' and kind = 'sandbox'`,
    );
    expect(used!.id).toBe(`${design.id}/${first.awakeSince!.getTime()}`);

    await say(design.id, "Now the header");
    const woke = await row(design.id);
    expect(woke.state).toBe("awake");
    expect(woke.sessionId).not.toBe(first.sessionId);
    expect(t.sandboxes.resumes(nameOf(design.id))).toBe(1);
    expect(captured("sandbox woke", design.id)).toMatchObject({
      start: "resume",
      fresh: false,
      recreated: false,
    });
    // A new token and port token at every start.
    expect(startEnv(design.id).PONZU_RUNNER_TOKEN).not.toBe(runner.token);
  });

  test("an idle stop loses to a fresh message", async () => {
    const { design } = await awakeDesign();
    const before = await row(design.id);
    t.clock.advance(6 * MINUTE);
    await say(design.id, "One more thing");
    expect(
      await putToSleep(t.deps, before, "idle", {
        idleBefore: new Date(t.clock.now() - 5 * MINUTE),
      }),
    ).toBe(false);
    expect((await row(design.id)).state).toBe("awake");
    expect(stops(design.id)).toEqual([]);
  });

  test("an agent that keeps working keeps it awake, and its session is extended", async () => {
    const { design, runner } = await awakeDesign();
    const before = await row(design.id);
    for (let i = 0; i < 50; i++) {
      t.clock.advance(30_000);
      await runner.beat("working");
      if (i % 2 === 1) await cron();
    }
    const after = await row(design.id);
    expect(after.state).toBe("awake");
    expect(after.sessionId).toBe(before.sessionId);
    expect(after.expiresAt!.getTime()).toBeGreaterThan(before.expiresAt!.getTime());
    expect(after.expiresAt!.getTime()).toBeGreaterThan(t.clock.now() + 10 * MINUTE - 1);
  });

  test("a wake during a stop waits for it to land, then resumes", async () => {
    const { design } = await awakeDesign();
    const awake = await row(design.id);
    await moveSandbox(t.db, {
      designId: design.id,
      from: ["awake"],
      to: "stopping",
      now: new Date(t.clock.now()),
      hold: "stop:elsewhere",
    });
    const resumes = t.sandboxes.resumes(nameOf(design.id));
    await withSleeps(
      async (count) => {
        if (count !== 3) return;
        // The stop lands, three seconds in.
        await t.sandboxes.stop({ name: nameOf(design.id), sessionId: awake.sessionId! });
        await moveSandbox(t.db, {
          designId: design.id,
          from: ["stopping"],
          to: "asleep",
          now: new Date(t.clock.now()),
          by: "stop:elsewhere",
        });
      },
      () => wakeDesign(t.deps, design.id, job("job_after_stop")),
    );
    expect((await row(design.id)).state).toBe("awake");
    expect(t.sandboxes.resumes(nameOf(design.id))).toBe(resumes + 1);
  });

  test("a stop still under way after its wait is tried again later", async () => {
    const { design } = await awakeDesign();
    await moveSandbox(t.db, {
      designId: design.id,
      from: ["awake"],
      to: "stopping",
      now: new Date(t.clock.now()),
      hold: "stop:stuck",
    });
    await expect(wakeDesign(t.deps, design.id, job("job_stuck"))).rejects.toMatchObject({
      name: "RetryLater",
    });
    expect((await head(design.id)).agentState).toBe("waking");
  });

  test("the sweep never resumes a sandbox", async () => {
    const { design, runner } = await awakeDesign();
    await idleToSleep(runner);
    const resumes = t.sandboxes.resumes(nameOf(design.id));
    for (let i = 0; i < 12; i++) {
      t.clock.advance(MINUTE);
      await cron();
    }
    await reconcileCron();
    expect(t.sandboxes.resumes(nameOf(design.id))).toBe(resumes);
    expect(await status(design.id)).toBe("stopped");
  });
});

describe("a restart in place", () => {
  test("a credential changed while it is awake shuts the runner down and starts it again in the same session", async () => {
    const { design, runner } = await awakeDesign();
    const before = await row(design.id);
    t.clock.advance(MINUTE);
    await connectKey("maya", OTHER_KEY);
    await say(design.id, "Carry on");
    const after = await row(design.id);
    expect(after).toMatchObject({ state: "awake", sessionId: before.sessionId });
    // The session's start is kept: the cycle and the extend clamp count from it.
    expect(after.sessionStartedAt).toEqual(before.sessionStartedAt);
    const [stop, start] = commands(design.id).slice(-2);
    expect(stop).toMatchObject({ kind: "exec", command: { cmd: IMAGE_COMMANDS.stop } });
    expect(start).toMatchObject({ kind: "start", sessionId: before.sessionId });
    expect(startEnv(design.id).ANTHROPIC_API_KEY).toBe(OTHER_KEY);
    expect(captured("sandbox woke", design.id)).toMatchObject({ start: "restart" });
    // The runner it replaced is done.
    expect((await runner.beat()).status).toBe(401);
    await connectKey("maya", KEY);
  });

  test("a session left running behind an asleep row is shut down before the runner starts", async () => {
    const { design, runner } = await awakeDesign();
    await idleToSleep(runner);
    t.sandboxes.resumeBehindOurBack(nameOf(design.id));
    const running = (await t.sandboxes.status(nameOf(design.id)))!;
    await say(design.id, "Again");
    const [stop, start] = commands(design.id).slice(-2);
    expect(stop).toMatchObject({
      sessionId: running.sessionId,
      command: { cmd: IMAGE_COMMANDS.stop },
    });
    expect(start).toMatchObject({ sessionId: running.sessionId, kind: "start" });
  });
});

describe("a dead runner", () => {
  test("is shut down and started again, and after three in a row the sandbox fails", async () => {
    const { design } = await awakeDesign();
    for (let restart = 1; restart <= 3; restart++) {
      t.clock.advance(2 * MINUTE);
      await cron();
      expect(logged("runner_dead", design.id)).toMatchObject({ restarts: restart });
      expect((await row(design.id)).state).toBe("awake");
    }
    expect(starts(design.id)).toHaveLength(4);
    t.clock.advance(2 * MINUTE);
    await cron();
    expect(await row(design.id)).toMatchObject({
      state: "asleep",
      failure: "Its runner stopped answering 4 times in a row.",
    });
    expect((await head(design.id)).agentBlocker).toBe("sandbox_failed");
    expect(await status(design.id)).toBe("stopped");
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
    const { design } = await awakeDesign();
    const before = await row(design.id);
    const now = t.clock.now();
    await rows(
      `update sandboxes set session_started_at = '${new Date(now - 23.6 * 3600_000).toISOString()}',
              expires_at = '${new Date(now + 2 * MINUTE).toISOString()}'
        where design_id = '${design.id}'`,
    );
    await appendEvent(t.db, {
      designId: design.id,
      kind: "message",
      priority: "now",
      payload: { text: "Still here" },
      userId: ws.people.maya!.userId,
    });
    await cron();
    expect(captured("sandbox slept", design.id)).toMatchObject({ why: "cycle" });
    // The pending rule: a new session for the message no runner took.
    const after = await row(design.id);
    expect(after.state).toBe("awake");
    expect(after.sessionId).not.toBe(before.sessionId);
  });

  test("an extend that finds the session stopped sends the row to sleep, and the pending rule wakes it", async () => {
    const { design, runner } = await awakeDesign();
    const before = await row(design.id);
    // Thirty minutes of work with no sweep: Vercel's own timeout ends the session.
    for (let i = 0; i < 62; i++) {
      t.clock.advance(30_000);
      await runner.beat("working");
    }
    expect(await status(design.id)).toBe("stopped");
    await appendEvent(t.db, {
      designId: design.id,
      kind: "message",
      priority: "now",
      payload: { text: "Are you there?" },
      userId: ws.people.maya!.userId,
    });
    await cron();
    expect(logged("sandbox_expired", design.id)).toMatchObject({ sessionId: before.sessionId });
    expect(captured("sandbox slept", design.id)).toMatchObject({ why: "expired" });
    const after = await row(design.id);
    expect(after.state).toBe("awake");
    expect(after.sessionId).not.toBe(before.sessionId);
  });
});

describe("a fresh disk", () => {
  test("an expired snapshot, or a sandbox Vercel removed, wakes on an empty disk", async () => {
    const { design, runner } = await awakeDesign();
    await idleToSleep(runner);
    t.sandboxes.expire(nameOf(design.id));
    await say(design.id, "After a long while");
    expect(captured("sandbox woke", design.id)).toMatchObject({
      start: "create",
      fresh: true,
    });
    const again = await runnerIn(design.id);
    await answerAll(again);
    await idleToSleep(again);
    t.sandboxes.retain(nameOf(design.id));
    await say(design.id, "After longer still");
    expect((await row(design.id)).state).toBe("awake");
    expect(captured("sandbox woke", design.id)).toMatchObject({
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
    const { design, runner } = await awakeDesign();
    await checkpoint(design.id, runner, 1);
    await idleToSleep(runner);
    const resumes = t.sandboxes.resumes(nameOf(design.id));
    await onImage(NEXT, () => say(design.id, "On the new image"));
    expect(t.sandboxes.resumes(nameOf(design.id))).toBe(resumes);
    expect(t.sandboxes.config(nameOf(design.id)).image).toEndWith(NEXT);
    expect(await row(design.id)).toMatchObject({ state: "awake", image: NEXT });
    expect(captured("sandbox woke", design.id)).toMatchObject({
      fresh: true,
      recreated: true,
      image: NEXT,
    });
  });

  test("waits while the last checkpoint does not hold everything that went into the session", async () => {
    const { design, runner } = await awakeDesign();
    await idleToSleep(runner);
    // No checkpoint at all: the old image, and the log says why.
    await onImage(NEXT, () => say(design.id, "Not yet"));
    expect(await row(design.id)).toMatchObject({ image: TEST_IMAGE });
    expect(logged("sandbox_move_held", design.id)).toMatchObject({ reason: "no_checkpoint" });

    // A checkpoint through everything delivered: the next wake moves it.
    const next = await runnerIn(design.id);
    await answerAll(next);
    await checkpoint(design.id, next, 2);
    await idleToSleep(next);
    await onImage(NEXT, () => say(design.id, "Now"));
    expect(await row(design.id)).toMatchObject({ image: NEXT });
  });
});

describe("disconnecting Claude", () => {
  test("puts every awake runner holding it to sleep at once, and leaves asleep ones be", async () => {
    const asleep = await awakeDesign();
    await idleToSleep(asleep.runner);
    const awake = await awakeDesign();
    const asleepCommands = commands(asleep.design.id).length;
    const disconnected = await call(t, await as("maya"), "DELETE", "/v1/claude");
    expect(disconnected.status).toBe(204);
    await t.backgroundDone();
    expect((await row(awake.design.id)).state).toBe("asleep");
    expect(await status(awake.design.id)).toBe("stopped");
    expect(stops(awake.design.id)).toHaveLength(1);
    expect(captured("sandbox slept", awake.design.id)).toMatchObject({
      why: "claude_disconnected",
    });
    // Not destroyed: its disk holds the design's work, and no credential.
    expect(await status(asleep.design.id)).toBe("stopped");
    expect(commands(asleep.design.id)).toHaveLength(asleepCommands);
    expect((await head(asleep.design.id)).agentBlocker).toBe("claude_not_connected");
    await connectKey("maya", KEY);
  });
});

describe("the end of a design", () => {
  test("settling holds the row while the sandbox is stopped and deleted, then deletes the row", async () => {
    const { design, runner } = await awakeDesign();
    const settled = await call(t, await as("maya"), "PATCH", `/v1/designs/${design.id}`, {
      settled: true,
    });
    expect(settled.status).toBe(200);
    await t.backgroundDone();
    expect(await getSandbox(t.db, design.id)).toBeNull();
    expect(await t.sandboxes.status(nameOf(design.id))).toBeNull();
    expect((await runner.beat()).status).toBe(401);
  });

  test("a design reopened during its retire waits for it, and its new sandbox is never deleted", async () => {
    const { design } = await awakeDesign();
    await rows(
      `update designs set status = 'settled', settled_at = now() where id = '${design.id}'`,
    );
    const by = await holdForRetire(t.deps, design.id);
    expect((await row(design.id)).wakingBy).toBe(by);
    await rows(`update designs set status = 'active', settled_at = null where id = '${design.id}'`);
    await withSleeps(
      async (count) => {
        // The retire finishes while the reopened design's wake waits for the row.
        if (count === 2) await finishRetire(t.deps, design.id, by);
      },
      () => wakeDesign(t.deps, design.id, job("job_reopen")),
    );
    expect(await row(design.id)).toMatchObject({ state: "awake" });
    expect(await status(design.id)).toBe("running");
  });

  test("deleting the design deletes its sandbox and keeps its usage", async () => {
    const { design } = await awakeDesign();
    t.clock.advance(MINUTE);
    const deleted = await call(t, await as("maya"), "DELETE", `/v1/designs/${design.id}`);
    expect(deleted.status).toBe(204);
    await t.backgroundDone();
    expect(await t.sandboxes.status(nameOf(design.id))).toBeNull();
    expect(
      await rows(
        `select seconds from usage_events where design_id is null or design_id = '${design.id}'`,
      ),
    ).not.toEqual([]);
  });

  test("a sandbox whose design was deleted is removed by reconcile", async () => {
    const orphan = nameOf("des_deleted0000000");
    await t.sandboxes.up(orphan, designSpec(TEST_IMAGE));
    await reconcileCron();
    expect(await t.sandboxes.status(orphan)).toBeNull();
    expect(t.logs.findLast((l) => l.event === "sandbox_orphan_removed")).toMatchObject({
      name: orphan,
    });
  });
});

describe("reconcile", () => {
  test("stops a sandbox resumed behind an asleep row, and leaves a waking one inside its lease", async () => {
    const leaked = await awakeDesign();
    await idleToSleep(leaked.runner);
    t.sandboxes.resumeBehindOurBack(nameOf(leaked.design.id));

    const waking = await awakeDesign();
    await moveSandbox(t.db, {
      designId: waking.design.id,
      from: ["awake"],
      to: "waking",
      now: new Date(t.clock.now()),
      by: "job_slow",
    });
    // A session the row does not know of yet: the wake holding it is making it.
    await rows(
      `update sandboxes set session_id = 'sbx_not_yet' where design_id = '${waking.design.id}'`,
    );

    await reconcileCron();
    expect(await status(leaked.design.id)).toBe("stopped");
    expect(t.logs.findLast((l) => l.event === "sandbox_leak")).toMatchObject({
      name: nameOf(leaked.design.id),
    });
    expect(await status(waking.design.id)).toBe("running");
  });

  test("looks only at this database's names", async () => {
    const theirs = designSandboxName("0123456789ab", "des_theirs00000000");
    await t.sandboxes.up(theirs, designSpec(TEST_IMAGE));
    await reconcileCron();
    expect((await t.sandboxes.status(theirs))?.status).toBe("running");
    await t.sandboxes.remove(theirs);
  });
});

describe("a turn that never came", () => {
  test("a message delivered with nothing after it is not slept on: it is said and sent again", async () => {
    const { design, runner } = await awakeDesign({ answered: false });
    const claimed = await runner.claim();
    const [message] = claimed.body.events as { id: string }[];
    await runner.ack([message!.id]);
    // Past the idle window, its runner idle and silent: never slept, and lapsed at two minutes.
    await idleToSleep(runner);
    expect((await row(design.id)).state).toBe("awake");
    expect(logged("turn_lapsed", design.id)).toMatchObject({ events: [message!.id] });
    const copy = (
      await rows(
        `select id, payload from events where design_id = '${design.id}' order by seq desc limit 1`,
      )
    )[0] as { id: string; payload: { retryOf: string } };
    expect(copy.payload.retryOf).toBe(message!.id);
    // The runner claims the copy as a new message and answers; then it sleeps.
    const again = await runner.claim();
    expect(again.body.events.map((e: { id: string }) => e.id)).toEqual([copy.id]);
    await runner.ack([copy.id]);
    await runner.answer();
    await idleToSleep(runner);
    expect((await row(design.id)).state).toBe("asleep");
  });

  test("a runner that says it works and writes nothing for fifteen minutes is started again", async () => {
    const { design, runner } = await awakeDesign({ answered: false });
    const token = startEnv(design.id).PONZU_RUNNER_TOKEN;
    const claimed = await runner.claim();
    const [message] = claimed.body.events as { id: string }[];
    await runner.ack([message!.id]);
    // A long session's first answer can take minutes: working, it is waited for.
    await beatFor(runner, 10 * MINUTE, "working");
    expect(logged("turn_lapsed", design.id)).toBeUndefined();
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
    expect(logged("turn_lapsed", design.id)).toMatchObject({ agentState: "working" });
    expect(heardAtStop as number | null).toBe(401);
    // Its runner shut down and started again; the copy is the next runner's.
    expect(stops(design.id).length).toBeGreaterThanOrEqual(1);
    expect(startEnv(design.id).PONZU_RUNNER_TOKEN).not.toBe(token);
    expect((await row(design.id)).state).toBe("awake");
    const copy = (await feed(design.id)).at(-1)!;
    expect(copy.payload.retryOf).toBe(message!.id);
    const next = await runnerIn(design.id);
    expect((await next.claim()).body.events.map((e: { id: string }) => e.id)).toEqual([copy.id]);
  });

  test("a copy that gets no turn either says to send it again, and is not sent a third time", async () => {
    const { design, runner } = await awakeDesign({ answered: false });
    const [message] = (await runner.claim()).body.events as { id: string }[];
    await runner.ack([message!.id]);
    await idleToSleep(runner);
    const copy = (await feed(design.id)).at(-1)!;
    expect(copy.payload.retryOf).toBe(message!.id);

    await runner.ack((await runner.claim()).body.events.map((e: { id: string }) => e.id));
    await idleToSleep(runner);
    expect((await row(design.id)).state).toBe("awake");
    expect((await threadAfterLastMessage(design.id)).at(-1)).toEqual({
      kind: "notice",
      payload: { type: "error", code: "turn_failed", message: LAPSED_GIVE_UP },
    });
    expect(await feed(design.id)).toHaveLength(2);
    // Nothing is owed now: the next idle sweep puts it to sleep.
    await idleToSleep(runner);
    expect((await row(design.id)).state).toBe("asleep");
  });

  test("a turn that wrote and then went quiet for an hour, its runner still saying working, is started again", async () => {
    const { design, runner } = await awakeDesign({ answered: false });
    const token = startEnv(design.id).PONZU_RUNNER_TOKEN;
    const [message] = (await runner.claim()).body.events as { id: string }[];
    await runner.ack([message!.id]);
    await runner.answer("Looking at the pricing page.");

    // Swept every minute (other designs' jobs move the shared clock on too) until it is stalled:
    // an hour after it last wrote, and not before.
    for (let i = 0; i < 70 && !logged("turn_stalled", design.id); i++) {
      await beatFor(runner, MINUTE, "working");
    }
    const stalledLine = logged("turn_stalled", design.id) as { saidMs: number } | undefined;
    expect(stalledLine?.saidMs).toBeGreaterThanOrEqual(STALLED_MS);
    expect(stalledLine!.saidMs).toBeLessThan(STALLED_MS + 3 * MINUTE);
    expect((await threadAfterLastMessage(design.id)).at(-1)).toEqual({
      kind: "notice",
      payload: { type: "error", code: "turn_failed", message: STALLED_SAID },
    });
    // Put to sleep and woken again at once, for the stall.
    expect(captured("sandbox slept", design.id)).toMatchObject({ why: "restart" });
    const [wake] = await rows(
      `select payload from jobs where kind = 'sandbox.wake' and key = '${design.id}'
        order by run_at desc limit 1`,
    );
    expect(wake!.payload).toMatchObject({ reason: "stalled" });
    expect(startEnv(design.id).PONZU_RUNNER_TOKEN).not.toBe(token);
    expect((await row(design.id)).state).toBe("awake");
  });

  test("a message answered is owed nothing, and its sandbox sleeps as before", async () => {
    const { design, runner } = await awakeDesign({ answered: false });
    const [message] = (await runner.claim()).body.events as { id: string }[];
    await runner.ack([message!.id]);
    t.clock.advance(20_000);
    await runner.answer();
    await idleToSleep(runner);
    expect((await row(design.id)).state).toBe("asleep");
    expect(logged("turn_lapsed", design.id)).toBeUndefined();
  });

  test("a message the person stopped before anything was written is not sent again", async () => {
    // Stopped while it was starting: the runner ends it before the turn has said anything, and
    // writes no `stopped` notice for a turn that had not begun. The stop is the answer.
    const { design, runner } = await awakeDesign({ answered: false });
    const [message] = (await runner.claim()).body.events as { id: string }[];
    await runner.ack([message!.id]);
    t.clock.advance(5_000);
    expect((await call(t, await as("maya"), "POST", `/v1/designs/${design.id}/stop`)).status).toBe(
      204,
    );
    await t.backgroundDone();
    const stopped = (await runner.claim()).body.events as { id: string; kind: string }[];
    expect(stopped.map((e) => e.kind)).toEqual(["stop"]);
    await runner.ack(stopped.map((e) => e.id));
    await idleToSleep(runner);
    expect((await row(design.id)).state).toBe("asleep");
    expect(logged("turn_lapsed", design.id)).toBeUndefined();
  });
});

describe("nothing left running", () => {
  test("a session Vercel ended at its timeout is followed to sleep, not restarted", async () => {
    const { design } = await awakeDesign();
    const before = await row(design.id);
    // Thirty-one minutes with no sweep and no runner beating: Vercel's timeout ends it.
    t.clock.advance(31 * MINUTE);
    const startsBefore = starts(design.id).length;
    await cron();
    expect(logged("sandbox_expired", design.id)).toMatchObject({ sessionId: before.sessionId });
    expect(captured("sandbox slept", design.id)).toMatchObject({ why: "expired" });
    // Nothing waits in its feed: it stays asleep, and its runner's token is gone.
    expect((await row(design.id)).state).toBe("asleep");
    expect(starts(design.id)).toHaveLength(startsBefore);
    const [token] = await rows(
      `select revoked_at from runner_tokens where design_id = '${design.id}'
        order by created_at desc limit 1`,
    );
    expect(token!.revoked_at).not.toBeNull();
  });

  test("a turn under way holds the cycle off until close to the cap", async () => {
    const { design, runner } = await awakeDesign();
    const age = async (hours: number) =>
      rows(
        `update sandboxes set session_started_at = '${new Date(t.clock.now() - hours * 3600_000).toISOString()}',
                expires_at = '${new Date(t.clock.now() + 2 * MINUTE).toISOString()}'
          where design_id = '${design.id}'`,
      );
    await age(23.6);
    await runner.beat("working");
    await cron();
    expect(captured("sandbox slept", design.id)).toBeUndefined();
    expect((await row(design.id)).state).toBe("awake");
    t.clock.advance(30_000);
    await age(23.8);
    await runner.beat("working");
    await cron();
    expect(captured("sandbox slept", design.id)).toMatchObject({ why: "cycle" });
  });

  test("a wake that gives up on a refusal that would have passed stops the session it resumed", async () => {
    const design = await fresh();
    t.sandboxes.failNext("start", nameOf(design.id), "unavailable");
    await wakeDesign(t.deps, design.id, { id: "job_last", attempts: 40, maxAttempts: 40 });
    expect(await row(design.id)).toMatchObject({ state: "asleep" });
    expect((await row(design.id)).failure).toContain("unavailable");
    expect(await status(design.id)).toBe("stopped");
  });

  test("a wake waiting out a refusal after up() leaves no session running between attempts", async () => {
    const design = await fresh();
    t.sandboxes.failNext("start", nameOf(design.id), "unavailable");
    await say(design.id);
    expect((await row(design.id)).state).toBe("waking");
    expect(await status(design.id)).toBe("stopped");
    t.clock.advance(MINUTE);
    await cron();
    expect((await row(design.id)).state).toBe("awake");
    expect(await status(design.id)).toBe("running");
  });

  test("a wake whose design was settled and retired while it started stops and removes what it made", async () => {
    const design = await fresh();
    const name = nameOf(design.id);
    const start = t.sandboxes.start.bind(t.sandboxes);
    t.sandboxes.start = async (at, command, options) => {
      const started = await start(at, command, options);
      if (at.name === name) {
        // The retire ran to the end between this wake's up() and its move to awake.
        await rows(
          `update designs set status = 'settled', settled_at = now() where id = '${design.id}'`,
        );
        const by = await holdForRetire(t.deps, design.id);
        await finishRetire(t.deps, design.id, by);
        await t.sandboxes.up(name, designSpec(TEST_IMAGE));
      }
      return started;
    };
    try {
      await wakeDesign(t.deps, design.id, job("job_retired_under"));
    } finally {
      t.sandboxes.start = start;
    }
    expect(await getSandbox(t.db, design.id)).toBeNull();
    expect(await t.sandboxes.status(name)).toBeNull();
    expect(logged("wake_let_go", design.id)).toBeDefined();
  });

  test("a retire that comes after the design was reopened leaves it be", async () => {
    const { design } = await awakeDesign();
    await rows(
      `update designs set status = 'settled', settled_at = now() where id = '${design.id}'`,
    );
    await rows(`update designs set status = 'active', settled_at = null where id = '${design.id}'`);
    await retire(t.deps, design.id);
    expect((await row(design.id)).state).toBe("awake");
    expect(await status(design.id)).toBe("running");
  });

  test("a repair that finds the wake moved on since the sweep looked leaves its session be", async () => {
    const { design } = await awakeDesign();
    const awake = await row(design.id);
    // As the sweep saw it: waking, past its lease.
    const seen = {
      ...awake,
      state: "waking" as const,
      stateAt: new Date(t.clock.now() - 7 * MINUTE),
    };
    expect(await STEPS.repair(t.deps, { sandbox: seen } as SweptSandbox, 0)).toBe(false);
    expect((await row(design.id)).state).toBe("awake");
    expect(await status(design.id)).toBe("running");
  });

  test("reconcile looks at the row again before it stops a session", async () => {
    const leaked = await awakeDesign();
    await idleToSleep(leaked.runner);
    t.sandboxes.resumeBehindOurBack(nameOf(leaked.design.id));
    // A wake claims it between reconcile's list and its stop.
    const list = t.sandboxes.list.bind(t.sandboxes);
    t.sandboxes.list = async (prefix, options) => {
      const listed = await list(prefix, options);
      await moveSandbox(t.db, {
        designId: leaked.design.id,
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
    expect(await status(leaked.design.id)).toBe("running");
  });
});

describe("a Vercel that refuses", () => {
  test("rate limited, the message waits and says so, and the wake is tried again", async () => {
    const design = await fresh();
    t.sandboxes.failNext("up", nameOf(design.id), "rate_limited", 30);
    await say(design.id);
    expect((await head(design.id)).agentBlocker).toBe("sandbox_busy");
    expect(starts(design.id)).toHaveLength(0);
    t.clock.advance(31_000);
    await cron();
    expect((await row(design.id)).state).toBe("awake");
    expect((await head(design.id)).agentBlocker).toBeNull();
  });

  test("a refusal that will not pass leaves the row asleep with why, and the next message tries again", async () => {
    const design = await fresh();
    t.sandboxes.failNext("up", nameOf(design.id), "rejected");
    await say(design.id);
    expect(await row(design.id)).toMatchObject({ state: "asleep" });
    expect((await row(design.id)).failure).toContain("rejected");
    expect((await head(design.id)).agentBlocker).toBe("sandbox_failed");
    await say(design.id, "Try again");
    expect(await row(design.id)).toMatchObject({ state: "awake", failure: null });
  });

  test("a session that ended between up() and the start is waited out, and its token revoked", async () => {
    const design = await fresh();
    t.sandboxes.failNext("start", nameOf(design.id), "not_running");
    await say(design.id);
    expect((await row(design.id)).state).toBe("waking");
    const [token] = await rows(
      `select revoked_at from runner_tokens where design_id = '${design.id}'`,
    );
    expect(token!.revoked_at).not.toBeNull();
    t.clock.advance(MINUTE);
    await cron();
    expect((await row(design.id)).state).toBe("awake");
  });
});

/** The stop command's own time: what ponzu-stop is given. */
test("ponzu-stop is given its thirty seconds", async () => {
  const { design, runner } = await awakeDesign();
  const exec = t.sandboxes.exec.bind(t.sandboxes);
  const given: number[] = [];
  t.sandboxes.exec = async (at, command, options) => {
    if (at.name === nameOf(design.id)) given.push(command.timeoutMs);
    return exec(at, command, options);
  };
  try {
    await idleToSleep(runner);
  } finally {
    t.sandboxes.exec = exec;
  }
  expect(given).toEqual([STOP_COMMAND_MS]);
  expect((await row(design.id)).state).toBe("asleep");
});
