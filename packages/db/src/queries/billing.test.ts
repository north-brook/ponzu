import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { seedUser, seedWorkspace } from "../fixtures.ts";
import { workspaces } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { getWorkspace } from "./accounts.ts";
import {
  beginCardSetup,
  beginPeriodClose,
  clearCard,
  dueClosings,
  type PeriodNumbers,
  readCardSetup,
  setBillingGate,
  setCard,
  setCardSetupSession,
  setCustomer,
  setNextClose,
  setPeriodInvoice,
  settleCardSetup,
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

    expect(await setCardSetupSession(db, { id: first!.id, sessionId: "cs_old" })).toBe(false);
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
    const first = await beginPeriodClose(db, { ...numbers(workspace.id, start, end), at: now });
    expect(first).toMatchObject({
      created: true,
      period: { status: "closing", chargedCents: 4_000, closedAt: now, stripeInvoiceId: null },
    });
    const second = await beginPeriodClose(db, {
      ...numbers(workspace.id, start, end),
      chargedCredits: 1,
      chargedCents: 10,
      at: later(5),
    });
    expect(second).toMatchObject({
      created: false,
      period: { chargedCents: 4_000, closedAt: now },
    });
  });

  test("stores one invoice a period, never a second", async () => {
    const workspace = await seedWorkspace(db, "invoice");
    await beginPeriodClose(db, { ...numbers(workspace.id, start, end), at: now });
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
});
