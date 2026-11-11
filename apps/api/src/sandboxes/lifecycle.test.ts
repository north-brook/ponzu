import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sampleDoc } from "@ponzu/core/fixtures";
import { getDesign, getLiveSandbox, moveSandbox, type Sandbox } from "@ponzu/db";
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
async function runnerIn(sandbox: Sandbox) {
  const token = t.sandbox.env(sandbox.providerId!).PONZU_RUNNER_TOKEN!;
  const started = await call(
    t,
    { authorization: `Bearer ${token}` },
    "POST",
    "/v1/runner/session",
    {},
  );
  const headers = { authorization: `Bearer ${token}`, [RUNNER_HEADER]: started.body?.runnerId };
  return {
    status: started.status,
    beat: (state: "working" | "idle" = "idle") =>
      call(t, headers, "PUT", "/v1/runner/state", {
        state,
        status: null,
        artboards: [],
        claudeSessionId: "session-1",
      }),
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
