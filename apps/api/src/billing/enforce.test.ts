import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sampleDoc } from "@ponzu/core/fixtures";
import {
  appendEvent,
  type BillingGateValue,
  type EventKind,
  getCanvas,
  getSandbox,
  getWorkspace,
  listThreadItems,
  newId,
  notifications,
  setCard,
  usageEvents,
  type WakeContext,
} from "@ponzu/db";
import { RUNNER_HEADER } from "@ponzu/runner/protocol";
import { canvasSandboxName } from "@ponzu/sandbox";
import { claimableKinds } from "../sandboxes/gates.ts";
import { WAKE_JOB } from "../sandboxes/orchestrate.ts";
import { startWake } from "../sandboxes/wake.ts";
import { call, canvasIn, type Workspace, workspaceWithRepo } from "../testing/canvases.ts";
import { createTestApp, TEST_CRON_SECRET, TEST_SCOPE, type TestApp } from "../testing/index.ts";
import {
  AT_A_BILLING_LIMIT,
  billingClaimableKinds,
  holdWakeAtLimit,
  refusalMessage,
  refuseSteerAtLimit,
} from "./enforce.ts";
import { refreshBillingGate, refreshBillingGates } from "./refresh.ts";

/*
 * The billing gate, cached and enforced (docs/cloud.md, "Billing"), through the routes, the wake,
 * the runner's claim and the sweep, on PGlite, the fake sandboxes, FakePayments and the test's
 * clock. Every mode is switched inside the test that needs it; the app starts with billing off,
 * as production runs today.
 */

let t: TestApp;
const KEY = "sk-ant-api03-maya-billing-gate-key-0000000";
const HOUR = 3600;
let n = 0;

beforeAll(async () => {
  t = await createTestApp();
  t.anthropic.keys.add(KEY);
  // Maya's Claude runs every canvas here.
  await t.signInAs({ login: "maya" });
  const connected = await call(t, await as("maya"), "POST", "/v1/claude/api-key", { key: KEY });
  expect(connected.status).toBe(200);
  await t.backgroundDone();
});
afterAll(() => t.close());

const as = async (login: string) => (await t.signInAs({ login })).headers;
const nameOf = (canvasId: string) => canvasSandboxName(TEST_SCOPE, canvasId);
const head = async (canvasId: string) => (await getCanvas(t.db, canvasId))!;

async function withBilling<T>(mode: "off" | "observe" | "on", work: () => Promise<T>) {
  const was = t.deps.features.billing;
  t.deps.features.billing = mode;
  try {
    return await work();
  } finally {
    t.deps.features.billing = was;
  }
}

async function rows(statement: string): Promise<Record<string, unknown>[]> {
  return ((await t.db.execute(statement)) as unknown as { rows: Record<string, unknown>[] }).rows;
}

async function cron() {
  const ran = await t.app.request("/v1/cron/minute", {
    headers: { authorization: `Bearer ${TEST_CRON_SECRET}` },
  });
  expect(ran.status).toBe(200);
  await t.backgroundDone();
  return (await ran.json()) as { steps: Record<string, Record<string, number>> };
}

/**
 * A team of Maya (an admin, whose Claude runs its canvases) and Ines, two members, so 200 free
 * credits a period. The test clock starts on 2026-01-01: its period runs December 9 to January 9.
 */
async function team(): Promise<Workspace> {
  const ws = await workspaceWithRepo(t, { maya: "admin", ines: "write" });
  await t.db.execute(
    `update workspaces set billing_period_anchor = '2025-10-09T00:00:00Z' where id = '${ws.id}'`,
  );
  return ws;
}

/** Awake time this period, as usage events: 5 credits an hour. */
async function used(ws: Workspace, hours: number) {
  await t.db.insert(usageEvents).values({
    id: `gate-${n++}`,
    workspaceId: ws.id,
    canvasId: null,
    userId: ws.people.maya!.userId,
    kind: "sandbox",
    seconds: hours * HOUR,
    credits: 0,
    costMicrousd: 0,
    payer: "ponzu",
    rateCardVersion: 1,
    occurredAt: new Date("2025-12-20T10:00:00Z"),
  });
}

/** A team past its 200 free credits (41 hours is 205 credits), with no card. */
async function pastFree() {
  const ws = await team();
  await used(ws, 41);
  return ws;
}

async function setGate(workspaceId: string, gate: BillingGateValue) {
  await t.db.execute(`update workspaces set billing_gate = '${gate}' where id = '${workspaceId}'`);
}

async function addCard(workspaceId: string) {
  await setCard(t.db, {
    workspaceId,
    paymentMethodId: `pm_${n++}`,
    brand: "visa",
    last4: "4242",
    addedByUserId: null,
    at: new Date(t.clock.now()),
  });
}

const say = async (canvasId: string, login = "maya") =>
  call(t, await as(login), "POST", `/v1/canvases/${canvasId}/messages`, {
    text: "Make the header calmer",
  });

const wakeJobs = (canvasId: string) =>
  rows(`select attempts, completed_at from jobs
         where kind = '${WAKE_JOB}' and key = '${canvasId}' order by created_at`);

/** Something in the feed for the agent, written without waking anything (a comment, say). */
async function owe(canvasId: string, kind: EventKind = "comment") {
  await appendEvent(t.db, {
    canvasId,
    kind,
    priority: kind === "edit" ? "later" : "now",
    payload: { text: "Waiting for you" },
  });
}

/** A database that fails the test the moment anything touches it. */
const untouchable = new Proxy(
  {},
  {
    get() {
      throw new Error("billing read the database while it should not have");
    },
  },
) as never;

describe("off changes nothing", () => {
  test("nothing billing adds reads the database while billing is off", async () => {
    const deps = {
      ...t.deps,
      db: untouchable,
      features: { ...t.deps.features, billing: "off" as const },
    };
    const steer = { action: "message", userId: "usr_1", workspaceId: "ws_1", withMessage: true };
    await refuseSteerAtLimit(deps as never, steer as never);
    expect(await billingClaimableKinds(deps as never, "cnv_1")).toBe("all");
    expect(await refreshBillingGate(deps as never, "ws_1")).toBeNull();
    expect(await refreshBillingGates(deps as never, new Date(t.clock.now()))).toBe(0);
    const ctx = { canvasId: "cnv_1", workspaceId: "ws_1", billingGate: "free_used" };
    expect(holdWakeAtLimit(ctx as WakeContext, { deps, reason: "message" })).toBeNull();
    // Observe never narrows a claim, so it never reads for one either.
    const observing = { ...deps, features: { ...deps.features, billing: "observe" as const } };
    expect(await billingClaimableKinds(observing as never, "cnv_1")).toBe("all");
  });

  test("past its free credits, even with a stale gate, a workspace steers, wakes and claims as before", async () => {
    const ws = await pastFree();
    // As a switch turned off after a while on could leave it.
    await setGate(ws.id, "free_used");
    const canvas = await canvasIn(t, ws, "maya", sampleDoc());
    const calls = t.payments.calls.length;

    const said = await say(canvas.id);
    expect(said.status).toBe(201);
    await t.backgroundDone();
    expect((await getSandbox(t.db, canvas.id))!.state).toBe("awake");
    expect((await head(canvas.id)).agentBlocker).toBeNull();

    const usage = await call(t, await as("maya"), "GET", `/v1/workspaces/${ws.id}/usage`);
    expect(usage.body.billing).toEqual({
      status: "not_set_up",
      card: null,
      invoices: "not_set_up",
    });
    const me = await call(t, await as("maya"), "GET", "/v1/me");
    const mine = (me.body.workspaces as Record<string, unknown>[]).find((w) => w.id === ws.id)!;
    expect(Object.keys(mine).toSorted()).toEqual(
      [
        "avatarUrl",
        "githubLogin",
        "id",
        "installed",
        "kind",
        "name",
        "role",
        "suspended",
      ].toSorted(),
    );

    const ran = await cron();
    expect(ran.steps.sandboxes).not.toHaveProperty("gated");
    expect(t.payments.calls.length).toBe(calls);
    // Nothing worked the gate out, so nothing stored it.
    expect(await getWorkspace(t.db, ws.id)).toMatchObject({
      billingGate: "free_used",
      billingGateAt: null,
    });
    const pinged = await t.db.select().from(notifications);
    expect(pinged.filter((p) => p.kind.startsWith("billing_"))).toEqual([]);
  });
});

describe("observe", () => {
  test("works the gate out and stores it, logs and captures what it would refuse, and refuses nothing", async () => {
    const ws = await pastFree();
    const canvas = await canvasIn(t, ws, "maya", sampleDoc());
    await withBilling("observe", async () => {
      expect(await refreshBillingGate(t.deps, ws.id)).toEqual({ before: "ok", after: "free_used" });
      const captured = t.analytics.events.length;

      const said = await say(canvas.id);
      expect(said.status).toBe(201);
      await t.backgroundDone();
      expect((await getSandbox(t.db, canvas.id))!.state).toBe("awake");
      expect((await head(canvas.id)).agentBlocker).toBeNull();
      const made = await call(t, await as("maya"), "POST", "/v1/canvases", {
        workspaceId: ws.id,
        repoId: ws.repo.id,
        message: { text: "Make a pricing page" },
      });
      expect(made.status).toBe(201);
      await t.backgroundDone();

      const walls = t.analytics.events
        .slice(captured)
        .filter((e) => e.event === "billing wall hit");
      expect(walls.map((e) => e.properties)).toEqual([
        expect.objectContaining({
          reason: "free_used",
          surface: "message",
          can_manage: true,
          enforced: false,
        }),
        expect.objectContaining({ reason: "free_used", surface: "create", enforced: false }),
      ]);
      const would = t.logs.filter(
        (l) => l.event === "billing_gate_would_refuse" && l.workspaceId === ws.id,
      );
      expect(would.map((l) => l.surface)).toContain("message");
      expect(would.map((l) => l.surface)).toContain("create");

      // The claim narrows nothing.
      expect(await billingClaimableKinds(t.deps, canvas.id)).toBe("all");
      // An app that predates billing still reads nothing as billed.
      const usage = await call(t, await as("maya"), "GET", `/v1/workspaces/${ws.id}/usage`);
      expect(usage.body.billing).toEqual({
        status: "not_set_up",
        card: null,
        invoices: "not_set_up",
        gate: "free_used",
        capWarning: false,
        pastDue: null,
      });
      const me = await call(t, await as("ines"), "GET", "/v1/me");
      const theirs = (me.body.workspaces as Record<string, unknown>[]).find((w) => w.id === ws.id);
      expect(theirs).toMatchObject({ billingGate: "ok", canManageBilling: false });
    });
    // Nobody is pinged in observe.
    const pinged = await t.db.select().from(notifications);
    expect(pinged.filter((p) => p.kind.startsWith("billing_"))).toEqual([]);
    expect(t.payments.calls).toEqual([]);
  });
});

describe("on", () => {
  test("a message or a create with one is refused with a 402 that says why, and nothing is written", async () => {
    const ws = await pastFree();
    const canvas = await canvasIn(t, ws, "maya", sampleDoc());
    await withBilling("on", async () => {
      await refreshBillingGate(t.deps, ws.id);
      const items = (await listThreadItems(t.db, { canvasId: canvas.id })).length;
      const events = await rows(`select id from events where canvas_id = '${canvas.id}'`);

      for (const [login, canManage] of [
        ["maya", true],
        ["ines", false],
      ] as const) {
        const said = await say(canvas.id, login);
        expect(said.status).toBe(402);
        expect(said.body).toEqual({
          error: {
            code: "billing_required",
            message: `${ws.github.installation.account.login} has used this month's free credits.`,
            details: {
              reason: "free_used",
              workspaceId: ws.id,
              workspaceName: ws.github.installation.account.login,
              canManage,
              capUsd: 100,
              billedCents: 50,
              periodEnd: "2026-01-09T00:00:00.000Z",
              invoiceUrl: null,
            },
          },
        });
      }
      await t.backgroundDone();
      expect((await listThreadItems(t.db, { canvasId: canvas.id })).length).toBe(items);
      expect(await rows(`select id from events where canvas_id = '${canvas.id}'`)).toEqual(events);
      expect(await getSandbox(t.db, canvas.id)).toBeNull();

      const create = (message?: string) =>
        as("maya").then((headers) =>
          call(t, headers, "POST", "/v1/canvases", {
            workspaceId: ws.id,
            repoId: ws.repo.id,
            ...(message ? { message: { text: message } } : {}),
          }),
        );
      const made = await create("Make a pricing page");
      expect(made.status).toBe(402);
      expect(made.body.error.details.reason).toBe("free_used");
      // A canvas with no message for the agent costs nothing, so it is made.
      expect((await create()).status).toBe(201);
    });
    expect(t.payments.calls).toEqual([]);
  });

  test("an answer is never refused: the turn that asked waits on it", async () => {
    const ws = await pastFree();
    await setGate(ws.id, "free_used");
    await withBilling("on", async () => {
      const steer = {
        action: "answer" as const,
        userId: ws.people.maya!.userId,
        workspaceId: ws.id,
        withMessage: true,
      };
      await refuseSteerAtLimit(t.deps, steer);
      await expect(refuseSteerAtLimit(t.deps, { ...steer, action: "message" })).rejects.toThrow(
        "has used this month's free credits.",
      );
    });
  });

  test("a comment's wake waits on the blocker, a push still wakes, and a card lets it go", async () => {
    const ws = await pastFree();
    const canvas = await canvasIn(t, ws, "maya", sampleDoc());
    await withBilling("on", async () => {
      expect(await refreshBillingGate(t.deps, ws.id)).toEqual({ before: "ok", after: "free_used" });
      const captured = t.analytics.events.length;
      await owe(canvas.id);
      await startWake(t.deps, canvas.id, "comment");
      expect(await head(canvas.id)).toMatchObject({ agentBlocker: "credits_used_up" });
      expect(await getSandbox(t.db, canvas.id)).toBeNull();
      expect(t.sandboxes.commands(nameOf(canvas.id))).toEqual([]);
      // Told once, not at every wake that finds it waiting.
      await startWake(t.deps, canvas.id, "comment");
      const waiting = t.analytics.events
        .slice(captured)
        .filter((e) => e.event === "canvas waiting on billing");
      expect(waiting.map((e) => e.properties)).toEqual([
        expect.objectContaining({ canvas_id: canvas.id, reason: "free_used" }),
      ]);

      // A card, as Stripe's settle will store it: the gate opens and the canvas wakes.
      await addCard(ws.id);
      expect(await refreshBillingGate(t.deps, ws.id)).toEqual({ before: "free_used", after: "ok" });
      await t.backgroundDone();
      expect((await head(canvas.id)).agentBlocker).toBeNull();
      expect((await getSandbox(t.db, canvas.id))!.state).toBe("awake");
      const [job] = await wakeJobs(canvas.id).then((jobs) => jobs.slice(-1));
      expect(job!.completed_at).not.toBeNull();
    });
  });

  test("a push wake is let through at a limit", async () => {
    const ws = await pastFree();
    const canvas = await canvasIn(t, ws, "maya", sampleDoc());
    await setGate(ws.id, "payment_failed");
    await withBilling("on", async () => {
      await owe(canvas.id, "push");
      await startWake(t.deps, canvas.id, "push");
      expect((await getSandbox(t.db, canvas.id))!.state).toBe("awake");
      expect((await head(canvas.id)).agentBlocker).toBeNull();
    });
  });

  test("a push asked for behind another wake is let through too", async () => {
    const ws = await pastFree();
    const canvas = await canvasIn(t, ws, "maya", sampleDoc());
    await setGate(ws.id, "free_used");
    await withBilling("on", async () => {
      // A failed check's wake waits for the cron, and Create PR's push rides on it.
      await owe(canvas.id, "check");
      await owe(canvas.id, "push");
      await startWake(t.deps, canvas.id, "check");
      expect((await getSandbox(t.db, canvas.id))!.state).toBe("awake");
    });
  });

  test("what the claim held back with no blocker on the head wakes once the gate opens", async () => {
    const ws = await pastFree();
    const canvas = await canvasIn(t, ws, "maya", sampleDoc());
    await setGate(ws.id, "free_used");
    // A message the claim held back, its sandbox since asleep: nothing on the head says why.
    await owe(canvas.id, "message");
    expect((await head(canvas.id)).agentBlocker).toBeNull();
    await withBilling("on", async () => {
      await addCard(ws.id);
      expect(await refreshBillingGate(t.deps, ws.id)).toEqual({ before: "free_used", after: "ok" });
      await cron();
      expect((await getSandbox(t.db, canvas.id))!.state).toBe("awake");
    });
  });

  test("the claim holds back what would begin a turn, and hands it out once the gate opens", async () => {
    const ws = await team();
    const canvas = await canvasIn(t, ws, "maya", sampleDoc());
    // Awake, its runner in, with nothing left to take up.
    expect((await say(canvas.id)).status).toBe(201);
    await t.backgroundDone();
    const starts = t.sandboxes.commands(nameOf(canvas.id)).filter((c) => c.kind === "start");
    const token = starts.at(-1)!.command.env!.PONZU_RUNNER_TOKEN!;
    const session = await call(
      t,
      { authorization: `Bearer ${token}` },
      "POST",
      "/v1/runner/session",
    );
    const headers = { authorization: `Bearer ${token}`, [RUNNER_HEADER]: session.body.runnerId };
    const claim = async () => {
      const claimed = await call(t, headers, "POST", "/v1/runner/events/claim", {
        claimId: newId("clm"),
      });
      expect(claimed.status).toBe(200);
      return (claimed.body.events as { kind: string }[]).map((e) => e.kind).toSorted();
    };
    await claim();

    for (const kind of [
      "message",
      "comment",
      "check",
      "review",
      "stop",
      "answer",
      "edit",
    ] as const) {
      await owe(canvas.id, kind);
    }
    await setGate(ws.id, "cap_reached");
    await withBilling("on", async () => {
      expect(await claim()).toEqual(["answer", "edit", "stop"]);
      expect(await claim()).toEqual([]);
      // Held back, not handed out, so not owed: the sweep lapses nothing.
      const ran = await cron();
      expect(ran.steps.sandboxes!.lapse).toBe(0);
      await setGate(ws.id, "ok");
      expect(await claim()).toEqual(["check", "comment", "message", "review"]);
    });
  });

  test("with Claude's plan limit too, the claim hands out only what both allow", async () => {
    const ws = await team();
    const canvas = await canvasIn(t, ws, "maya", sampleDoc());
    await setGate(ws.id, "free_used");
    await t.db.execute(
      `update claude_accounts set limited_until = '2026-06-01T00:00:00Z' where user_id = '${ws.people.maya!.userId}'`,
    );
    try {
      await withBilling("on", async () => {
        expect(AT_A_BILLING_LIMIT).toEqual(["stop", "answer", "edit", "push"]);
        // Claude's plan limit allows a stop, an edit and a push; billing adds the answer.
        expect(await claimableKinds(t.deps, { canvasId: canvas.id })).toEqual([
          "stop",
          "edit",
          "push",
        ]);
      });
    } finally {
      await t.db.execute(
        `update claude_accounts set limited_until = null where user_id = '${ws.people.maya!.userId}'`,
      );
    }
  });

  test("admins are pinged once a period for each notice, and members are not", async () => {
    const ws = await pastFree();
    await withBilling("on", async () => {
      await refreshBillingGate(t.deps, ws.id);
      await setGate(ws.id, "ok");
      await refreshBillingGate(t.deps, ws.id);
      await t.backgroundDone();
    });
    const pinged = (await t.db.select().from(notifications)).filter(
      (p) => p.kind === "billing_free_used" && p.workspaceId === ws.id,
    );
    expect(pinged.map((p) => p.userId)).toEqual([ws.people.maya!.userId]);
    expect(t.payments.calls).toEqual([]);
  });

  test("raising the cap opens the gate and wakes what waited; at 80% admins are warned", async () => {
    const ws = await team();
    await addCard(ws.id);
    // 200 free, then $10 billed: 300 credits is 60 hours. Cap $10.
    await used(ws, 60);
    await t.db.execute(`update workspaces set monthly_cap_cents = 1000 where id = '${ws.id}'`);
    const canvas = await canvasIn(t, ws, "maya", sampleDoc());
    await withBilling("on", async () => {
      expect(await refreshBillingGate(t.deps, ws.id)).toMatchObject({ after: "cap_reached" });
      await owe(canvas.id, "message");
      await startWake(t.deps, canvas.id, "message");
      expect(await head(canvas.id)).toMatchObject({ agentBlocker: "cap_reached" });

      const raised = await call(t, await as("maya"), "PATCH", `/v1/workspaces/${ws.id}/billing`, {
        capUsd: 12,
      });
      expect(raised.status).toBe(200);
      await t.backgroundDone();
      // $10 of $12 is past 80%.
      expect(raised.body.billing).toEqual({
        status: "on",
        card: { brand: "visa", last4: "4242" },
        invoices: "not_set_up",
        gate: "ok",
        capWarning: true,
        pastDue: null,
      });
      expect((await head(canvas.id)).agentBlocker).toBeNull();
      expect((await getSandbox(t.db, canvas.id))!.state).toBe("awake");

      // A member sees no card.
      const theirs = await call(t, await as("ines"), "GET", `/v1/workspaces/${ws.id}/usage`);
      expect(theirs.body.billing).toMatchObject({ status: "on", card: null, pastDue: null });
      // And the gate on `me`, read from the cache.
      await setGate(ws.id, "cap_reached");
      const me = await call(t, await as("ines"), "GET", "/v1/me");
      const mine = (me.body.workspaces as Record<string, unknown>[]).find((w) => w.id === ws.id);
      expect(mine).toMatchObject({ billingGate: "cap_reached", canManageBilling: false });
      await setGate(ws.id, "ok");
    });
    const kinds = (await t.db.select().from(notifications))
      .filter((p) => p.workspaceId === ws.id)
      .map((p) => p.kind)
      .toSorted();
    expect(kinds).toEqual(["billing_cap_reached", "billing_cap_warning"]);
  });

  test("the sweep works out the gate of a workspace with a sandbox up, and says so only while on", async () => {
    const ws = await pastFree();
    const canvas = await canvasIn(t, ws, "maya", sampleDoc());
    expect((await say(canvas.id)).status).toBe(201);
    await t.backgroundDone();
    // Past its free credits too, but nothing up and its gate `ok`: nothing to work out.
    const idle = await pastFree();
    const ran = await withBilling("on", cron);
    expect(ran.steps.sandboxes!.gated).toBeGreaterThanOrEqual(1);
    expect(await getWorkspace(t.db, ws.id)).toMatchObject({ billingGate: "free_used" });
    expect((await getWorkspace(t.db, ws.id))!.billingGateAt).not.toBeNull();
    expect(await getWorkspace(t.db, idle.id)).toMatchObject({
      billingGate: "ok",
      billingGateAt: null,
    });
    // Held back, a workspace is worked out every run until it is let go.
    await setGate(idle.id, "free_used");
    await withBilling("on", cron);
    expect((await getWorkspace(t.db, idle.id))!.billingGateAt).not.toBeNull();
  });
});

describe("the words", () => {
  test("say the workspace, or you for your own", () => {
    const team = { name: "Acme", you: false };
    const own = { name: "maya", you: true };
    expect(refusalMessage("free_used", team, 10_000)).toBe(
      "Acme has used this month's free credits.",
    );
    expect(refusalMessage("free_used", own, 10_000)).toBe("You've used this month's free credits.");
    expect(refusalMessage("cap_reached", team, 250_000)).toBe(
      "Acme has reached this month's $2,500 cap.",
    );
    expect(refusalMessage("cap_reached", own, 10_000)).toBe(
      "You've reached this month's $100 cap.",
    );
    expect(refusalMessage("payment_failed", team, 0)).toBe(
      "Acme's last payment didn't go through.",
    );
    expect(refusalMessage("payment_failed", own, 0)).toBe("Your last payment didn't go through.");
  });
});
