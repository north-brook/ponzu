// Billing off changes nothing (docs/cloud.md, "Billing"): with PONZU_BILLING unset, as in
// production today, the routes that read or touch billing answer as before, the minute's cron
// runs, and still nothing asks Stripe and nothing writes a column or row billing added.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { authStates, billingPeriods, getWorkspace } from "@ponzu/db";
import { call, workspaceWithRepo } from "../testing/canvases.ts";
import { createTestApp, TEST_CRON_SECRET, type TestApp } from "../testing/index.ts";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

test("billing is off unless something sets it, and Stripe is off with it", () => {
  expect(t.deps.features.billing).toBe("off");
  expect(t.deps.payments.enabled).toBe(false);
});

test("with billing off, nothing asks Stripe and nothing billing added is written", async () => {
  const team = await workspaceWithRepo(t, { maya: "admin", ines: "write" });
  const admin = team.people.maya!.headers;
  const member = team.people.ines!.headers;

  expect((await call(t, admin, "GET", "/v1/me")).status).toBe(200);
  for (const headers of [admin, member]) {
    const usage = await call(t, headers, "GET", `/v1/workspaces/${team.id}/usage`);
    expect(usage.status).toBe(200);
    // As main answers it: no Stripe, nothing billed.
    expect(usage.body.billing).toEqual({
      status: "not_set_up",
      card: null,
      invoices: "not_set_up",
    });
  }
  const capped = await call(t, admin, "PATCH", `/v1/workspaces/${team.id}/billing`, {
    capUsd: 250,
  });
  expect(capped.status).toBe(200);
  const cron = await t.app.request("/v1/cron/minute", {
    headers: { authorization: `Bearer ${TEST_CRON_SECRET}` },
  });
  expect(cron.status).toBe(200);
  await t.backgroundDone();

  expect(t.payments.calls).toEqual([]);
  expect(await getWorkspace(t.db, team.id)).toMatchObject({
    // The cap is main's column, and is set as before.
    monthlyCapCents: 25_000,
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
  expect(await t.db.select().from(billingPeriods)).toEqual([]);
  const states = await t.db.select({ kind: authStates.kind }).from(authStates);
  expect(states.filter((state) => state.kind === "card_setup")).toEqual([]);
});
