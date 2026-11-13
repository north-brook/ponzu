import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sampleDoc } from "@ponzu/core/fixtures";
import { applyInvoiceState, billingPeriods, getWorkspace, setCard, usageEvents } from "@ponzu/db";
import type { InvoiceState } from "../deps/payments.ts";
import { NOTIFY_JOB } from "../notifications/notify.ts";
import { call, canvasIn, type Workspace, workspaceWithRepo } from "../testing/canvases.ts";
import { createTestApp, TEST_CRON_SECRET, TEST_SCOPE, type TestApp } from "../testing/index.ts";
import {
  CLOSE_JOB,
  type CloseJobPayload,
  closeDuePeriods,
  closePeriod,
  invoiceWords,
  LATE_CLOSE_MS,
  runCloseJob,
  unchargedReason,
} from "./close.ts";
import { GRACE_MS } from "./gate.ts";
import { periodStatusOf } from "./invoices.ts";
import { refreshBillingGates } from "./refresh.ts";

/*
 * The period close, invoicing and payment state (docs/cloud.md, "Billing", "The period close"
 * and "Failed payments"), on PGlite, FakePayments and the test's clock. The clock starts on
 * 2026-01-01 at midnight UTC; a workspace anchored on the 1st has a period that just ended
 * (December 1 to January 1), which these tests close. The app starts with billing off, as
 * production runs today, and each test switches the mode it needs.
 */

let t: TestApp;
let n = 0;
const HOUR = 3600;
const DEC_1 = new Date("2025-12-01T00:00:00Z");
const JAN_1 = new Date("2026-01-01T00:00:00Z");

beforeAll(async () => {
  t = await createTestApp();
  // Ten minutes and a second past the period's end: when the cron first closes it.
  t.clock.advance(10 * 60_000 + 1_000);
});
afterAll(() => t.close());

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

/**
 * A team of Maya (an admin) and Ines, members since long before the period, so 200 free credits
 * in it, anchored on the 1st. `day` picks another anchor day.
 */
async function team(day = 1): Promise<Workspace> {
  const ws = await workspaceWithRepo(t, { maya: "admin", ines: "write" });
  const anchor = `2025-10-${String(day).padStart(2, "0")}T00:00:00Z`;
  await t.db.execute(
    `update workspaces set billing_period_anchor = '${anchor}' where id = '${ws.id}'`,
  );
  await t.db.execute(
    `update memberships set created_at = '2025-01-01T00:00:00Z' where workspace_id = '${ws.id}'`,
  );
  return ws;
}

/** Awake time, as one usage event dated `at` (in December by default): 5 credits an hour. */
async function used(ws: Workspace, hours: number, at = new Date("2025-12-20T10:00:00Z")) {
  await t.db.insert(usageEvents).values({
    id: `close-${n++}`,
    workspaceId: ws.id,
    canvasId: null,
    userId: ws.people.maya!.userId,
    kind: "sandbox",
    seconds: hours * HOUR,
    credits: 0,
    costMicrousd: 0,
    payer: "ponzu",
    rateCardVersion: 1,
    occurredAt: at,
  });
}

/** The workspace's Stripe customer (made at the fake) and a card, as a settled setup leaves it. */
async function addCard(ws: Workspace) {
  const { customerId } = await withBilling("on", () =>
    t.payments.ensureCustomer({ workspaceId: ws.id, name: ws.id, email: null, ip: null }),
  );
  await t.db.execute(
    `update workspaces set stripe_customer_id = '${customerId}' where id = '${ws.id}'`,
  );
  await setCard(t.db, {
    workspaceId: ws.id,
    paymentMethodId: `pm_close_${n++}`,
    brand: "visa",
    last4: "4242",
    addedByUserId: ws.people.maya!.userId,
    at: new Date(t.clock.now()),
  });
  return customerId;
}

const december = (ws: Workspace): CloseJobPayload => ({
  workspaceId: ws.id,
  periodStart: DEC_1,
  periodEnd: JAN_1,
  closeAt: JAN_1,
});

async function periodOf(ws: Workspace, start = DEC_1) {
  const all = await t.db.select().from(billingPeriods);
  return (
    all.find((row) => row.workspaceId === ws.id && row.periodStart.getTime() === start.getTime()) ??
    null
  );
}

/** The fake's invoices for a workspace. */
const invoicesOf = (ws: Workspace) =>
  [...t.payments.invoices.values()].filter((i) => i.metadata.ponzu_workspace_id === ws.id);

const callsFor = (ws: Workspace) =>
  t.payments.calls.filter((c) => JSON.stringify(c.args).includes(ws.id));

async function deliver(event: { type: string; object: Record<string, unknown> }) {
  const { body, signature } = await t.payments.webhookFor(event);
  const response = await t.app.request("/v1/stripe/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": signature },
    body,
  });
  await t.backgroundDone();
  return response.status;
}

/** Stripe's event about one of a period's invoices, with the marks the seam put on it. */
const invoiceEvent = (type: string, invoiceId: string, metadata?: Record<string, string>) => {
  const invoice = t.payments.invoices.get(invoiceId)!;
  return {
    type,
    object: {
      id: invoiceId,
      object: "invoice",
      customer: invoice.customerId,
      metadata: metadata ?? invoice.metadata,
    },
  };
};

/** A team with a card, past its free credits by $180 (2,000 credits used, 200 free). */
async function billedTeam(capCents = 10_000) {
  const ws = await team();
  await addCard(ws);
  await used(ws, 400);
  await t.db.execute(`update workspaces set monthly_cap_cents = ${capCents} where id = '${ws.id}'`);
  return ws;
}

describe("the pure rules", () => {
  test("an invoice's words name the workspace, the credits and the period's first and last day", () => {
    expect(
      invoiceWords("Fernwood", {
        periodStart: new Date("2026-10-12T00:00:00Z"),
        periodEnd: new Date("2026-11-12T00:00:00Z"),
        usedCredits: 1_250,
        freeCredits: 200,
        chargedCredits: 1_050,
      }),
    ).toEqual({
      description: "Fernwood · 1,250 credits used, 200 free",
      line: "Ponzu usage, Oct 12 – Nov 11, 2026 · 1,050 credits",
    });
    expect(
      invoiceWords("Fernwood", {
        periodStart: new Date("2025-12-15T00:00:00Z"),
        periodEnd: new Date("2026-01-15T00:00:00Z"),
        usedCredits: 1,
        freeCredits: 0,
        chargedCredits: 1,
      }).line,
    ).toBe("Ponzu usage, Dec 15, 2025 – Jan 14, 2026 · 1 credit");
  });

  test("an invoice's status gives its period's", () => {
    const state = (s: Partial<InvoiceState>): InvoiceState => ({
      id: "in_1",
      status: "open",
      amountDueCents: 100,
      totalCents: 100,
      taxCents: 0,
      attemptCount: 0,
      nextPaymentAttemptAt: null,
      hostedInvoiceUrl: null,
      number: null,
      lineCount: 1,
      needsAction: false,
      metadata: {},
      ...s,
    });
    expect(periodStatusOf(state({ status: "draft" }))).toBeNull();
    expect(periodStatusOf(state({}))).toBe("invoiced");
    expect(periodStatusOf(state({ attemptCount: 1 }))).toBe("payment_failed");
    expect(periodStatusOf(state({ attemptCount: 1, needsAction: true }))).toBe("payment_failed");
    expect(periodStatusOf(state({ status: "paid", attemptCount: 1 }))).toBe("paid");
    expect(periodStatusOf(state({ status: "uncollectible" }))).toBe("uncollectible");
    expect(periodStatusOf(state({ status: "void" }))).toBe("void");
  });

  test("a period is charged only with billing on, a card, a dollar or more, and a timely close", () => {
    const card = { stripeCustomerId: "cus_1", stripePaymentMethodId: "pm_1" };
    const period = {
      closedAt: new Date(JAN_1.getTime() + 600_000),
      periodEnd: JAN_1,
      chargedCents: 100,
      stripeInvoiceId: null,
    };
    expect(unchargedReason("on", card, period)).toBeNull();
    expect(unchargedReason("observe", card, period)).toEqual({
      status: "unbilled",
      why: "billing_not_on",
    });
    expect(
      unchargedReason("on", card, {
        ...period,
        closedAt: new Date(JAN_1.getTime() + LATE_CLOSE_MS + 1),
      }),
    ).toEqual({ status: "unbilled", why: "closed_late" });
    expect(unchargedReason("on", card, { ...period, chargedCents: 99 })).toEqual({
      status: "waived",
      why: "under_minimum",
    });
    expect(unchargedReason("on", { ...card, stripePaymentMethodId: null }, period)).toEqual({
      status: "waived",
      why: "no_card",
    });
    // An invoice under way is finished, whatever else is true now.
    expect(
      unchargedReason(
        "observe",
        { ...card, stripePaymentMethodId: null },
        {
          ...period,
          chargedCents: 0,
          stripeInvoiceId: "in_1",
        },
      ),
    ).toBeNull();
  });
});

describe("with billing off, as production runs today", () => {
  test("the cron has no close step, a close job left over does nothing, and nothing is written", async () => {
    const ws = await billedTeam();
    const ran = await t.app.request("/v1/cron/minute", {
      headers: { authorization: `Bearer ${TEST_CRON_SECRET}` },
    });
    expect(ran.status).toBe(200);
    await t.backgroundDone();
    const answer = (await ran.json()) as { steps: Record<string, unknown> };
    expect(answer.steps.close_periods).toBeUndefined();
    expect(await closeDuePeriods(t.deps, new Date(t.clock.now()))).toEqual({
      scheduled: 0,
      queued: 0,
      skipped: 0,
    });
    const before = t.payments.calls.length;
    await runCloseJob(t.deps, {
      workspaceId: ws.id,
      periodStart: DEC_1.toISOString(),
      periodEnd: JAN_1.toISOString(),
      closeAt: JAN_1.toISOString(),
    });
    expect(t.payments.calls.length).toBe(before);
    expect(await periodOf(ws)).toBeNull();
    expect(await getWorkspace(t.db, ws.id)).toMatchObject({
      billingNextCloseAt: null,
      billingGateAt: null,
      pastDueAt: null,
    });
    expect(await rows(`select 1 from jobs where kind = '${CLOSE_JOB}'`)).toEqual([]);
  });
});

describe("closing a period", () => {
  test("observe closes it unbilled, frozen, and asks Stripe nothing", async () => {
    const ws = await billedTeam();
    const before = t.payments.calls.length;
    const period = await withBilling("observe", () => closePeriod(t.deps, december(ws)));
    expect(period).toMatchObject({
      status: "unbilled",
      usedCredits: 2_000,
      freeCredits: 200,
      billedCredits: 1_800,
      chargedCredits: 1_000,
      chargedCents: 10_000,
      capCents: 10_000,
      people: 2,
      rateCardVersion: 1,
      stripeInvoiceId: null,
    });
    expect(t.payments.calls.length).toBe(before);
  });

  test("under a dollar is waived, and so is a period with no card; neither asks Stripe", async () => {
    const small = await team();
    await addCard(small);
    // 205 credits used, 200 free: 5 billed, 50 cents.
    await used(small, 41);
    const noCard = await team();
    await used(noCard, 400);
    const before = t.payments.calls.length;
    await withBilling("on", async () => {
      expect(await closePeriod(t.deps, december(small))).toMatchObject({
        status: "waived",
        billedCredits: 5,
        chargedCents: 50,
      });
      expect(await closePeriod(t.deps, december(noCard))).toMatchObject({
        status: "waived",
        chargedCents: 10_000,
      });
    });
    expect(t.payments.calls.length).toBe(before);
  });

  test("a period closed days after it ended is not billed", async () => {
    const ws = await billedTeam();
    // November's period ended a month ago, while billing was off.
    await used(ws, 400, new Date("2025-11-20T10:00:00Z"));
    const november = {
      workspaceId: ws.id,
      periodStart: new Date("2025-11-01T00:00:00Z"),
      periodEnd: DEC_1,
      closeAt: DEC_1,
    };
    const period = await withBilling("on", () => closePeriod(t.deps, november));
    expect(period).toMatchObject({ status: "unbilled", chargedCents: 10_000 });
    expect(callsFor(ws).filter((c) => c.method === "chargePeriod")).toEqual([]);
  });

  test("on, with a card: one invoice with one line, charged no more than the cap", async () => {
    // $10.50 cap: 105 credits of the 1,800 billed.
    const ws = await billedTeam(1_050);
    const period = await withBilling("on", () => closePeriod(t.deps, december(ws)));
    expect(period).toMatchObject({
      status: "invoiced",
      billedCredits: 1_800,
      chargedCredits: 105,
      chargedCents: 1_050,
      capCents: 1_050,
      totalCents: 1_050,
      attempts: 0,
    });
    const [invoice] = invoicesOf(ws);
    expect(invoicesOf(ws)).toHaveLength(1);
    expect(invoice!.status).toBe("open");
    expect(invoice!.lines).toEqual([
      {
        quantity: 105,
        description: "Ponzu usage, Dec 1 – Dec 31, 2025 · 105 credits",
        periodStart: DEC_1.toISOString(),
      },
    ]);
    const stored = await periodOf(ws);
    expect(stored).toMatchObject({
      status: "invoiced",
      stripeInvoiceId: invoice!.id,
      invoiceNumber: invoice!.number,
      hostedInvoiceUrl: invoice!.hostedInvoiceUrl,
      totalCents: 1_050,
    });
    expect(stored!.invoicedAt).not.toBeNull();
    // Closing it again charges nothing more.
    await withBilling("on", () => closePeriod(t.deps, december(ws)));
    expect(invoicesOf(ws)).toHaveLength(1);
    expect(callsFor(ws).filter((c) => c.method === "chargePeriod")).toHaveLength(1);
    expect(
      t.analytics.events.filter(
        (e) => e.event === "period closed" && e.groups?.workspace === ws.id,
      ),
    ).toHaveLength(1);
  });

  for (const step of ["invoice", "item", "finalize"] as const) {
    test(`crashed after Stripe's ${step}, and run again a day later: exactly one invoice, one line`, async () => {
      const ws = await billedTeam();
      await withBilling("on", async () => {
        t.payments.crashChargeAfter(step);
        await expect(closePeriod(t.deps, december(ws))).rejects.toThrow(`crashed after ${step}`);
        if (step !== "invoice") t.payments.forgetIdempotencyKeys();
        expect(await closePeriod(t.deps, december(ws))).toMatchObject({ status: "invoiced" });
      });
      const made = invoicesOf(ws);
      expect(made).toHaveLength(1);
      expect(made[0]!.lines).toHaveLength(1);
      expect(made[0]!.lines[0]!.quantity).toBe(1_000);
      expect(made[0]!.status).toBe("open");
      expect(await periodOf(ws)).toMatchObject({
        status: "invoiced",
        stripeInvoiceId: made[0]!.id,
        chargedCredits: 1_000,
      });
    });
  }

  test("crashed before the invoice's id was stored, and run again after Stripe forgot the key: one charge", async () => {
    // The one case our row cannot cover: Stripe made the invoice, the close never heard of it,
    // and a day passed. A second draft is made; the first stays an empty draft that is never
    // finalized (it was made without automatic collection), so nothing is charged twice.
    const ws = await billedTeam();
    await withBilling("on", async () => {
      t.payments.crashChargeAfter("invoice");
      await expect(closePeriod(t.deps, december(ws))).rejects.toThrow("crashed after invoice");
      t.payments.forgetIdempotencyKeys();
      expect(await closePeriod(t.deps, december(ws))).toMatchObject({ status: "invoiced" });
    });
    const made = invoicesOf(ws);
    const finalized = made.filter((invoice) => invoice.status !== "draft");
    expect(finalized).toHaveLength(1);
    expect(finalized[0]!.lines).toHaveLength(1);
    expect(made.filter((invoice) => invoice.status === "draft")).toEqual([
      expect.objectContaining({ lines: [], totalCents: 0 }),
    ]);
    expect((await periodOf(ws))!.stripeInvoiceId).toBe(finalized[0]!.id);
  });

  test("an answer lost after Stripe charged: run again, the same one invoice", async () => {
    const ws = await billedTeam();
    await withBilling("on", async () => {
      t.payments.failNext("chargePeriod", new Error("the answer was lost"), "after");
      await expect(closePeriod(t.deps, december(ws))).rejects.toThrow("the answer was lost");
      t.payments.forgetIdempotencyKeys();
      expect(await closePeriod(t.deps, december(ws))).toMatchObject({ status: "invoiced" });
    });
    expect(invoicesOf(ws)).toHaveLength(1);
    expect(invoicesOf(ws)[0]!.lines).toHaveLength(1);
  });

  test("a Stripe price that is not the rate card's refuses to charge, until it is", async () => {
    const ws = await billedTeam();
    await withBilling("on", async () => {
      t.payments.creditPrice.unitAmountDecimal = "12";
      try {
        await expect(closePeriod(t.deps, december(ws))).rejects.toThrow("billing_price_mismatch");
      } finally {
        t.payments.creditPrice.unitAmountDecimal = "10";
      }
      expect(callsFor(ws).filter((c) => c.method === "chargePeriod")).toEqual([]);
      expect(await periodOf(ws)).toMatchObject({ status: "closing", stripeInvoiceId: null });
      expect(t.logs.some((line) => line.event === "billing_price_mismatch")).toBe(true);
      expect(await closePeriod(t.deps, december(ws))).toMatchObject({ status: "invoiced" });
    });
    expect(invoicesOf(ws)).toHaveLength(1);
  });

  test("a stretch awake since before the period, never cut, is cut at its end and counted", async () => {
    // Awake since November 30 at 22:00 and not metered since: the read alone would count none
    // of it in December, since a stretch counts in the period it began in.
    const ws = await team();
    const canvas = await canvasIn(t, ws, "maya", sampleDoc());
    await t.db.execute(
      `insert into sandboxes (canvas_id, state, awake_since, awake_user_id)
       values ('${canvas.id}', 'awake', '2025-11-30T22:00:00Z', '${ws.people.maya!.userId}')`,
    );
    const period = await withBilling("observe", () => closePeriod(t.deps, december(ws)));
    // All of December awake: 744 hours at 5 credits an hour.
    expect(period).toMatchObject({ status: "unbilled", usedCredits: 3_720 });
    const [sandbox] = await rows(
      `select awake_since from sandboxes where canvas_id = '${canvas.id}'`,
    );
    expect(new Date(sandbox!.awake_since as string)).toEqual(JAN_1);
  });

  test("someone who joined after the period ended is not counted for it", async () => {
    const ws = await workspaceWithRepo(t, { maya: "admin", ines: "write", leo: "write" });
    await t.db.execute(
      `update workspaces set billing_period_anchor = '2025-10-01T00:00:00Z' where id = '${ws.id}'`,
    );
    await t.db.execute(
      `update memberships set created_at = '2025-01-01T00:00:00Z' where workspace_id = '${ws.id}'`,
    );
    await t.db.execute(
      `update memberships set created_at = '2026-01-01T00:05:00Z'
        where workspace_id = '${ws.id}' and user_id = '${ws.people.leo!.userId}'`,
    );
    await used(ws, 400);
    const period = await withBilling("observe", () => closePeriod(t.deps, december(ws)));
    expect(period).toMatchObject({ people: 2, freeCredits: 200, billedCredits: 1_800 });
  });

  test("a close run again after the next one moved on leaves the next close where it is", async () => {
    const ws = await team();
    await used(ws, 1);
    await t.db.execute(
      `update workspaces set billing_next_close_at = '${JAN_1.toISOString()}' where id = '${ws.id}'`,
    );
    await withBilling("observe", () => closePeriod(t.deps, december(ws)));
    expect((await getWorkspace(t.db, ws.id))!.billingNextCloseAt).toEqual(
      new Date("2026-02-01T00:00:00Z"),
    );
    // January closed too, meanwhile; December's job runs once more.
    const march = new Date("2026-03-01T00:00:00Z");
    await t.db.execute(
      `update workspaces set billing_next_close_at = '${march.toISOString()}' where id = '${ws.id}'`,
    );
    await withBilling("observe", () => closePeriod(t.deps, december(ws)));
    expect((await getWorkspace(t.db, ws.id))!.billingNextCloseAt).toEqual(march);
  });
});

describe("invoice webhooks", () => {
  /** A team whose December is charged: its period and its invoice's id. */
  async function charged() {
    const ws = await billedTeam();
    await withBilling("on", () => closePeriod(t.deps, december(ws)));
    return { ws, invoiceId: invoicesOf(ws)[0]!.id };
  }

  const failedPings = async (ws: Workspace) =>
    (await rows(`select payload from jobs where kind = '${NOTIFY_JOB}'`)).filter((row) => {
      const payload = row.payload as Record<string, unknown>;
      return payload.workspaceId === ws.id && payload.notice === "payment_failed";
    });

  /** The payment_failed notifications people were given: one a person, however often asked. */
  const failedNotifications = async (ws: Workspace) =>
    rows(
      `select user_id, body from notifications
        where workspace_id = '${ws.id}' and kind = 'billing_payment_failed'`,
    );

  test("a failed payment marks the workspace past due and pings once; paid clears it", async () => {
    const { ws, invoiceId } = await charged();
    await withBilling("on", async () => {
      t.payments.failInvoice(invoiceId, new Date(t.clock.now() + 3 * 86_400_000));
      expect(await deliver(invoiceEvent("invoice.payment_failed", invoiceId))).toBe(200);
      // Stripe tries again and fails again: still once.
      t.payments.failInvoice(invoiceId);
      expect(await deliver(invoiceEvent("invoice.payment_failed", invoiceId))).toBe(200);
    });
    expect(await periodOf(ws)).toMatchObject({ status: "payment_failed", attempts: 2 });
    const workspace = (await getWorkspace(t.db, ws.id))!;
    expect(workspace).toMatchObject({
      pastDueReason: "failed",
      pastDueInvoiceUrl: `https://invoice.stripe.test/i/${invoiceId}`,
    });
    expect(workspace.pastDueAt).not.toBeNull();
    const pings = await failedPings(ws);
    expect(pings.length).toBeGreaterThan(0);
    for (const ping of pings) {
      expect(ping.payload).toMatchObject({
        kind: "billing",
        notice: "payment_failed",
        amountCents: 10_000,
        periodStart: DEC_1.toISOString(),
      });
    }
    // Two failed attempts, one notification: to Maya, the admin, and not to Ines.
    expect(await failedNotifications(ws)).toEqual([
      { user_id: ws.people.maya!.userId, body: expect.stringContaining("$100") },
    ]);
    expect(
      t.analytics.events.filter(
        (e) =>
          e.event === "billing notice" &&
          e.properties.kind === "payment_failed" &&
          e.groups?.workspace === ws.id,
      ),
    ).toHaveLength(1);
    expect(
      t.analytics.events.filter(
        (e) => e.event === "invoice payment failed" && e.groups?.workspace === ws.id,
      ),
    ).toHaveLength(2);

    // An admin sees what is past due; a member does not.
    await withBilling("on", async () => {
      const admin = await call(t, ws.people.maya!.headers, "GET", `/v1/workspaces/${ws.id}/usage`);
      expect(admin.body.billing.pastDue).toMatchObject({
        reason: "failed",
        invoiceUrl: `https://invoice.stripe.test/i/${invoiceId}`,
      });
      const member = await call(t, ws.people.ines!.headers, "GET", `/v1/workspaces/${ws.id}/usage`);
      expect(member.body.billing.pastDue).toBeNull();
      expect(member.body.billing.card).toBeNull();

      t.payments.payInvoice(invoiceId);
      expect(await deliver(invoiceEvent("invoice.paid", invoiceId))).toBe(200);
    });
    expect(await periodOf(ws)).toMatchObject({ status: "paid", nextAttemptAt: null });
    expect(await getWorkspace(t.db, ws.id)).toMatchObject({
      pastDueAt: null,
      pastDueReason: null,
      pastDueInvoiceUrl: null,
    });
    expect(
      t.analytics.events.filter((e) => e.event === "invoice paid" && e.groups?.workspace === ws.id),
    ).toEqual([
      expect.objectContaining({
        properties: expect.objectContaining({ charged_cents: 10_000, attempts: 3 }),
      }),
    ]);
  });

  test("paid delivered before payment_failed ends paid, never past due", async () => {
    const { ws, invoiceId } = await charged();
    await withBilling("on", async () => {
      t.payments.failInvoice(invoiceId);
      t.payments.payInvoice(invoiceId);
      // Stripe's later event first, then the earlier one: each job reads the invoice now.
      expect(await deliver(invoiceEvent("invoice.paid", invoiceId))).toBe(200);
      expect(await deliver(invoiceEvent("invoice.payment_failed", invoiceId))).toBe(200);
    });
    expect(await periodOf(ws)).toMatchObject({ status: "paid" });
    expect((await getWorkspace(t.db, ws.id))!.pastDueAt).toBeNull();
    expect(await failedPings(ws)).toEqual([]);
  });

  test("a failure stored by a job that stopped before pinging still pings on the retry", async () => {
    const { ws, invoiceId } = await charged();
    t.payments.failInvoice(invoiceId);
    // The first try stored the failure, then died before it told anyone.
    await applyInvoiceState(t.db, {
      workspaceId: ws.id,
      stripeInvoiceId: invoiceId,
      status: "payment_failed",
      attempts: 1,
      nextAttemptAt: null,
      invoiceNumber: null,
      hostedInvoiceUrl: null,
      taxCents: 0,
      totalCents: 10_000,
      at: new Date(t.clock.now()),
    });
    await withBilling("on", () => deliver(invoiceEvent("invoice.payment_failed", invoiceId)));
    expect(await failedNotifications(ws)).toHaveLength(1);
    expect((await getWorkspace(t.db, ws.id))!.pastDueAt).not.toBeNull();
  });

  test("two reads applied in the wrong order never take a period back", async () => {
    const { ws, invoiceId } = await charged();
    const at = new Date(t.clock.now());
    const base = {
      workspaceId: ws.id,
      stripeInvoiceId: invoiceId,
      nextAttemptAt: null,
      invoiceNumber: null,
      hostedInvoiceUrl: null,
      taxCents: 0,
      totalCents: 10_000,
      at,
    };
    expect(await applyInvoiceState(t.db, { ...base, status: "paid", attempts: 2 })).toMatchObject({
      before: "invoiced",
      after: "paid",
    });
    expect(
      await applyInvoiceState(t.db, { ...base, status: "payment_failed", attempts: 1 }),
    ).toMatchObject({ before: "paid", after: "paid", attempts: 2, firstFailure: false });
    expect(
      await applyInvoiceState(t.db, { ...base, status: "invoiced", attempts: 0 }),
    ).toMatchObject({ after: "paid" });
    // Another workspace cannot name it.
    expect(
      await applyInvoiceState(t.db, {
        ...base,
        workspaceId: "ws_other",
        status: "void",
        attempts: 0,
      }),
    ).toBeNull();
  });

  test("a payment waiting on the bank says so; uncollectible stays past due; void clears it", async () => {
    const { ws, invoiceId } = await charged();
    await withBilling("on", async () => {
      t.payments.requireAction(invoiceId);
      await deliver(invoiceEvent("invoice.payment_action_required", invoiceId));
      expect((await getWorkspace(t.db, ws.id))!.pastDueReason).toBe("needs_confirmation");

      t.payments.invoices.get(invoiceId)!.status = "uncollectible";
      t.payments.invoices.get(invoiceId)!.needsAction = false;
      await deliver(invoiceEvent("invoice.marked_uncollectible", invoiceId));
      expect(await periodOf(ws)).toMatchObject({ status: "uncollectible" });
      expect((await getWorkspace(t.db, ws.id))!.pastDueAt).not.toBeNull();

      t.payments.invoices.get(invoiceId)!.status = "void";
      await deliver(invoiceEvent("invoice.voided", invoiceId));
    });
    expect(await periodOf(ws)).toMatchObject({ status: "void" });
    expect((await getWorkspace(t.db, ws.id))!.pastDueAt).toBeNull();
  });

  test("an invoice made by hand at Stripe, with no workspace of ours, is left alone", async () => {
    const { ws, invoiceId } = await charged();
    await withBilling("on", async () => {
      t.payments.failInvoice(invoiceId);
      expect(
        await deliver(
          invoiceEvent("invoice.payment_failed", invoiceId, { ponzu_scope: TEST_SCOPE }),
        ),
      ).toBe(200);
    });
    expect(await periodOf(ws)).toMatchObject({ status: "invoiced" });
    expect(t.logs.some((line) => line.event === "stripe_invoice_foreign")).toBe(true);
  });

  test("an event naming another workspace than its invoice's changes neither", async () => {
    const { ws, invoiceId } = await charged();
    const other = await billedTeam();
    await withBilling("on", async () => {
      t.payments.failInvoice(invoiceId);
      const marks = { ...t.payments.invoices.get(invoiceId)!.metadata };
      expect(
        await deliver(
          invoiceEvent("invoice.payment_failed", invoiceId, {
            ...marks,
            ponzu_workspace_id: other.id,
          }),
        ),
      ).toBe(200);
    });
    expect(await periodOf(ws)).toMatchObject({ status: "invoiced" });
    expect((await getWorkspace(t.db, ws.id))!.pastDueAt).toBeNull();
    expect((await getWorkspace(t.db, other.id))!.pastDueAt).toBeNull();
  });

  test("paid stored by a job that stopped before clearing past due: the retry clears it", async () => {
    const { ws, invoiceId } = await charged();
    await withBilling("on", async () => {
      t.payments.failInvoice(invoiceId);
      await deliver(invoiceEvent("invoice.payment_failed", invoiceId));
    });
    expect((await getWorkspace(t.db, ws.id))!.pastDueAt).not.toBeNull();
    // The first try stored `paid`, then died before it cleared past due.
    t.payments.payInvoice(invoiceId);
    await applyInvoiceState(t.db, {
      workspaceId: ws.id,
      stripeInvoiceId: invoiceId,
      status: "paid",
      attempts: 2,
      nextAttemptAt: null,
      invoiceNumber: null,
      hostedInvoiceUrl: null,
      taxCents: 0,
      totalCents: 10_000,
      at: new Date(t.clock.now()),
    });
    await withBilling("on", () => deliver(invoiceEvent("invoice.paid", invoiceId)));
    expect(await getWorkspace(t.db, ws.id)).toMatchObject({ pastDueAt: null, billingGate: "ok" });
  });
});

describe("the cron, across a period's end", () => {
  test("it works out the next close, records one close ten minutes after, and moves on", async () => {
    // Anchored on the 2nd: its period ends on January 2.
    const ws = await team(2);
    await addCard(ws);
    await used(ws, 400, new Date("2025-12-20T10:00:00Z"));
    // Nothing in it and no card: moved past with no row.
    const idle = await team(2);
    const jan2 = new Date("2026-01-02T00:00:00Z");
    const feb2 = new Date("2026-02-02T00:00:00Z");
    const minute = async () => {
      const ran = await t.app.request("/v1/cron/minute", {
        headers: { authorization: `Bearer ${TEST_CRON_SECRET}` },
      });
      expect(ran.status).toBe(200);
      await t.backgroundDone();
      return ((await ran.json()) as { steps: Record<string, Record<string, number>> }).steps;
    };
    await withBilling("on", async () => {
      const first = await minute();
      expect(first.close_periods!.scheduled).toBeGreaterThanOrEqual(2);
      expect((await getWorkspace(t.db, ws.id))!.billingNextCloseAt).toEqual(jan2);

      // Five minutes past the end: not yet.
      t.clock.advance(jan2.getTime() + 5 * 60_000 - t.clock.now());
      await minute();
      expect(await periodOf(ws, new Date("2025-12-02T00:00:00Z"))).toBeNull();

      t.clock.advance(6 * 60_000);
      await minute();
      await minute();
      expect(await periodOf(ws, new Date("2025-12-02T00:00:00Z"))).toMatchObject({
        status: "invoiced",
        chargedCents: 10_000,
      });
      const closes = await rows(
        `select key, completed_at from jobs where kind = '${CLOSE_JOB}' and key like '${ws.id}:%'`,
      );
      expect(closes).toHaveLength(1);
      expect(closes[0]!.completed_at).not.toBeNull();
      expect((await getWorkspace(t.db, ws.id))!.billingNextCloseAt).toEqual(feb2);
      expect(invoicesOf(ws)).toHaveLength(1);

      expect(await periodOf(idle, new Date("2025-12-02T00:00:00Z"))).toBeNull();
      expect((await getWorkspace(t.db, idle.id))!.billingNextCloseAt).toEqual(feb2);
    });
  });

  test("seven days unpaid makes the gate payment_failed, and paid opens it again", async () => {
    const ws = await billedTeam();
    // Its card is fine and its cap is high: only the unpaid invoice can close the gate.
    await t.db.execute(`update workspaces set monthly_cap_cents = 1000000 where id = '${ws.id}'`);
    await withBilling("on", () => closePeriod(t.deps, december(ws)));
    const invoiceId = invoicesOf(ws)[0]!.id;
    await withBilling("on", async () => {
      t.payments.failInvoice(invoiceId);
      await deliver(invoiceEvent("invoice.payment_failed", invoiceId));
      expect((await getWorkspace(t.db, ws.id))!.billingGate).toBe("ok");

      // A moment short of seven days: still ok, nothing awake.
      t.clock.advance(GRACE_MS - 60_000);
      await refreshBillingGates(t.deps, new Date(t.clock.now()));
      expect((await getWorkspace(t.db, ws.id))!.billingGate).toBe("ok");
      t.clock.advance(60_000);
      await refreshBillingGates(t.deps, new Date(t.clock.now()));
      expect((await getWorkspace(t.db, ws.id))!.billingGate).toBe("payment_failed");

      t.payments.payInvoice(invoiceId);
      await deliver(invoiceEvent("invoice.paid", invoiceId));
    });
    expect(await getWorkspace(t.db, ws.id)).toMatchObject({
      billingGate: "ok",
      pastDueAt: null,
    });
  });
});
