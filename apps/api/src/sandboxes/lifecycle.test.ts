import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sampleDoc } from "@ponzu/core/fixtures";
import {
  appendEvent,
  askRunnerToPush,
  getDesign,
  getLiveSandbox,
  moveSandbox,
  newId,
  recordCheckpoint,
  type Sandbox,
} from "@ponzu/db";
import { RUNNER_HEADER } from "@ponzu/runner/protocol";
import { SandboxError } from "@ponzu/sandbox";
import { call, designIn, type Workspace, workspaceWithRepo } from "../testing/designs.ts";
import {
  createTestApp,
  TEST_API_URL,
  TEST_CRON_SECRET,
  TEST_SCOPE,
  TEST_SNAPSHOT,
  type TestApp,
} from "../testing/index.ts";
import { sandboxLabels, wakeDesign } from "./orchestrate.ts";

/*
 * A design's sandbox from its first message to its deletion, through the routes and the
 * minute's cron, on the in-memory provider and the test's clock.
 */

let t: TestApp;
let ws: Workspace;
const KEY = "sk-ant-api03-maya-first-key-0000000000";
const OTHER_KEY = "sk-ant-api03-maya-second-key-000000000";

beforeAll(async () => {
  t = await createTestApp();
  ws = await workspaceWithRepo(t, { maya: "write", ines: "write" });
  await connectKey("maya", KEY);
});
afterAll(() => t.close());

/**
 * Runs the tests of the `describe` this is called in on an app of their own, made with
 * `options`, with Maya's key connected in a workspace of Maya, Ines and Omar.
 */
function onAppOfTheirOwn(options: Parameters<typeof createTestApp>[0] = {}) {
  let saved: { t: TestApp; ws: Workspace };
  beforeAll(async () => {
    saved = { t, ws };
    t = await createTestApp(options);
    ws = await workspaceWithRepo(t, { maya: "write", ines: "write", omar: "write" });
    await connectKey("maya", KEY);
  });
  afterAll(async () => {
    await t.close();
    ({ t, ws } = saved);
  });
}

/** A fresh sign-in: the test clock runs past an access token's five minutes. */
const as = async (login: string) => (await t.signInAs({ login })).headers;
const fresh = () => designIn(t, ws, "maya", sampleDoc());
const live = async (designId: string) => (await getLiveSandbox(t.db, designId))!;
const head = async (designId: string) => (await getDesign(t.db, designId))!;
const machines = (designId: string) => t.sandbox.list({ labels: { design: designId } });
const MINUTE = 60_000;

/** The newest line about this design with this event. */
const logged = (event: string, designId: string) =>
  t.logs.findLast((line) => line.event === event && line.designId === designId);

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
  return (await ran.json()) as {
    ran: number;
    sandboxes: Record<string, number>;
    signIns: number;
  };
}

/**
 * The runner in the design's sandbox, as it starts: it takes the lease with the token its
 * environment carries. `beat` is its heartbeat.
 */
async function runnerIn(sandbox: Sandbox, client?: string) {
  const token = t.sandbox.env(sandbox.providerId!).PONZU_RUNNER_TOKEN!;
  const started = await call(
    t,
    { authorization: `Bearer ${token}`, ...(client ? { "x-ponzu-client": client } : {}) },
    "POST",
    "/v1/runner/session",
    {},
  );
  const headers = { authorization: `Bearer ${token}`, [RUNNER_HEADER]: started.body?.runnerId };
  const beat = (state: "working" | "idle" = "idle", quiesced?: string | null) =>
    call(t, headers, "PUT", "/v1/runner/state", {
      state,
      status: null,
      artboards: [],
      claudeSessionId: "session-1",
      ...(quiesced === undefined ? {} : { quiesced }),
    });
  return {
    status: started.status,
    session: started.body,
    beat,
    claim: (claimId = newId("clm")) =>
      call(t, headers, "POST", "/v1/runner/events/claim", { claimId }),
    ack: (ids: string[]) =>
      call(t, headers, "POST", "/v1/runner/events/ack", { ids, claudeSessionId: "session-1" }),
    /**
     * What the runner does when asked for a report: report, and once the answer names a sleep,
     * get ready and report again saying so.
     */
    readyForSleep: async () => {
      const answer = await beat();
      if (answer.body.sleep) await beat("idle", answer.body.sleep);
      return answer.body.sleep as string | null;
    },
  };
}

/** A design whose sandbox is awake with its runner started, as after a first message. */
async function awakeDesign() {
  const design = await fresh();
  await say(design.id);
  const sandbox = await live(design.id);
  expect(sandbox.state).toBe("awake");
  return { design, sandbox, runner: await runnerIn(sandbox) };
}

/** Lets the sandbox idle past its five minutes while its runner keeps beating, then sweeps. */
async function idleToSleep(runner: { beat: () => Promise<unknown> }) {
  for (let i = 0; i < 11; i++) {
    t.clock.advance(30_000);
    await runner.beat();
  }
  await cron();
}

describe("the first wake", () => {
  test("a message makes the sandbox from the image, on the owner's key and a runner token", async () => {
    const design = await fresh();
    await say(design.id);

    const sandbox = await live(design.id);
    expect(sandbox).toMatchObject({ state: "awake", generation: 1, provider: "boat" });
    const [machine] = await machines(design.id);
    expect(machine!.labels).toEqual({
      ponzu: "design",
      scope: TEST_SCOPE,
      design: design.id,
      generation: "1",
    });
    expect(machine!.id).toBe(sandbox.providerId!);
    const env = t.sandbox.env(machine!.id);
    // Exactly one Claude credential, and nothing else but what the runner needs.
    expect(Object.keys(env).sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "PONZU_API_URL",
      "PONZU_DESIGN_ID",
      "PONZU_RUNNER_TOKEN",
    ]);
    expect(env).toMatchObject({
      ANTHROPIC_API_KEY: KEY,
      PONZU_API_URL: TEST_API_URL,
      PONZU_DESIGN_ID: design.id,
    });
    expect((await runnerIn(sandbox)).status).toBe(200);

    // A runner just made claims by itself once it is up, so nobody pokes it before it listens.
    expect(t.poke.pokes.filter((p) => p.url === sandbox.address)).toEqual([]);
    expect(sandbox.encryptedAddressToken).not.toContain("fake-token");
    // The head says it is waking until the runner says what it is doing; the design records
    // whose Claude it runs on.
    expect(await head(design.id)).toMatchObject({
      agentState: "waking",
      agentBlocker: null,
      claudeAccountId: expect.stringMatching(/^cla_/),
    });
    expect(logged("sandbox_awake", design.id)).toMatchObject({
      designId: design.id,
      start: "created",
      ms: expect.any(Number),
    });
    const lines = JSON.stringify(t.logs);
    expect(lines).not.toContain(KEY);
    expect(lines).not.toContain(env.PONZU_RUNNER_TOKEN!);
    expect(lines).not.toContain("poke_missed");

    // The next message pokes it through its token-gated address, which is kept sealed.
    await say(design.id);
    expect(t.poke.pokes.at(-1)).toEqual({
      url: sandbox.address!,
      token: `fake-token-${machine!.id}-4600`,
    });
  });

  test("however many ask at once, one wake makes the one sandbox and the rest leave it be", async () => {
    const design = await fresh();
    const calls = { create: 0, stop: 0, ensureAwake: 0 };
    const counted = (Object.keys(calls) as (keyof typeof calls)[]).map((method) => {
      const real = t.sandbox[method].bind(t.sandbox) as (...args: unknown[]) => Promise<unknown>;
      (t.sandbox as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
        calls[method]++;
        return real(...args);
      };
      return () => {
        (t.sandbox as unknown as Record<string, unknown>)[method] = real;
      };
    });
    try {
      const wake = (id: string) =>
        wakeDesign(t.deps, design.id, { id, attempts: 1, maxAttempts: 5 });
      await Promise.all([
        say(design.id, "one"),
        say(design.id, "two"),
        wake("job_x"),
        wake("job_y"),
        wake("job_z"),
      ]);
      await t.backgroundDone();
    } finally {
      for (const restore of counted) restore();
    }

    expect(calls).toEqual({ create: 1, stop: 0, ensureAwake: 1 });
    expect(await machines(design.id)).toHaveLength(1);
    expect(await rows(`select state from sandboxes where design_id = '${design.id}'`)).toEqual([
      { state: "awake" },
    ]);
    expect(
      await rows(
        `select count(*)::int as live from runner_tokens
          where design_id = '${design.id}' and revoked_at is null`,
      ),
    ).toEqual([{ live: 1 }]);
  });

  test("a design whose owner has no Claude does not wake, says why, and wakes once they connect", async () => {
    const design = await designIn(t, ws, "ines", sampleDoc());
    await say(design.id, "Make it blue", "ines");

    expect(await machines(design.id)).toEqual([]);
    expect(await head(design.id)).toMatchObject({
      agentState: "idle",
      agentBlocker: "claude_not_connected",
    });

    await connectKey("ines", "sk-ant-api03-ines-key-000000000000000");
    expect(await machines(design.id)).toHaveLength(1);
    expect((await live(design.id)).state).toBe("awake");
    expect((await head(design.id)).agentBlocker).toBeNull();
  });

  test("a subscription past its year says it has expired", async () => {
    const other = await workspaceWithRepo(t, { omar: "write" });
    const design = await designIn(t, other, "omar", sampleDoc());
    await rows(`
      insert into claude_accounts (id, user_id, kind, encrypted_credential, expires_at)
      values ('cla_omar', '${other.people.omar!.userId}', 'subscription', 'sealed',
              '${new Date(t.clock.now() - 1000).toISOString()}')`);
    await call(t, other.people.omar!.headers, "POST", `/v1/designs/${design.id}/messages`, {
      text: "hi",
    });
    await t.backgroundDone();
    expect((await head(design.id)).agentBlocker).toBe("claude_expired");
    expect(await machines(design.id)).toEqual([]);
  });

  test("without the image's name a wake fails saying so, and nothing else does", async () => {
    const bare = await createTestApp({ sandbox: { snapshot: null } });
    try {
      const space = await workspaceWithRepo(bare, { maya: "write" });
      bare.anthropic.keys.add(KEY);
      await call(bare, space.people.maya!.headers, "POST", "/v1/claude/api-key", { key: KEY });
      const design = await designIn(bare, space, "maya", sampleDoc());
      const said = await call(
        bare,
        space.people.maya!.headers,
        "POST",
        `/v1/designs/${design.id}/messages`,
        {
          text: "hi",
        },
      );
      await bare.backgroundDone();
      expect(said.status).toBe(201);
      expect(bare.logs.findLast((line) => line.event === "wake_failed")).toMatchObject({
        reason: "PONZU_SANDBOX_SNAPSHOT is not set",
      });
      expect((await getDesign(bare.db, design.id))!.agentBlocker).toBe("sandbox_failed");
    } finally {
      await bare.close();
    }
  });
});

describe("sleep and wake", () => {
  test("five minutes idle puts it to sleep with an explicit stop; a message soon after is warm", async () => {
    const { design, sandbox, runner } = await awakeDesign();
    const token = t.sandbox.env(sandbox.providerId!).PONZU_RUNNER_TOKEN;

    await idleToSleep(runner);
    expect((await live(design.id)).state).toBe("asleep");
    expect((await t.sandbox.get(sandbox.providerId!)).state).not.toBe("awake");

    t.clock.advance(MINUTE);
    await say(design.id, "And the footer");
    expect((await live(design.id)).state).toBe("awake");
    expect(logged("sandbox_awake", design.id)).toMatchObject({
      designId: design.id,
      start: "warm",
    });
    // Same machine, same environment.
    expect(t.sandbox.env(sandbox.providerId!).PONZU_RUNNER_TOKEN).toBe(token);
    expect(await machines(design.id)).toHaveLength(1);
  });

  test("after the warm window the wake is cold, on the environment it had", async () => {
    const { design, sandbox, runner } = await awakeDesign();
    const token = t.sandbox.env(sandbox.providerId!).PONZU_RUNNER_TOKEN;
    await idleToSleep(runner);

    t.clock.advance(11 * MINUTE);
    await say(design.id);
    expect(logged("sandbox_awake", design.id)).toMatchObject({
      designId: design.id,
      start: "cold",
    });
    expect(t.sandbox.env(sandbox.providerId!).PONZU_RUNNER_TOKEN).toBe(token);
  });

  test("an agent that keeps working keeps it awake, and the provider's own auto-stop is kept ahead", async () => {
    const { design, sandbox, runner } = await awakeDesign();
    const extended = (await live(design.id)).autoStopAt!;
    for (let i = 0; i < 30; i++) {
      t.clock.advance(30_000);
      await runner.beat("working");
      if (i % 2 === 1) await cron();
    }
    const now = await live(design.id);
    expect(now.state).toBe("awake");
    expect(now.autoStopAt!.getTime()).toBeGreaterThan(extended.getTime());
    expect((await t.sandbox.get(sandbox.providerId!)).autoStopAt).toBe(now.autoStopAt!.getTime());
  });

  test("a person's edits keep it awake too", async () => {
    const { design, runner } = await awakeDesign();
    for (let i = 0; i < 11; i++) {
      t.clock.advance(30_000);
      await runner.beat();
      if (i === 8) await call(t, await as("maya"), "POST", `/v1/designs/${design.id}/stop`);
    }
    await cron();
    expect((await live(design.id)).state).toBe("awake");
  });

  test("awake time is metered from each start to each stop, and put down to whoever woke it", async () => {
    const { design, runner } = await awakeDesign();
    const awakeSince = (await live(design.id)).awakeSince!;
    await idleToSleep(runner);
    const firstStop = (await live(design.id)).stateAt;
    t.clock.advance(MINUTE);
    await say(design.id, "Once more", "ines");
    const secondStart = (await live(design.id)).awakeSince!;
    await idleToSleep(await runnerIn(await live(design.id)));
    const secondStop = (await live(design.id)).stateAt;

    const used = await rows(
      `select seconds, user_id, kind, workspace_id, payer, credits from usage_events
        where design_id = '${design.id}' order by occurred_at`,
    );
    const seconds = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / 1000);
    const stretch = { kind: "sandbox", workspace_id: ws.id, payer: "ponzu" };
    expect(used).toMatchObject([
      { ...stretch, seconds: seconds(awakeSince, firstStop), user_id: ws.people.maya!.userId },
      { ...stretch, seconds: seconds(secondStart, secondStop), user_id: ws.people.ines!.userId },
    ]);
  });
});

describe("a new environment", () => {
  test("a credential changed while it slept is a cold resume on a new environment", async () => {
    const { design, sandbox, runner } = await awakeDesign();
    const before = t.sandbox.env(sandbox.providerId!);
    await idleToSleep(runner);

    await connectKey("maya", OTHER_KEY);
    t.clock.advance(MINUTE);
    await say(design.id);

    const after = t.sandbox.env(sandbox.providerId!);
    expect(after.ANTHROPIC_API_KEY).toBe(OTHER_KEY);
    expect(after.PONZU_RUNNER_TOKEN).not.toBe(before.PONZU_RUNNER_TOKEN);
    expect(logged("sandbox_awake", design.id)).toMatchObject({
      start: "cold",
    });
    // The old token is good for nothing now.
    const old = await call(
      t,
      { authorization: `Bearer ${before.PONZU_RUNNER_TOKEN}` },
      "POST",
      "/v1/runner/session",
      {},
    );
    expect(old.status).toBe(401);
    await connectKey("maya", KEY);
  });

  test("a credential changed while it is awake stops it and starts it on the new one", async () => {
    const { design, sandbox } = await awakeDesign();
    await connectKey("maya", OTHER_KEY);
    await say(design.id);
    expect(t.sandbox.env(sandbox.providerId!).ANTHROPIC_API_KEY).toBe(OTHER_KEY);
    expect((await live(design.id)).state).toBe("awake");
    await connectKey("maya", KEY);
  });
});

describe("losing it", () => {
  test("a disk the provider let expire is replaced by the next generation from the image", async () => {
    const { design, sandbox, runner } = await awakeDesign();
    await idleToSleep(runner);
    t.sandbox.expire(sandbox.providerId!);

    await say(design.id);
    const next = await live(design.id);
    expect(next).toMatchObject({ state: "awake", generation: 2 });
    expect(next.providerId).not.toBe(sandbox.providerId);
    expect((await t.sandbox.get(sandbox.providerId!)).state).toBe("gone");
    expect(logged("sandbox_lost", design.id)).toMatchObject({
      refusal: "snapshot_expired",
    });
  });

  test("a sandbox the provider lost is replaced too", async () => {
    const { design, sandbox, runner } = await awakeDesign();
    await idleToSleep(runner);
    await t.sandbox.destroy(sandbox.providerId!);
    await say(design.id);
    expect(await live(design.id)).toMatchObject({ state: "awake", generation: 2 });
  });
});

describe("a provider that refuses", () => {
  test("out of starts, the message waits and says so, and the wake is tried again", async () => {
    const design = await fresh();
    t.sandbox.failNext(
      "create",
      new SandboxError("rate_limited", "429 from boat", { retryAfterSeconds: 30 }),
    );
    await say(design.id);

    expect(await head(design.id)).toMatchObject({
      agentState: "waking",
      agentBlocker: "sandbox_busy",
    });
    expect(await machines(design.id)).toEqual([]);

    t.clock.advance(30_000);
    expect((await cron()).ran).toBe(1);
    expect((await live(design.id)).state).toBe("awake");
    expect((await head(design.id)).agentBlocker).toBeNull();
  });

  test("a provider that is not answering is waited out the same way", async () => {
    const { design, runner } = await awakeDesign();
    await idleToSleep(runner);
    t.sandbox.failNext("ensureAwake", new SandboxError("unavailable", "boat is down"), 2);
    await say(design.id);
    expect((await head(design.id)).agentState).toBe("waking");
    expect((await live(design.id)).state).toBe("waking");

    for (let i = 0; i < 3 && (await live(design.id)).state !== "awake"; i++) {
      t.clock.advance(5 * MINUTE);
      await cron();
    }
    expect((await live(design.id)).state).toBe("awake");
  });

  test("a refusal that will not pass fails the sandbox, and the next message tries again", async () => {
    const design = await fresh();
    t.sandbox.failNext("create", new SandboxError("rejected", "bad request"));
    await say(design.id);
    expect((await live(design.id)).state).toBe("failed");
    expect((await head(design.id)).agentBlocker).toBe("sandbox_failed");

    await say(design.id);
    expect((await live(design.id)).state).toBe("awake");
    expect((await head(design.id)).agentBlocker).toBeNull();
  });
});

describe("a dead runner", () => {
  test("is restarted on a new environment, and after three restarts in a row the sandbox fails", async () => {
    const { design, sandbox } = await awakeDesign();
    const first = t.sandbox.env(sandbox.providerId!).PONZU_RUNNER_TOKEN;

    t.clock.advance(2 * MINUTE);
    await cron();
    const restarted = await live(design.id);
    expect(restarted.state).toBe("awake");
    expect(t.sandbox.env(sandbox.providerId!).PONZU_RUNNER_TOKEN).not.toBe(first);
    expect(logged("runner_dead", design.id)).toMatchObject({ restarts: 1 });

    for (let i = 0; i < 3; i++) {
      t.clock.advance(2 * MINUTE);
      await cron();
    }
    expect((await live(design.id)).state).toBe("failed");
    expect((await head(design.id)).agentBlocker).toBe("sandbox_failed");
  });

  test("a runner heard from again is alive, and its restarts start over", async () => {
    const { design } = await awakeDesign();
    t.clock.advance(2 * MINUTE);
    await cron();
    const runner = await runnerIn(await live(design.id));
    await runner.beat();
    expect((await live(design.id)).restarts).toBe(0);
  });
});

describe("the end of a design", () => {
  test("settling destroys its sandbox and revokes its runner tokens", async () => {
    const { design, sandbox } = await awakeDesign();
    const token = t.sandbox.env(sandbox.providerId!).PONZU_RUNNER_TOKEN;
    const settled = await call(t, await as("maya"), "PATCH", `/v1/designs/${design.id}`, {
      settled: true,
    });
    await t.backgroundDone();
    expect(settled.status).toBe(200);
    expect((await t.sandbox.get(sandbox.providerId!)).state).toBe("gone");
    expect(await getLiveSandbox(t.db, design.id)).toBeNull();
    const session = await call(
      t,
      { authorization: `Bearer ${token}` },
      "POST",
      "/v1/runner/session",
      {},
    );
    expect(session.status).toBe(401);
  });

  test("a design settled by a merge loses its sandbox at the next sweep", async () => {
    const { design, sandbox } = await awakeDesign();
    await rows(
      `update designs set status = 'settled', settled_at = now() where id = '${design.id}'`,
    );
    expect((await cron()).sandboxes.retire).toBe(1);
    expect((await t.sandbox.get(sandbox.providerId!)).state).toBe("gone");
  });

  test("deleting destroys its sandbox and keeps its usage", async () => {
    const { design, sandbox } = await awakeDesign();
    t.clock.advance(MINUTE);
    const deleted = await call(t, await as("maya"), "DELETE", `/v1/designs/${design.id}`);
    await t.backgroundDone();
    expect(deleted.status).toBe(204);
    expect((await t.sandbox.get(sandbox.providerId!)).state).toBe("gone");
    expect(
      await rows(`select seconds, design_id from usage_events where id like '${sandbox.id}/%'`),
    ).toEqual([{ seconds: 60, design_id: null }]);
  });

  test("a sandbox whose destroy failed is found by its labels and destroyed", async () => {
    const { design, sandbox } = await awakeDesign();
    t.sandbox.failNext("destroy", new SandboxError("unavailable", "boat is down"));
    await call(t, await as("maya"), "DELETE", `/v1/designs/${design.id}`);
    await t.backgroundDone();
    expect((await t.sandbox.get(sandbox.providerId!)).state).not.toBe("gone");

    expect((await cron()).sandboxes.orphaned).toBe(1);
    expect((await t.sandbox.get(sandbox.providerId!)).state).toBe("gone");
  });
});

describe("repairs", () => {
  test("a wake a crashed function left halfway is set to what the provider says", async () => {
    const { design, sandbox } = await awakeDesign();
    await moveSandbox(t.db, {
      id: sandbox.id,
      from: ["awake"],
      to: "waking",
      now: new Date(t.clock.now()),
    });
    t.clock.advance(7 * MINUTE);
    expect((await cron()).sandboxes.repair).toBe(1);
    expect((await live(design.id)).state).toBe("awake");
  });

  test("a stop left halfway becomes asleep, and a create that never reached the provider fails", async () => {
    const { design, sandbox } = await awakeDesign();
    await moveSandbox(t.db, {
      id: sandbox.id,
      from: ["awake"],
      to: "stopping",
      now: new Date(t.clock.now()),
    });
    await t.sandbox.stop(sandbox.providerId!);
    // Its runner took its message, so nothing waits to wake it again.
    await rows(`update events set delivered_at = now() where design_id = '${design.id}'`);

    const lost = await fresh();
    await rows(`
      insert into sandboxes (id, design_id, generation, provider, state, state_at)
      values ('sbx_lostcreate000001', '${lost.id}', 1, 'boat', 'waking',
              '${new Date(t.clock.now()).toISOString()}')`);

    t.clock.advance(7 * MINUTE);
    await cron();
    expect((await live(design.id)).state).toBe("asleep");
    expect((await live(lost.id)).state).toBe("failed");
  });

  test("a create that reached the provider before its function died leaves nothing behind", async () => {
    const design = await fresh();
    await rows(`
      insert into sandboxes (id, design_id, generation, provider, state, state_at, waking_by)
      values ('sbx_crashedcreate01', '${design.id}', 1, 'boat', 'waking',
              '${new Date(t.clock.now()).toISOString()}', 'job_dead')`);
    // What the provider made before the function died: the row's labels, and the key.
    const made = await t.sandbox.create({
      idempotencyKey: `${design.id}-1`,
      from: TEST_SNAPSHOT,
      labels: sandboxLabels(TEST_SCOPE, design.id, 1),
      env: { ANTHROPIC_API_KEY: KEY },
      autoStopSeconds: 1200,
    });

    t.clock.advance(7 * MINUTE);
    expect((await cron()).sandboxes.repair).toBe(1);
    expect((await live(design.id)).state).toBe("failed");
    expect((await t.sandbox.get(made.sandbox.id)).state).toBe("gone");

    // The next message makes the generation's sandbox anew.
    await say(design.id);
    const next = await live(design.id);
    expect(next).toMatchObject({ state: "awake", generation: 1 });
    expect(next.providerId).not.toBe(made.sandbox.id);
    expect(await machines(design.id)).toHaveLength(1);
  });

  test("a stop left halfway on a design whose message still waits wakes it again", async () => {
    const { design, sandbox } = await awakeDesign();
    await moveSandbox(t.db, {
      id: sandbox.id,
      from: ["awake"],
      to: "stopping",
      now: new Date(t.clock.now()),
    });
    await t.sandbox.stop(sandbox.providerId!);
    t.clock.advance(7 * MINUTE);
    await cron();
    expect((await live(design.id)).state).toBe("awake");
  });
});

describe("a stop under way", () => {
  onAppOfTheirOwn();

  test("a message that lands while an idle stop is in flight waits for it, then wakes the sandbox", async () => {
    const { design, sandbox, runner } = await awakeDesign();
    for (let i = 0; i < 11; i++) {
      t.clock.advance(30_000);
      await runner.beat();
    }
    // The cron's stop is at the provider when the message comes; the wake looks, finds the
    // sandbox stopping and waits; only then does the stop land.
    const { stop, sleep } = {
      stop: t.sandbox.stop.bind(t.sandbox),
      sleep: t.clock.sleep.bind(t.clock),
    };
    let message: Promise<void> | undefined;
    let looked!: () => void;
    const wakeLooked = new Promise<void>((resolve) => {
      looked = resolve;
    });
    let landed!: () => void;
    const stopLanded = new Promise<void>((resolve) => {
      landed = resolve;
    });
    let stops = 0;
    t.sandbox.stop = async (id) => {
      stops++;
      message = say(design.id, "Wait for me");
      await wakeLooked;
      const stopped = await stop(id);
      landed();
      return stopped;
    };
    t.clock.sleep = async (ms) => {
      looked();
      await stopLanded;
      return sleep(ms);
    };
    try {
      await cron();
      await message;
    } finally {
      t.sandbox.stop = stop;
      t.clock.sleep = sleep;
    }

    expect(stops).toBe(1);
    expect((await live(design.id)).state).toBe("awake");
    expect((await t.sandbox.get(sandbox.providerId!)).state).toBe("awake");
    expect(logged("sandbox_awake", design.id)).toMatchObject({ start: "warm" });
  });
});

describe("limits, until billing exists", () => {
  onAppOfTheirOwn({ sandbox: { limits: { perWorkspace: 2, perOwner: 1 } } });

  test("a wake past the owner's or the workspace's limit waits, says so, and starts once there is room", async () => {
    await connectKey("ines", "sk-ant-api03-ines-key-000000000000000");
    const mine = await awakeDesign();
    const second = await fresh();
    await say(second.id);
    expect(await head(second.id)).toMatchObject({
      agentState: "waking",
      agentBlocker: "sandbox_busy",
    });
    expect(await machines(second.id)).toEqual([]);

    const theirs = await designIn(t, ws, "ines", sampleDoc());
    await say(theirs.id, "Make it blue", "ines");
    expect((await live(theirs.id)).state).toBe("awake");
    const theirRunner = await runnerIn(await live(theirs.id));
    const another = await designIn(t, ws, "ines", sampleDoc());
    await say(another.id, "And green", "ines");
    expect((await head(another.id)).agentBlocker).toBe("sandbox_busy");

    // Maya's first goes to sleep; her second starts in its place, and the workspace is full
    // again for Ines's other.
    for (let i = 0; i < 11; i++) {
      t.clock.advance(30_000);
      await mine.runner.beat();
      await theirRunner.beat("working");
    }
    await cron();
    expect((await live(mine.design.id)).state).toBe("asleep");
    t.clock.advance(MINUTE);
    await theirRunner.beat("working");
    await cron();
    expect((await live(second.id)).state).toBe("awake");
    expect((await head(second.id)).agentBlocker).toBeNull();
    expect(await machines(another.id)).toEqual([]);
    expect((await head(another.id)).agentBlocker).toBe("sandbox_busy");
  });
});

describe("two deployments on one provider account", () => {
  test("a sweep destroys only its own database's sandboxes", async () => {
    const other = await createTestApp({ provider: t.sandbox, sandbox: { scope: "otherscope" } });
    try {
      const { sandbox } = await awakeDesign();
      // Made before sandboxes carried a scope: nobody's to destroy.
      const unscoped = await t.sandbox.create({
        idempotencyKey: "unscoped",
        labels: { ponzu: "design", design: "des_elsewhere00001" },
        autoStopSeconds: 60,
      });
      const signIn = await t.sandbox.create({
        idempotencyKey: "sign-in-here",
        labels: { ponzu: "claude-sign-in", scope: TEST_SCOPE, expires: "0" },
        autoStopSeconds: 60,
      });
      // The other deployment's own orphan, which it does destroy.
      const theirs = await t.sandbox.create({
        idempotencyKey: "their-orphan",
        labels: sandboxLabels("otherscope", "des_theirsgone00001", 1),
        autoStopSeconds: 60,
      });

      const ran = await other.app.request("/v1/cron/minute", {
        headers: { authorization: `Bearer ${TEST_CRON_SECRET}` },
      });
      await other.backgroundDone();
      expect(await ran.json()).toMatchObject({ sandboxes: { orphaned: 1 }, signIns: 0 });

      expect((await t.sandbox.get(theirs.sandbox.id)).state).toBe("gone");
      for (const kept of [sandbox.providerId!, unscoped.sandbox.id, signIn.sandbox.id]) {
        expect((await t.sandbox.get(kept)).state).not.toBe("gone");
      }
      // This deployment's own sweep takes its expired sign-in, and leaves the unscoped one.
      expect((await cron()).signIns).toBe(1);
      expect((await t.sandbox.get(unscoped.sandbox.id)).state).not.toBe("gone");
      await t.sandbox.destroy(unscoped.sandbox.id);
    } finally {
      await other.close();
    }
  });
});

describe("disconnecting Claude", () => {
  test("destroys the credential and every sandbox holding it, asleep or awake", async () => {
    const { design, sandbox } = await awakeDesign();
    const sleeping = await awakeDesign();
    await idleToSleep(sleeping.runner);
    expect(t.sandbox.env(sleeping.sandbox.providerId!).ANTHROPIC_API_KEY).toBe(KEY);

    const gone = await call(t, await as("maya"), "DELETE", "/v1/claude");
    await t.backgroundDone();
    expect(gone.status).toBe(204);

    expect(
      await rows(
        `select status, encrypted_credential from claude_accounts where user_id = '${ws.people.maya!.userId}'`,
      ),
    ).toEqual([{ status: "revoked", encrypted_credential: null }]);
    // Not stopped: gone, and the environment with the key in it with them.
    for (const { design: each, sandbox: machine } of [{ design, sandbox }, sleeping]) {
      expect(await getLiveSandbox(t.db, each.id)).toBeNull();
      expect((await t.sandbox.get(machine.providerId!)).state).toBe("gone");
      expect(() => t.sandbox.env(machine.providerId!)).toThrow();
      expect((await head(each.id)).agentBlocker).toBe("claude_not_connected");
    }

    // Connecting again starts the design over from its branch, on the new key.
    await connectKey("maya", OTHER_KEY);
    expect((await head(design.id)).agentBlocker).toBeNull();
    await say(design.id);
    const next = await live(design.id);
    expect(next).toMatchObject({ state: "awake", generation: 2 });
    expect(t.sandbox.env(next.providerId!).ANTHROPIC_API_KEY).toBe(OTHER_KEY);
    await connectKey("maya", KEY);
  });

  test("a sandbox the disconnect could not destroy is destroyed by the sweep", async () => {
    const { design, sandbox } = await awakeDesign();
    await idleToSleep(await runnerIn(sandbox));
    // As if the disconnect's function died after revoking the account and before the rest.
    await rows(`
      update claude_accounts set status = 'revoked', encrypted_credential = null
       where user_id = '${ws.people.maya!.userId}'`);
    await cron();
    expect(await getLiveSandbox(t.db, design.id)).toBeNull();
    expect((await t.sandbox.get(sandbox.providerId!)).state).toBe("gone");
    await connectKey("maya", KEY);
  });
});

describe("an owner who left the workspace", () => {
  test("lends their Claude to nothing: a teammate's message does not wake it, and the sweep destroys it", async () => {
    const { design, sandbox, runner } = await awakeDesign();
    await idleToSleep(runner);
    const [membership] = await rows(`
      delete from memberships
       where workspace_id = '${ws.id}' and user_id = '${ws.people.maya!.userId}'
      returning role, github_access`);
    try {
      await say(design.id, "Carry on without Maya", "ines");
      expect((await live(design.id)).state).toBe("asleep");
      expect((await t.sandbox.get(sandbox.providerId!)).state).not.toBe("awake");
      expect(await head(design.id)).toMatchObject({
        agentState: "idle",
        agentBlocker: "claude_owner_left",
      });

      await cron();
      expect(await getLiveSandbox(t.db, design.id)).toBeNull();
      expect((await t.sandbox.get(sandbox.providerId!)).state).toBe("gone");
      expect((await head(design.id)).agentBlocker).toBe("claude_owner_left");
    } finally {
      await rows(`
        insert into memberships (workspace_id, user_id, role, github_access)
        values ('${ws.id}', '${ws.people.maya!.userId}', '${membership!.role}',
                '${membership!.github_access}')`);
    }
  });
});

describe("getting ready to sleep", () => {
  /** Records the order the idle stop does things in, from the runner's side and the provider's. */
  function watchStop() {
    const order: string[] = [];
    const stop = t.sandbox.stop.bind(t.sandbox);
    t.sandbox.stop = async (id) => {
      order.push("stop");
      return stop(id);
    };
    t.sandbox.onExec = ({ command }) => {
      order.push(`exec ${command}`);
      return undefined;
    };
    return {
      order,
      done: () => {
        t.sandbox.stop = stop;
        t.sandbox.onExec = null;
        t.poke.onReport = null;
      },
    };
  }

  test("the stop asks the runner, waits until it is ready, flushes the disk, then stops", async () => {
    const { design, runner } = await awakeDesign();
    const watched = watchStop();
    try {
      t.poke.onReport = async () => {
        watched.order.push("report");
        const sleep = await runner.readyForSleep();
        watched.order.push(`ready for ${sleep}`);
      };
      await idleToSleep(runner);
      const asleep = await live(design.id);
      expect(asleep.state).toBe("asleep");
      expect(watched.order).toEqual([
        "report",
        `ready for ${watched.order[1]!.slice("ready for ".length)}`,
        "exec sync",
        "stop",
      ]);
      expect(watched.order[1]).not.toBe("ready for null");
      expect(logged("sandbox_stopping", design.id)).toMatchObject({
        quiesced: true,
        asked: true,
        quiesceMs: 0,
      });
    } finally {
      watched.done();
    }
  });

  test("a message a runner claimed as it got ready, and held back, wakes the design again once the stop lands", async () => {
    const { design, runner } = await awakeDesign();
    const watched = watchStop();
    const claimId = newId("clm");
    try {
      t.poke.onReport = async () => {
        // The claim went out before the sleep was heard and came back after: held, not acked.
        const claimed = await runner.claim(claimId);
        expect(claimed.body.events.length).toBeGreaterThan(0);
        await runner.readyForSleep();
      };
      await idleToSleep(runner);
      expect(watched.order).toContain("stop");
      expect(logged("sandbox_awake", design.id)).toMatchObject({ start: "warm" });
      expect((await live(design.id)).state).toBe("awake");
    } finally {
      watched.done();
    }

    // Awake again, the same claim hands them out again; once they are in its session, the next
    // idle stop leaves it asleep.
    const claimed = await runner.claim(claimId);
    expect(claimed.body.events.length).toBeGreaterThan(0);
    await runner.ack(claimed.body.events.map((e: { id: string }) => e.id));
    await idleToSleep(runner);
    expect((await live(design.id)).state).toBe("asleep");
  });

  test("a runner that never says it is ready is stopped anyway, after the wait", async () => {
    const { design, runner } = await awakeDesign();
    const watched = watchStop();
    try {
      // It reports, but never gets ready.
      t.poke.onReport = async () => void (await runner.beat());
      await idleToSleep(runner);
      expect((await live(design.id)).state).toBe("asleep");
      expect(watched.order).toEqual(["exec sync", "stop"]);
      expect(logged("sandbox_stopping", design.id)).toMatchObject({
        quiesced: false,
        quiesceMs: 30_000,
      });
    } finally {
      watched.done();
    }
  });

  test("a runner that does not answer its port is not waited for, and the disk is still flushed", async () => {
    const { design, runner } = await awakeDesign();
    const watched = watchStop();
    try {
      await idleToSleep(runner);
      expect(watched.order).toEqual(["exec sync", "stop"]);
      expect(logged("sandbox_stopping", design.id)).toMatchObject({
        quiesced: false,
        quiesceMs: 0,
      });
      expect(logged("quiesce_unanswered", design.id)).toBeDefined();
    } finally {
      watched.done();
    }
  });
});

describe("a runner that a warm resume does not bring back", () => {
  test("is started again through the provider, on the same environment", async () => {
    const { design, sandbox, runner } = await awakeDesign();
    const token = t.sandbox.env(sandbox.providerId!).PONZU_RUNNER_TOKEN;
    await idleToSleep(runner);
    // It had exited 78 (a lease lost to a botched restart): the thaw brings it back stopped.
    t.poke.healthy = false;
    t.sandbox.onExec = ({ command }) => {
      if (command === "sudo systemctl start ponzu-runner") t.poke.healthy = true;
      return undefined;
    };
    try {
      t.clock.advance(MINUTE);
      await say(design.id, "And the footer");
      expect(logged("sandbox_awake", design.id)).toMatchObject({ start: "warm" });
      expect(logged("runner_revived", design.id)).toBeDefined();
      expect(t.sandbox.commands.map((c) => c.command)).toContain(
        "sudo systemctl start ponzu-runner",
      );
      expect(t.sandbox.env(sandbox.providerId!).PONZU_RUNNER_TOKEN).toBe(token);
      expect((await live(design.id)).state).toBe("awake");
    } finally {
      t.poke.healthy = true;
      t.sandbox.onExec = null;
    }
  });

  test("is booted on a new environment when starting it again does not work", async () => {
    const { design, sandbox, runner } = await awakeDesign();
    const token = t.sandbox.env(sandbox.providerId!).PONZU_RUNNER_TOKEN;
    await idleToSleep(runner);
    t.poke.healthy = false;
    t.sandbox.onExec = ({ command }) =>
      command.startsWith("sudo systemctl") ? { exitCode: 1, stderr: "failed" } : undefined;
    const before = t.sandbox.commands.length;
    try {
      t.clock.advance(MINUTE);
      await say(design.id, "And the footer");
      expect(logged("runner_down_after_warm_resume", design.id)).toBeDefined();
      expect(logged("sandbox_awake", design.id)).toMatchObject({ start: "cold" });
      // What the machine wrote is flushed before the stop: /health can fail for its address.
      expect(t.sandbox.commands.slice(before).map((c) => c.command)).toEqual([
        "sudo systemctl start ponzu-runner",
        "sync",
      ]);
      const now = t.sandbox.env(sandbox.providerId!).PONZU_RUNNER_TOKEN;
      expect(now).not.toBe(token);
      // The old token is revoked: only the new environment's runner is let in.
      const old = await call(
        t,
        { authorization: `Bearer ${token}` },
        "POST",
        "/v1/runner/session",
        {},
      );
      expect(old.status).toBe(401);
    } finally {
      t.poke.healthy = true;
      t.sandbox.onExec = null;
    }
  });

  test("goes straight to a cold start when the wake has no time left to start it again", async () => {
    const { design, sandbox, runner } = await awakeDesign();
    await idleToSleep(runner);
    t.poke.healthy = false;
    // The resume itself took most of the attempt's time.
    const ensureAwake = t.sandbox.ensureAwake.bind(t.sandbox);
    let first = true;
    t.sandbox.ensureAwake = async (id, options) => {
      const woke = await ensureAwake(id, options);
      if (first) t.clock.advance(140_000);
      first = false;
      return woke;
    };
    const before = t.sandbox.commands.length;
    try {
      t.clock.advance(MINUTE);
      await say(design.id, "And the footer");
      const commands = t.sandbox.commands.slice(before).map((c) => c.command);
      expect(commands).not.toContain("sudo systemctl start ponzu-runner");
      expect(commands).toEqual(["sync"]);
      expect(logged("sandbox_awake", design.id)).toMatchObject({ start: "cold" });
      expect(t.sandbox.env(sandbox.providerId!).PONZU_RUNNER_TOKEN).toBeDefined();
    } finally {
      t.poke.healthy = true;
      t.sandbox.ensureAwake = ensureAwake;
    }
  });

  test("stays down when its design was settled meanwhile: it exited on purpose", async () => {
    const { design, runner } = await awakeDesign();
    await idleToSleep(runner);
    const healthy = t.poke.port.healthy;
    t.poke.port.healthy = async () => {
      await rows(
        `update designs set status = 'settled', settled_at = now() where id = '${design.id}'`,
      );
      return false;
    };
    const before = t.sandbox.commands.length;
    try {
      t.clock.advance(MINUTE);
      await say(design.id, "Too late");
      expect(t.sandbox.commands.slice(before).map((c) => c.command)).not.toContain(
        "sudo systemctl start ponzu-runner",
      );
      expect(logged("runner_down_after_warm_resume", design.id)).toBeUndefined();
      // The sweep retires a settled design's sandbox.
      t.poke.port.healthy = healthy;
      await cron();
      expect(await getLiveSandbox(t.db, design.id)).toBeNull();
    } finally {
      t.poke.port.healthy = healthy;
    }
  });
});

describe("a new image", () => {
  // Images change under these tests, so they have an app of their own.
  onAppOfTheirOwn({ sandbox: { maxMoves: 2 } });
  let baked = 0;
  let turns = 0;

  /** A new image set, as a deploy with a new PONZU_SANDBOX_SNAPSHOT does. */
  function newImage(): string {
    const name = `ponzu-runner-${String(++baked).padStart(12, "0")}`;
    t.sandbox.seedSnapshot(name);
    t.deps.config.sandbox.snapshot = name;
    return name;
  }

  type Runner = Awaited<ReturnType<typeof runnerIn>>;

  /** The runner takes what waits into its session and works on it. */
  async function take(runner: Runner) {
    const claimed = await runner.claim();
    const ids = (claimed.body.events as { id: string }[]).map((event) => event.id);
    if (ids.length > 0) expect((await runner.ack(ids)).status).toBe(200);
    return ids;
  }

  /** ... and saves a checkpoint once its turn has settled, as the runner does. */
  async function save(designId: string, runner: Runner) {
    const saved = await recordCheckpoint(t.db, {
      designId,
      runnerId: runner.session.runnerId,
      now: new Date(t.clock.now()),
      turn: ++turns,
      claudeSessionId: "session-1",
      wipCommit: null,
      sessionUploadId: null,
      workspaceUploadId: null,
    });
    expect(saved?.saved?.turn).toBe(turns);
  }

  /** A design that worked, saved and went to sleep on the image of the time. */
  async function asleepAfterWork() {
    const awake = await awakeDesign();
    await take(awake.runner);
    await save(awake.design.id, awake.runner);
    await idleToSleep(awake.runner);
    expect((await live(awake.design.id)).state).toBe("asleep");
    return awake;
  }

  /** Counts the provider's creates while `body` runs. */
  async function counting(body: () => Promise<void>): Promise<number> {
    const create = t.sandbox.create.bind(t.sandbox);
    let creates = 0;
    t.sandbox.create = (options) => {
      creates++;
      return create(options);
    };
    try {
      await body();
    } finally {
      t.sandbox.create = create;
    }
    return creates;
  }

  test("every sandbox records the image it was made from, and its runner what it says it is", async () => {
    const image = t.deps.config.sandbox.snapshot!;
    const design = await fresh();
    await say(design.id);
    const sandbox = await live(design.id);
    expect(sandbox.image).toBe(image);

    await runnerIn(sandbox, `runner/0.1.0+${image}`);
    expect(
      await rows(`select client from design_runners where design_id = '${design.id}'`),
    ).toEqual([{ client: `runner/0.1.0+${image}` }]);
    expect(logged("runner_started", design.id)).toMatchObject({
      runnerImage: image,
      sandboxImage: image,
    });

    // A runner that says another image than its sandbox was made from shows.
    await runnerIn(sandbox, "runner/0.1.0+ponzu-runner-ffffffffffff");
    expect(logged("runner_image_mismatch", design.id)).toMatchObject({
      sandboxId: sandbox.id,
      runnerImage: "ponzu-runner-ffffffffffff",
      sandboxImage: image,
    });
    // One older than saying so says only its version.
    await runnerIn(sandbox, "runner/0.1.0");
    expect(logged("runner_started", design.id)).toMatchObject({
      client: "runner/0.1.0",
      runnerImage: null,
    });
  });

  test("the next wake moves the design onto a new sandbox, which restores the checkpoint in the same session", async () => {
    const { design, sandbox } = await asleepAfterWork();
    const from = sandbox.image;
    const oldToken = t.sandbox.env(sandbox.providerId!).PONZU_RUNNER_TOKEN!;
    const image = newImage();
    t.analytics.events.length = 0;

    t.clock.advance(MINUTE);
    await say(design.id, "And the footer");

    const moved = await live(design.id);
    expect(moved).toMatchObject({
      state: "awake",
      generation: 2,
      image,
      imageFailed: null,
      movingSince: null,
    });
    expect(moved.providerId).not.toBe(sandbox.providerId);
    // The old row is gone, saying why, and its machine is destroyed.
    expect(
      await rows(`select state, failure, image from sandboxes where id = '${sandbox.id}'`),
    ).toEqual([{ state: "gone", failure: `Moved onto ${image}.`, image: from }]);
    expect((await t.sandbox.get(sandbox.providerId!)).state).toBe("gone");
    expect((await machines(design.id)).map((m) => m.labels.generation)).toEqual(["2"]);
    // Its runner has answered already and may have claimed before the row moved, so it is poked:
    // a message sent meanwhile does not wait for its next minute's claim.
    expect(t.poke.pokes.at(-1)?.url).toBe(moved.address!);
    // The head said waking, as for any start, and points at the new sandbox.
    expect(await head(design.id)).toMatchObject({
      sandboxId: moved.id,
      agentState: "waking",
      agentBlocker: null,
    });

    // A new environment: the old runner's token is revoked.
    const env = t.sandbox.env(moved.providerId!);
    expect(env.PONZU_RUNNER_TOKEN).not.toBe(oldToken);
    expect(env.ANTHROPIC_API_KEY).toBe(KEY);
    const old = await call(
      t,
      { authorization: `Bearer ${oldToken}` },
      "POST",
      "/v1/runner/session",
      {},
    );
    expect(old.status).toBe(401);

    // Its runner is handed the checkpoint to restore and the Claude session to resume, and the
    // message that woke it is waiting.
    const next = await runnerIn(moved, `runner/0.1.0+${image}`);
    expect(next.session).toMatchObject({
      claudeSessionId: "session-1",
      saved: { turn: turns, claudeSessionId: "session-1" },
    });
    expect(await take(next)).toHaveLength(1);
    expect(logged("runner_image_mismatch", design.id)).toBeUndefined();

    expect(logged("sandbox_moved", design.id)).toMatchObject({
      from,
      to: image,
      fromSandboxId: sandbox.id,
      sandboxId: moved.id,
    });
    expect(logged("sandbox_awake", design.id)).toMatchObject({ start: "moved", image });
    const events = t.analytics.events.map((e) => [e.event, e.properties]);
    expect(events).toContainEqual([
      "sandbox moved",
      expect.objectContaining({ design_id: design.id, from_image: from, to_image: image }),
    ]);
    expect(events).toContainEqual([
      "sandbox woke",
      expect.objectContaining({ design_id: design.id, start: "moved", image }),
    ]);
  });

  test("a sandbox made before images were recorded moves too", async () => {
    const { design, sandbox } = await asleepAfterWork();
    await rows(`update sandboxes set image = null where id = '${sandbox.id}'`);
    t.clock.advance(MINUTE);
    await say(design.id);
    expect(await live(design.id)).toMatchObject({
      generation: 2,
      image: t.deps.config.sandbox.snapshot,
    });
    expect(logged("sandbox_moved", design.id)).toMatchObject({ from: null });
  });

  test("a turn in flight is never interrupted: an awake sandbox moves only after it has slept", async () => {
    const { design, sandbox, runner } = await awakeDesign();
    await take(runner);
    await runner.beat("working");
    newImage();
    const reports = t.poke.reports.length;

    await say(design.id, "While you're at it");
    expect(await live(design.id)).toMatchObject({ id: sandbox.id, state: "awake" });
    // Nobody asked it to get ready to sleep, and nothing new was made.
    expect(t.poke.reports.length).toBe(reports);
    expect(await machines(design.id)).toHaveLength(1);

    // The turn ends and its checkpoint is saved; the sandbox sleeps; the next wake moves it.
    await take(runner);
    await save(design.id, runner);
    await idleToSleep(runner);
    t.clock.advance(MINUTE);
    await say(design.id);
    expect(await live(design.id)).toMatchObject({ generation: 2, state: "awake" });
  });

  test("a checkpoint behind the session wakes the old sandbox, which saves, and moves at the next wake", async () => {
    const { design, sandbox, runner } = await awakeDesign();
    await take(runner);
    await save(design.id, runner);
    // A message went into the session after the last checkpoint, and none was saved after it.
    await say(design.id, "One more thing");
    await take(runner);
    await idleToSleep(runner);
    newImage();

    t.clock.advance(MINUTE);
    await say(design.id, "Back again");
    expect(await live(design.id)).toMatchObject({ id: sandbox.id, state: "awake" });
    expect(logged("sandbox_awake", design.id)).toMatchObject({ start: "warm" });
    expect(logged("sandbox_move_held", design.id)).toMatchObject({
      sandboxId: sandbox.id,
      reason: "checkpoint_behind",
    });

    // Its runner saves after its next turn; the wake after the next sleep moves it.
    await take(runner);
    await save(design.id, runner);
    await idleToSleep(runner);
    t.clock.advance(MINUTE);
    await say(design.id);
    expect(await live(design.id)).toMatchObject({ generation: 2 });
  });

  test("a stop or a push taken after the last checkpoint does not hold the move back", async () => {
    const { design, runner } = await awakeDesign();
    await take(runner);
    await save(design.id, runner);
    // Create PR asks the runner to push, and a stop comes after the turn: both are acknowledged
    // without going into the session.
    await askRunnerToPush(t.db, { designId: design.id, userId: design.ownerId! });
    await appendEvent(t.db, { designId: design.id, kind: "stop", priority: "now", payload: {} });
    expect(await take(runner)).toHaveLength(2);
    await idleToSleep(runner);
    const image = newImage();

    t.clock.advance(MINUTE);
    await say(design.id);
    expect(await live(design.id)).toMatchObject({ generation: 2, image });
  });

  test("a runner that never saved a checkpoint keeps its sandbox, and the log says why", async () => {
    const { design, sandbox, runner } = await awakeDesign();
    await take(runner);
    await idleToSleep(runner);
    newImage();
    t.clock.advance(MINUTE);
    await say(design.id);
    expect(await live(design.id)).toMatchObject({ id: sandbox.id, state: "awake" });
    expect(logged("sandbox_move_held", design.id)).toMatchObject({ reason: "no_checkpoint" });
  });

  test("an image that does not start is undone: the old sandbox wakes, and the move is not tried again", async () => {
    const { design, sandbox, runner } = await asleepAfterWork();
    const image = newImage();
    t.sandbox.failNext(
      "ensureAwake",
      new SandboxError("unavailable", "sandbox did not start: the image is broken"),
    );

    t.clock.advance(MINUTE);
    await say(design.id, "Still there?");
    expect(await live(design.id)).toMatchObject({
      id: sandbox.id,
      state: "awake",
      image: sandbox.image,
      imageFailed: image,
      movingSince: null,
    });
    expect(logged("sandbox_awake", design.id)).toMatchObject({ start: "warm" });
    expect(logged("sandbox_move_failed", design.id)).toMatchObject({
      to: image,
      reason: expect.stringContaining("the image is broken"),
    });
    expect(await head(design.id)).toMatchObject({ agentBlocker: null });
    // What the move made is destroyed and its token revoked: only the old machine is left.
    expect((await machines(design.id)).map((m) => m.id)).toEqual([sandbox.providerId!]);
    expect(
      await rows(
        `select count(*)::int as live from runner_tokens
          where design_id = '${design.id}' and revoked_at is null`,
      ),
    ).toEqual([{ live: 1 }]);

    // No loop: the next wake on the same image keeps the old sandbox without trying.
    await idleToSleep(runner);
    t.clock.advance(MINUTE);
    const creates = await counting(() => say(design.id));
    expect(creates).toBe(0);
    expect(await live(design.id)).toMatchObject({ id: sandbox.id, state: "awake" });
    expect(logged("sandbox_move_held", design.id)).toMatchObject({ reason: "image_failed" });

    // A later image is tried afresh.
    await save(design.id, runner);
    await idleToSleep(runner);
    const fixed = newImage();
    t.clock.advance(MINUTE);
    await say(design.id);
    expect(await live(design.id)).toMatchObject({ generation: 2, image: fixed, imageFailed: null });
  });

  test("an image the provider does not have is a failed move, not a failed wake", async () => {
    const { design, sandbox } = await asleepAfterWork();
    const missing = "ponzu-runner-000000000bad";
    t.deps.config.sandbox.snapshot = missing;
    t.clock.advance(MINUTE);
    await say(design.id);
    expect(await live(design.id)).toMatchObject({
      id: sandbox.id,
      state: "awake",
      imageFailed: missing,
    });
    expect(await head(design.id)).toMatchObject({ agentBlocker: null });
    newImage();
  });

  test("a provider out of starts makes the move wait, as any wake does, without blaming the image", async () => {
    const { design, sandbox } = await asleepAfterWork();
    const image = newImage();
    t.sandbox.failNext(
      "create",
      new SandboxError("start_cap_reached", "no starts left", { retryAfterSeconds: 30 }),
    );
    t.clock.advance(MINUTE);
    await say(design.id);
    expect(await live(design.id)).toMatchObject({
      id: sandbox.id,
      state: "waking",
      imageFailed: null,
    });
    expect(await head(design.id)).toMatchObject({
      agentState: "waking",
      agentBlocker: "sandbox_busy",
    });

    t.clock.advance(MINUTE);
    await cron();
    expect(await live(design.id)).toMatchObject({ generation: 2, image, state: "awake" });
  });

  test("past the moves allowed at once, a design wakes on its old sandbox and moves later", async () => {
    const others = [await asleepAfterWork(), await asleepAfterWork()];
    const { design, sandbox, runner } = await asleepAfterWork();
    newImage();
    // Two moves under way elsewhere hold both slots.
    const at = new Date(t.clock.now()).toISOString();
    for (const other of others) {
      await rows(
        `update sandboxes set state = 'waking', waking_by = 'job_elsewhere', moving_since = '${at}'
          where id = '${other.sandbox.id}'`,
      );
    }
    try {
      await say(design.id);
      expect(await live(design.id)).toMatchObject({ id: sandbox.id, state: "awake" });
      expect(logged("sandbox_move_held", design.id)).toMatchObject({ reason: "moves_at_once" });
    } finally {
      for (const other of others) {
        await rows(
          `update sandboxes set state = 'asleep', waking_by = null, moving_since = null
            where id = '${other.sandbox.id}'`,
        );
      }
    }
    // With the slots free again, the next wake moves it.
    await save(design.id, runner);
    await idleToSleep(runner);
    t.clock.advance(MINUTE);
    await say(design.id);
    expect(await live(design.id)).toMatchObject({ generation: 2 });
  });

  test("the machine a move is starting is not taken for an orphan by a sweep meanwhile", async () => {
    const { design, sandbox } = await asleepAfterWork();
    const image = newImage();
    const ensureAwake = t.sandbox.ensureAwake.bind(t.sandbox);
    let orphaned = -1;
    t.sandbox.ensureAwake = async (id, options) => {
      if (id !== sandbox.providerId && orphaned < 0) {
        orphaned = (await cron()).sandboxes.orphaned ?? -2;
      }
      return ensureAwake(id, options);
    };
    try {
      t.clock.advance(MINUTE);
      await say(design.id);
    } finally {
      t.sandbox.ensureAwake = ensureAwake;
    }
    expect(orphaned).toBe(0);
    expect(await live(design.id)).toMatchObject({ generation: 2, image, state: "awake" });
  });

  test("a move cut off after the provider made its machine is tried afresh, not blamed on the image", async () => {
    const { design } = await asleepAfterWork();
    const image = newImage();
    // What the cut-off attempt left: the next generation's machine, on an environment nothing
    // recorded.
    const left = await t.sandbox.create({
      idempotencyKey: `${design.id}-2`,
      from: image,
      size: "small",
      name: `design-${design.id}`,
      labels: sandboxLabels(TEST_SCOPE, design.id, 2),
      env: { PONZU_RUNNER_TOKEN: "pzr_lost" },
      ports: [4600],
      autoStopSeconds: 1200,
    });
    t.clock.advance(MINUTE);
    await say(design.id);
    expect((await t.sandbox.get(left.sandbox.id)).state).toBe("gone");
    expect(await live(design.id)).toMatchObject({ state: "waking", imageFailed: null });

    t.clock.advance(MINUTE);
    await cron();
    expect(await live(design.id)).toMatchObject({ generation: 2, image, state: "awake" });
  });

  test("with moving off, every design stays on the image it was made from", async () => {
    const { design, sandbox } = await asleepAfterWork();
    newImage();
    t.deps.config.sandbox.maxMoves = 0;
    try {
      t.clock.advance(MINUTE);
      await say(design.id);
      expect(await live(design.id)).toMatchObject({ id: sandbox.id, state: "awake" });
      expect(logged("sandbox_move_held", design.id)).toMatchObject({ reason: "moving_off" });
    } finally {
      t.deps.config.sandbox.maxMoves = 2;
    }
  });
});
