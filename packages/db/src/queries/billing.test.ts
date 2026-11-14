import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { seedUser, seedWorkspace } from "../fixtures.ts";
import { workspaces } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { getWorkspace } from "./accounts.ts";
import {
  applyInvoiceState,
  beginCardSetup,
  beginPeriodClose,
  clearCard,
  clearPastDueIfSettled,
  dueClosings,
  type InvoiceStateUpdate,
  listUnscheduledClosings,
  type PeriodNumbers,
  periodHasActivity,
  readCardSetup,
  scheduleClosings,
  setBillingGate,
  setCard,
  setCardSetupSession,
  setCustomer,
  setNextClose,
  setPastDue,
  setPeriodInvoice,
  settleCardSetup,
  settleUncharged,
  workspaceForStripe,
} from "./billing.ts";
import { run } from "./run.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

const now = new Date("2026-11-13T12:00:00Z");
const later = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

describe("a new workspace, before billing touches it", () => {
  test("has an ok gate, no card, nothing past due and no close planned", async () => {
    const workspace = await seedWorkspace(db, "fresh");
    expect(await getWorkspace(db, workspace.id)).toMatchObject({
      billingGate: "ok",
      billingGateAt: null,
      billingNextCloseAt: null,
      stripeCustomerId: null,
      stripePaymentMethodId: null,
      cardBrand: null,
      cardLast4: null,
      cardAddedAt: null,
      cardAddedByUserId: null,
      pastDueAt: null,
      pastDueReason: null,
      pastDueInvoiceUrl: null,
    });
  });

  test("refuses a gate or a past-due reason it does not know", async () => {
    const workspace = await seedWorkspace(db, "strict");
    const set = (column: string, value: string) =>
      run(
        db.execute(
          sql`update workspaces set ${sql.identifier(column)} = ${value} where id = ${workspace.id}`,
        ),
      );
    await expect(set("billing_gate", "closed")).rejects.toThrow("workspaces_billing_gate_check");
    await expect(set("past_due_reason", "late")).rejects.toThrow(
      "workspaces_past_due_reason_check",
    );
  });
});

describe("the customer", () => {
  test("the first id stored wins, and a later one is told the winner's", async () => {
    const workspace = await seedWorkspace(db, "customer");
    expect(await setCustomer(db, { workspaceId: workspace.id, customerId: "cus_first" })).toEqual({
      customerId: "cus_first",
      stored: true,
    });
    expect(await setCustomer(db, { workspaceId: workspace.id, customerId: "cus_second" })).toEqual({
      customerId: "cus_first",
      stored: false,
    });
    expect(await setCustomer(db, { workspaceId: "ws_nothing", customerId: "cus_x" })).toBeNull();
  });

  test("two first stores at once keep one", async () => {
    const workspace = await seedWorkspace(db, "racing");
    const answers = await Promise.all(
      ["cus_a", "cus_b", "cus_c"].map((customerId) =>
        setCustomer(db, { workspaceId: workspace.id, customerId }),
      ),
    );
    const winners = answers.filter((answer) => answer?.stored);
    expect(winners).toHaveLength(1);
    expect(new Set(answers.map((answer) => answer?.customerId))).toEqual(
      new Set([winners[0]!.customerId]),
    );
  });
});

describe("the card", () => {
  test("is recorded, kept as first added when told again, and forgotten only as named", async () => {
    const workspace = await seedWorkspace(db, "cards");
    const admin = await seedUser(db, "maya");
    expect(
      await setCard(db, {
        workspaceId: workspace.id,
        paymentMethodId: "pm_1",
        brand: "visa",
        last4: "4242",
        addedByUserId: admin.id,
        at: now,
      }),
    ).toBe(true);
    // The webhook tells the same card again later, with nobody behind it.
    await setCard(db, {
      workspaceId: workspace.id,
      paymentMethodId: "pm_1",
      brand: "visa",
      last4: "4242",
      addedByUserId: null,
      at: later(5),
    });
    expect(await getWorkspace(db, workspace.id)).toMatchObject({
      stripePaymentMethodId: "pm_1",
      cardBrand: "visa",
      cardLast4: "4242",
      cardAddedAt: now,
      cardAddedByUserId: admin.id,
    });

    // A late word about another card leaves this one alone.
    expect(await clearCard(db, { workspaceId: workspace.id, paymentMethodId: "pm_old" })).toBe(
      false,
    );
    expect(await clearCard(db, { workspaceId: workspace.id, paymentMethodId: "pm_1" })).toBe(true);
    expect(await getWorkspace(db, workspace.id)).toMatchObject({
      stripePaymentMethodId: null,
      cardBrand: null,
      cardLast4: null,
      cardAddedAt: null,
      cardAddedByUserId: null,
    });
    expect(await clearCard(db, { workspaceId: workspace.id })).toBe(false);
  });

  test("a new card counts as added when it was", async () => {
    const workspace = await seedWorkspace(db, "newcard");
    await setCard(db, {
      workspaceId: workspace.id,
      paymentMethodId: "pm_1",
      brand: "visa",
      last4: "4242",
      addedByUserId: null,
      at: now,
    });
    await setCard(db, {
      workspaceId: workspace.id,
      paymentMethodId: "pm_2",
      brand: "amex",
      last4: "0005",
      addedByUserId: null,
      at: later(60),
    });
    expect(await getWorkspace(db, workspace.id)).toMatchObject({
      stripePaymentMethodId: "pm_2",
      cardBrand: "amex",
      cardAddedAt: later(60),
    });
  });

  test("given the card it read, a late answer never replaces a card stored meanwhile", async () => {
    const workspace = await seedWorkspace(db, "ifcard");
    const card = (paymentMethodId: string, ifPaymentMethodId: string | null) =>
      setCard(db, {
        workspaceId: workspace.id,
        paymentMethodId,
        brand: "visa",
        last4: "4242",
        addedByUserId: null,
        at: now,
        ifPaymentMethodId,
      });
    expect(await card("pm_a", null)).toBe(true);
    // Read with no card, answered after pm_a landed: left alone.
    expect(await card("pm_stale", null)).toBe(false);
    expect(await card("pm_b", "pm_other")).toBe(false);
    expect(await card("pm_b", "pm_a")).toBe(true);
    expect((await getWorkspace(db, workspace.id))!.stripePaymentMethodId).toBe("pm_b");
  });
});

describe("which workspace a Stripe object is about", () => {
  test("by its customer first, else by the card stored, else none", async () => {
    const first = await seedWorkspace(db, "stripe-a");
    const second = await seedWorkspace(db, "stripe-b");
    await setCustomer(db, { workspaceId: first.id, customerId: "cus_match_a" });
    await setCard(db, {
      workspaceId: second.id,
      paymentMethodId: "pm_match_b",
      brand: "visa",
      last4: "4242",
      addedByUserId: null,
      at: now,
    });
    const of = (customerId: string | null, paymentMethodId: string | null) =>
      workspaceForStripe(db, { customerId, paymentMethodId });
    expect(await of("cus_match_a", null)).toBe(first.id);
    expect(await of(null, "pm_match_b")).toBe(second.id);
    expect(await of("cus_match_a", "pm_match_b")).toBe(first.id);
    expect(await of("cus_elsewhere", "pm_elsewhere")).toBeNull();
    expect(await of(null, null)).toBeNull();
  });
});

test("the gate answers what it was and what it is", async () => {
  const workspace = await seedWorkspace(db, "gate");
  expect(
    await setBillingGate(db, { workspaceId: workspace.id, gate: "free_used", at: now }),
  ).toEqual({ before: "ok", after: "free_used" });
  expect(
    await setBillingGate(db, { workspaceId: workspace.id, gate: "free_used", at: later(1) }),
  ).toEqual({ before: "free_used", after: "free_used" });
  expect(await getWorkspace(db, workspace.id)).toMatchObject({
    billingGate: "free_used",
    billingGateAt: later(1),
  });
  expect(await setBillingGate(db, { workspaceId: "ws_nothing", gate: "ok", at: now })).toBeNull();
});

describe("card setups", () => {
  test("one is open a workspace at a time: a new one replaces the old", async () => {
    const workspace = await seedWorkspace(db, "setups");
    const admin = await seedUser(db, "ines");
    const begin = (minutes: number) =>
      beginCardSetup(db, {
        userId: admin.id,
        workspaceId: workspace.id,
        capCents: 10_000,
        scheme: "ponzu",
        now: later(minutes),
        expiresAt: later(minutes + 35),
      });
    const first = await begin(0);
    expect(first).toEqual({ id: expect.stringMatching(/^auth_/), replaced: [] });
    const second = await begin(1);
    expect(second!.replaced).toEqual([first!.id]);

    // The replaced one still records its page (it is open in a browser), once.
    expect(await setCardSetupSession(db, { id: first!.id, sessionId: "cs_old" })).toBe(true);
    expect(await setCardSetupSession(db, { id: first!.id, sessionId: "cs_other" })).toBe(false);
    expect((await readCardSetup(db, { id: first!.id }))!.payload.checkoutSessionId).toBe("cs_old");
    expect(await setCardSetupSession(db, { id: second!.id, sessionId: "cs_new" })).toBe(true);
    expect(await readCardSetup(db, { id: second!.id, userId: admin.id })).toEqual({
      id: second!.id,
      userId: admin.id,
      payload: {
        workspaceId: workspace.id,
        capCents: 10_000,
        scheme: "ponzu",
        checkoutSessionId: "cs_new",
        outcome: null,
        settledAt: null,
      },
      expiresAt: later(36),
      consumedAt: null,
      createdAt: later(1),
    });
    // Only its starter reads it that way.
    expect(await readCardSetup(db, { id: second!.id, userId: "usr_someone" })).toBeNull();

    // The database itself holds the one open setup.
    await expect(
      run(
        db.execute(sql`
          insert into auth_states (id, kind, user_id, payload, expires_at)
          values ('auth_dupe', 'card_setup', ${admin.id},
                  ${JSON.stringify({ workspaceId: workspace.id })}::jsonb, now())`),
      ),
    ).rejects.toThrow("auth_states_open_card_setup_key");
  });

  test("another workspace's setup is its own", async () => {
    const one = await seedWorkspace(db, "one");
    const two = await seedWorkspace(db, "two");
    const admin = await seedUser(db, "lea");
    const open = (workspaceId: string) =>
      beginCardSetup(db, {
        userId: admin.id,
        workspaceId,
        capCents: 500,
        scheme: "ponzu-dev",
        now,
        expiresAt: later(35),
      });
    await open(one.id);
    expect((await open(two.id))!.replaced).toEqual([]);
  });

  test("settles once, whichever comes first", async () => {
    const workspace = await seedWorkspace(db, "settle");
    const admin = await seedUser(db, "tom");
    const setup = await beginCardSetup(db, {
      userId: admin.id,
      workspaceId: workspace.id,
      capCents: 10_000,
      scheme: "none",
      now,
      expiresAt: later(35),
    });
    const first = await settleCardSetup(db, { id: setup!.id, outcome: "added", at: later(2) });
    expect(first).toMatchObject({
      settled: true,
      setup: {
        consumedAt: later(2),
        payload: { outcome: "added", settledAt: later(2).toISOString() },
      },
    });
    const again = await settleCardSetup(db, { id: setup!.id, outcome: "cancelled", at: later(3) });
    expect(again).toMatchObject({
      settled: false,
      setup: { consumedAt: later(2), payload: { outcome: "added" } },
    });
    expect(await settleCardSetup(db, { id: "auth_nothing", outcome: "added", at: now })).toBeNull();
  });

  test("a card Stripe finished after the setup was cancelled turns it added, and only then", async () => {
    const workspace = await seedWorkspace(db, "late-card");
    const admin = await seedUser(db, "ana");
    const setup = await beginCardSetup(db, {
      userId: admin.id,
      workspaceId: workspace.id,
      capCents: 10_000,
      scheme: "none",
      now,
      expiresAt: later(35),
    });
    await settleCardSetup(db, { id: setup!.id, outcome: "cancelled", at: later(1) });
    expect(
      await settleCardSetup(db, { id: setup!.id, outcome: "expired", at: later(2) }),
    ).toMatchObject({ settled: false, setup: { payload: { outcome: "cancelled" } } });
    expect(
      await settleCardSetup(db, { id: setup!.id, outcome: "added", at: later(3) }),
    ).toMatchObject({
      settled: true,
      setup: {
        consumedAt: later(1),
        payload: { outcome: "added", settledAt: later(3).toISOString() },
      },
    });
    expect(
      await settleCardSetup(db, { id: setup!.id, outcome: "added", at: later(4) }),
    ).toMatchObject({ settled: false, setup: { payload: { settledAt: later(3).toISOString() } } });
  });
});

describe("the period close", () => {
  const numbers = (workspaceId: string, start: Date, end: Date): PeriodNumbers => ({
    workspaceId,
    periodStart: start,
    periodEnd: end,
    usedCredits: 900,
    freeCredits: 500,
    billedCredits: 400,
    chargedCredits: 400,
    chargedCents: 4_000,
    capCents: 10_000,
    people: 5,
    rateCardVersion: 1,
  });
  const start = new Date("2026-10-13T00:00:00Z");
  const end = new Date("2026-11-13T00:00:00Z");

  test("finds the workspaces whose close is due, longest due first", async () => {
    const early = await seedWorkspace(db, "early");
    const late = await seedWorkspace(db, "late");
    const notYet = await seedWorkspace(db, "notyet");
    await setNextClose(db, { workspaceId: late.id, at: later(-10) });
    await setNextClose(db, { workspaceId: early.id, at: later(-60) });
    await setNextClose(db, { workspaceId: notYet.id, at: later(60) });
    const due = await dueClosings(db, { before: now, limit: 10 });
    const ours = due.filter((row) => [early.id, late.id, notYet.id].includes(row.workspaceId));
    expect(ours.map((row) => row.workspaceId)).toEqual([early.id, late.id]);
    expect(ours[0]!.nextCloseAt).toEqual(later(-60));
  });

  test("freezes a period's numbers once, and keeps them on a second close", async () => {
    const workspace = await seedWorkspace(db, "close");
    const first = await beginPeriodClose(db, {
      ...numbers(workspace.id, start, end),
      at: now,
      status: "closing",
    });
    expect(first).toMatchObject({
      created: true,
      period: { status: "closing", chargedCents: 4_000, closedAt: now, stripeInvoiceId: null },
    });
    const second = await beginPeriodClose(db, {
      ...numbers(workspace.id, start, end),
      chargedCredits: 1,
      chargedCents: 10,
      at: later(5),
      status: "closing",
    });
    expect(second).toMatchObject({
      created: false,
      period: { chargedCents: 4_000, closedAt: now },
    });
  });

  test("a period frozen unbilled stays unbilled when a later close asks to settle it", async () => {
    const workspace = await seedWorkspace(db, "frozen-unbilled");
    const first = await beginPeriodClose(db, {
      ...numbers(workspace.id, start, end),
      at: now,
      status: "unbilled",
    });
    expect(first).toMatchObject({ created: true, period: { status: "unbilled" } });
    const second = await beginPeriodClose(db, {
      ...numbers(workspace.id, start, end),
      at: later(5),
      status: "closing",
    });
    expect(second).toMatchObject({ created: false, period: { status: "unbilled" } });
  });

  test("stores one invoice a period, never a second", async () => {
    const workspace = await seedWorkspace(db, "invoice");
    await beginPeriodClose(db, {
      ...numbers(workspace.id, start, end),
      at: now,
      status: "closing",
    });
    const key = { workspaceId: workspace.id, periodStart: start };
    expect(await setPeriodInvoice(db, { ...key, stripeInvoiceId: "in_1", at: now })).toBe(true);
    expect(await setPeriodInvoice(db, { ...key, stripeInvoiceId: "in_1", at: now })).toBe(true);
    expect(await setPeriodInvoice(db, { ...key, stripeInvoiceId: "in_2", at: now })).toBe(false);
  });

  test("refuses numbers that cannot be, and an invoiced status without its invoice", async () => {
    const workspace = await seedWorkspace(db, "rules");
    const insert = (overrides: Record<string, unknown>) =>
      run(
        db.execute(sql`
          insert into billing_periods (workspace_id, period_start, period_end, status, used_credits,
            free_credits, billed_credits, charged_credits, charged_cents, cap_cents, people,
            rate_card_version, stripe_invoice_id)
          values (${workspace.id}, ${(overrides.start as string) ?? start.toISOString()},
            ${(overrides.end as string) ?? end.toISOString()}, ${(overrides.status as string) ?? "closing"},
            900, 500, 400, ${(overrides.charged as number) ?? 400},
            ${(overrides.cents as number) ?? 4000}, ${(overrides.cap as number) ?? 10000}, 5, 1,
            ${(overrides.invoice as string | null) ?? null})`),
      );
    await expect(insert({ charged: 401 })).rejects.toThrow("billing_periods_numbers_check");
    await expect(insert({ cents: 10_001 })).rejects.toThrow("billing_periods_numbers_check");
    await expect(insert({ end: start.toISOString() })).rejects.toThrow(
      "billing_periods_span_check",
    );
    await expect(insert({ status: "invoiced" })).rejects.toThrow("billing_periods_invoice_check");
    await expect(insert({ status: "billed" })).rejects.toThrow("billing_periods_status_check");
    await insert({ status: "invoiced", invoice: "in_ok" });
    // A workspace with a closed period keeps it: it cannot be deleted from under its history.
    await expect(run(db.delete(workspaces).where(eq(workspaces.id, workspace.id)))).rejects.toThrow(
      "billing_periods_workspace_id_workspaces_id_fk",
    );
  });

  test("a close under way, or one failed for good within the day, leaves the workspace out", async () => {
    const waiting = await seedWorkspace(db, "waiting");
    const failed = await seedWorkspace(db, "failedclose");
    const failedLongAgo = await seedWorkspace(db, "failedlong");
    const free = await seedWorkspace(db, "freeclose");
    const ids = [waiting.id, failed.id, failedLongAgo.id, free.id];
    for (const id of ids) await setNextClose(db, { workspaceId: id, at: later(-30) });
    const job = (workspaceId: string, extra: string) =>
      run(
        db.execute(
          sql.raw(`
          insert into jobs (id, kind, key, attempts, max_attempts ${extra ? ", failed_at" : ""})
          values ('job_${workspaceId}', 'billing_close', '${workspaceId}:2026-10-13T00:00:00.000Z',
                  1, 8 ${extra})`),
        ),
      );
    await job(waiting.id, "");
    await job(failed.id, `, '${later(-60).toISOString()}'`);
    await job(failedLongAgo.id, `, '${later(-2 * 24 * 60).toISOString()}'`);
    const due = await dueClosings(db, {
      before: now,
      limit: 50,
      jobKind: "billing_close",
      failedSince: later(-24 * 60),
    });
    expect(
      due
        .map((row) => row.workspaceId)
        .filter((id) => ids.includes(id))
        .sort(),
    ).toEqual([failedLongAgo.id, free.id].sort());
  });

  test("works out next closes only where there are none, and moves one only from where it was", async () => {
    const fresh = await seedWorkspace(db, "fresh");
    const set = await seedWorkspace(db, "alreadyset");
    await setNextClose(db, { workspaceId: set.id, at: later(10) });
    const unscheduled = await listUnscheduledClosings(db, { limit: 1_000 });
    expect(unscheduled.map((row) => row.workspaceId)).toContain(fresh.id);
    expect(unscheduled.map((row) => row.workspaceId)).not.toContain(set.id);
    expect(
      await scheduleClosings(db, [
        { workspaceId: fresh.id, at: later(20) },
        { workspaceId: set.id, at: later(30) },
      ]),
    ).toBe(1);
    expect((await getWorkspace(db, fresh.id))!.billingNextCloseAt).toEqual(later(20));
    expect((await getWorkspace(db, set.id))!.billingNextCloseAt).toEqual(later(10));
    expect(await setNextClose(db, { workspaceId: set.id, at: later(40), ifAt: later(11) })).toBe(
      false,
    );
    expect(await setNextClose(db, { workspaceId: set.id, at: later(40), ifAt: later(10) })).toBe(
      true,
    );
  });

  test("a period has activity with a usage event in it, or a card; not with use outside it", async () => {
    const quiet = await seedWorkspace(db, "quiet");
    await run(
      db.execute(sql`
        insert into usage_events (id, workspace_id, kind, seconds, payer, rate_card_version, occurred_at)
        values ('quiet-before', ${quiet.id}, 'sandbox', 3600, 'ponzu', 1, ${start.toISOString()}::timestamptz - interval '1 second')`),
    );
    expect(await periodHasActivity(db, { workspaceId: quiet.id, start, end })).toBe(false);
    await run(
      db.execute(sql`
        insert into usage_events (id, workspace_id, kind, seconds, payer, rate_card_version, occurred_at)
        values ('quiet-in', ${quiet.id}, 'sandbox', 3600, 'ponzu', 1, ${start.toISOString()}::timestamptz)`),
    );
    expect(await periodHasActivity(db, { workspaceId: quiet.id, start, end })).toBe(true);
    const carded = await seedWorkspace(db, "carded");
    await setCard(db, {
      workspaceId: carded.id,
      paymentMethodId: "pm_activity",
      brand: "visa",
      last4: "4242",
      addedByUserId: null,
      at: now,
    });
    expect(await periodHasActivity(db, { workspaceId: carded.id, start, end })).toBe(true);
  });

  test("charged nothing settles only a closing period with no invoice", async () => {
    const workspace = await seedWorkspace(db, "uncharged");
    await beginPeriodClose(db, {
      ...numbers(workspace.id, start, end),
      at: now,
      status: "closing",
    });
    const key = { workspaceId: workspace.id, periodStart: start, at: now };
    expect(await settleUncharged(db, { ...key, status: "waived" })).toMatchObject({
      status: "waived",
    });
    expect(await settleUncharged(db, { ...key, status: "unbilled" })).toMatchObject({
      status: "waived",
    });
    const charging = await seedWorkspace(db, "charging");
    await beginPeriodClose(db, { ...numbers(charging.id, start, end), at: now, status: "closing" });
    await setPeriodInvoice(db, {
      workspaceId: charging.id,
      periodStart: start,
      stripeInvoiceId: "in_charging",
      at: now,
    });
    expect(
      await settleUncharged(db, { ...key, workspaceId: charging.id, status: "unbilled" }),
    ).toMatchObject({ status: "closing", stripeInvoiceId: "in_charging" });
  });

  test("an invoice's state moves its period forward only, and a first failure is said once", async () => {
    const workspace = await seedWorkspace(db, "invoicestate");
    await beginPeriodClose(db, {
      ...numbers(workspace.id, start, end),
      at: now,
      status: "closing",
    });
    await setPeriodInvoice(db, {
      workspaceId: workspace.id,
      periodStart: start,
      stripeInvoiceId: "in_state",
      at: now,
    });
    const apply = (status: InvoiceStateUpdate["status"], attempts: number) =>
      applyInvoiceState(db, {
        workspaceId: workspace.id,
        stripeInvoiceId: "in_state",
        status,
        attempts,
        nextAttemptAt: later(60),
        invoiceNumber: "PONZU-1",
        hostedInvoiceUrl: "https://invoice.example/in_state",
        taxCents: 0,
        totalCents: 4_000,
        at: now,
      });
    expect(await apply("invoiced", 0)).toMatchObject({ before: "closing", after: "invoiced" });
    expect(await apply("payment_failed", 1)).toMatchObject({
      after: "payment_failed",
      firstFailure: true,
    });
    expect(await apply("payment_failed", 2)).toMatchObject({ firstFailure: false, attempts: 2 });
    expect(await apply("invoiced", 0)).toMatchObject({ after: "payment_failed", attempts: 2 });
    expect(await apply("uncollectible", 3)).toMatchObject({ after: "uncollectible" });
    expect(await apply("payment_failed", 3)).toMatchObject({ after: "uncollectible" });
    expect(await apply("paid", 4)).toMatchObject({ after: "paid" });
    expect(await apply("void", 4)).toMatchObject({ after: "paid" });
  });

  test("past due is kept from the first time, and cleared once nothing is unpaid", async () => {
    const workspace = await seedWorkspace(db, "pastdue");
    const second = new Date("2026-11-13T00:00:00Z");
    const third = new Date("2026-12-13T00:00:00Z");
    for (const [from, to, invoice] of [
      [start, end, "in_pd1"],
      [second, third, "in_pd2"],
    ] as const) {
      await beginPeriodClose(db, {
        ...numbers(workspace.id, from, to),
        at: now,
        status: "closing",
      });
      await setPeriodInvoice(db, {
        workspaceId: workspace.id,
        periodStart: from,
        stripeInvoiceId: invoice,
        at: now,
      });
    }
    const fail = (invoice: string) =>
      applyInvoiceState(db, {
        workspaceId: workspace.id,
        stripeInvoiceId: invoice,
        status: "payment_failed",
        attempts: 1,
        nextAttemptAt: null,
        invoiceNumber: null,
        hostedInvoiceUrl: `https://invoice.example/${invoice}`,
        taxCents: 0,
        totalCents: 4_000,
        at: now,
      });
    await fail("in_pd1");
    await fail("in_pd2");
    await setPastDue(db, {
      workspaceId: workspace.id,
      reason: "failed",
      invoiceUrl: "https://invoice.example/in_pd1",
      at: now,
    });
    await setPastDue(db, {
      workspaceId: workspace.id,
      reason: "needs_confirmation",
      invoiceUrl: "https://invoice.example/in_pd2",
      at: later(60),
    });
    expect(await getWorkspace(db, workspace.id)).toMatchObject({
      pastDueAt: now,
      pastDueReason: "needs_confirmation",
    });
    await run(
      db.execute(
        sql`update billing_periods set status = 'paid' where stripe_invoice_id = 'in_pd1'`,
      ),
    );
    expect(await clearPastDueIfSettled(db, { workspaceId: workspace.id })).toBe(false);
    expect(await getWorkspace(db, workspace.id)).toMatchObject({
      pastDueAt: now,
      pastDueInvoiceUrl: "https://invoice.example/in_pd2",
    });
    await run(
      db.execute(
        sql`update billing_periods set status = 'void' where stripe_invoice_id = 'in_pd2'`,
      ),
    );
    expect(await clearPastDueIfSettled(db, { workspaceId: workspace.id })).toBe(true);
    expect(await getWorkspace(db, workspace.id)).toMatchObject({
      pastDueAt: null,
      pastDueReason: null,
      pastDueInvoiceUrl: null,
    });
  });
});
