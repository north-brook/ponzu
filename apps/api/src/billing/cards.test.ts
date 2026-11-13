import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getWorkspace, readCardSetup, usageEvents } from "@ponzu/db";
import { PaymentsError } from "../deps/payments.ts";
import { call, type Workspace, workspaceWithRepo } from "../testing/canvases.ts";
import { createTestApp, TEST_SCOPE, type TestApp } from "../testing/index.ts";
import { CARD_SETUP_LIFETIME_MS, POLL_ASKS_STRIPE_AFTER_MS } from "./cards.ts";
import { STRIPE_WEBHOOK_JOB } from "./webhook.ts";

/*
 * Cards, end to end on FakePayments (docs/cloud.md, "Billing", "Cards" and "Webhooks"): an
 * admin starts a setup, Stripe's part is acted by the fake, and the setup is settled by the
 * signed webhook, the return page or the app's poll, whichever comes first. The app starts with
 * billing off, as production runs today; each test switches the mode it needs.
 */

let t: TestApp;
let n = 0;

beforeAll(async () => {
  t = await createTestApp();
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

const admin = (ws: Workspace) => ws.people.maya!.headers;
const member = (ws: Workspace) => ws.people.ines!.headers;

/** A team of Maya (an admin) and Ines (a member). */
const team = () => workspaceWithRepo(t, { maya: "admin", ines: "write" });

const start = (ws: Workspace, body: Record<string, unknown> = { capUsd: 150 }) =>
  call(t, admin(ws), "POST", `/v1/workspaces/${ws.id}/billing/card-setups`, body);

const poll = (ws: Workspace, id: string, headers = admin(ws)) =>
  call(t, headers, "GET", `/v1/billing/card-setups/${id}`);

/** The Checkout session the fake made for a setup. */
function sessionOf(setupId: string) {
  const session = [...t.payments.sessions.values()].find((s) => s.setupId === setupId);
  if (!session) throw new Error(`No Checkout session for ${setupId}`);
  return session;
}

async function deliver(event: {
  id?: string;
  type: string;
  object: Record<string, unknown>;
  previousAttributes?: Record<string, unknown>;
  livemode?: boolean;
}) {
  const { body, signature } = await t.payments.webhookFor(event);
  const response = await t.app.request("/v1/stripe/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": signature },
    body,
  });
  await t.backgroundDone();
  return { status: response.status, body: await response.json().catch(() => null) };
}

/** Checkout's own event for a session, carrying the marks the seam put on it. */
function checkoutEvent(type: string, setupId: string, workspaceId: string, id?: string) {
  const session = sessionOf(setupId);
  return {
    ...(id ? { id } : {}),
    type,
    object: {
      id: session.id,
      object: "checkout.session",
      mode: "setup",
      customer: session.customerId,
      metadata: {
        ponzu_setup_id: setupId,
        ponzu_workspace_id: workspaceId,
        ponzu_scope: TEST_SCOPE,
      },
    },
  };
}

async function back(query: string) {
  const response = await t.app.request(`/v1/billing/return?${query}`);
  return { status: response.status, html: await response.text(), headers: response.headers };
}

const stripeJobs = () =>
  rows(`select id, completed_at from jobs where kind = '${STRIPE_WEBHOOK_JOB}'`);

describe("with billing off, as production runs today", () => {
  test("every card route refuses before reading anything, and nothing asks Stripe or is written", async () => {
    const ws = await team();
    const jobsBefore = (await stripeJobs()).length;
    for (const mode of ["off", "observe"] as const) {
      await withBilling(mode, async () => {
        expect((await start(ws)).status).toBe(409);
        expect((await start(ws)).body.error.code).toBe("billing_not_set_up");
        expect((await poll(ws, "auth_nothing")).status).toBe(409);
        const portal = await call(t, admin(ws), "POST", `/v1/workspaces/${ws.id}/billing/portal`);
        expect(portal.status).toBe(409);
        expect(portal.body.error.code).toBe("billing_not_set_up");
        expect((await back("setup=auth_nothing&session_id=cs_1")).status).toBe(404);
        expect((await back("kind=portal")).status).toBe(404);
        const hook = await t.app.request("/v1/stripe/webhook", {
          method: "POST",
          headers: { "stripe-signature": "t=1,v1=00" },
          body: "{}",
        });
        expect(hook.status).toBe(404);
      });
    }
    expect(t.payments.calls).toEqual([]);
    expect((await stripeJobs()).length).toBe(jobsBefore);
    expect(await rows(`select 1 from webhook_deliveries where source = 'stripe'`)).toEqual([]);
    expect(
      await rows(
        `select 1 from auth_states where kind = 'card_setup' and payload->>'workspaceId' = '${ws.id}'`,
      ),
    ).toEqual([]);
    expect(await getWorkspace(t.db, ws.id)).toMatchObject({
      stripeCustomerId: null,
      stripePaymentMethodId: null,
      monthlyCapCents: null,
    });
  });
});

describe("with billing on", () => {
  test("a card added on Checkout settles through the signed webhook: the card, the cap and the gate", async () => {
    await withBilling("on", async () => {
      const ws = await team();
      const started = await start(ws, { capUsd: 150, scheme: "ponzu-dev", source: "wall" });
      expect(started.status).toBe(201);
      expect(started.body.url).toStartWith("https://checkout.stripe.test/");
      const id: string = started.body.id;

      const stored = await getWorkspace(t.db, ws.id);
      expect(stored!.stripeCustomerId).toStartWith("cus_");
      const customer = t.payments.customers.get(stored!.stripeCustomerId!)!;
      expect(customer.workspaceId).toBe(ws.id);
      const session = sessionOf(id);
      // Checkout comes back to the API, carrying only the setup's id; never the app's link.
      const begun = t.payments.calls.find((c) => c.method === "startCardSetup")!.args[0] as {
        successUrl: string;
        cancelUrl: string;
        expiresAt: Date;
      };
      expect(begun.successUrl).toBe(
        `${t.deps.config.sandbox.apiUrl}/v1/billing/return?setup=${id}&session_id={CHECKOUT_SESSION_ID}`,
      );
      expect(begun.cancelUrl).toBe(
        `${t.deps.config.sandbox.apiUrl}/v1/billing/return?setup=${id}&cancelled=1`,
      );
      expect(begun.expiresAt.getTime() - t.clock.now()).toBeGreaterThanOrEqual(30 * 60_000);
      expect(t.analytics.of("card setup started").at(-1)?.properties).toMatchObject({
        source: "wall",
      });

      // The app's first polls only read the row.
      const calls = t.payments.calls.length;
      expect((await poll(ws, id)).body).toEqual({ status: "waiting", workspaceId: ws.id });
      expect(t.payments.calls.length).toBe(calls);

      t.payments.completeSetup(session.id, { brand: "mastercard", last4: "4444" });
      const event = checkoutEvent("checkout.session.completed", id, ws.id, `evt_done_${n++}`);
      expect(await deliver(event)).toEqual({ status: 200, body: { received: true } });

      const after = await getWorkspace(t.db, ws.id);
      expect(after).toMatchObject({
        stripePaymentMethodId: session.paymentMethodId,
        cardBrand: "mastercard",
        cardLast4: "4444",
        cardAddedByUserId: ws.people.maya!.userId,
        monthlyCapCents: 15_000,
        billingGate: "ok",
      });
      expect(after!.billingGateAt).not.toBeNull();
      expect(customer.defaultPaymentMethod).toBe(session.paymentMethodId);
      expect((await poll(ws, id)).body).toEqual({ status: "added", workspaceId: ws.id });
      expect(t.analytics.of("card added").at(-1)?.properties).toMatchObject({
        brand: "mastercard",
        source: "wall",
      });

      // Stripe sends it again: acknowledged, and nothing more is done.
      const useCards = t.payments.count("useCard");
      const jobs = (await stripeJobs()).length;
      expect(await deliver(event)).toEqual({ status: 200, body: { received: true } });
      expect((await stripeJobs()).length).toBe(jobs);
      expect(t.payments.count("useCard")).toBe(useCards);

      // The return page, after: it opens the app the row names, whatever the address says.
      const page = await back(`setup=${id}&session_id=cs_forged&scheme=ponzu`);
      expect(page.status).toBe(200);
      expect(page.html).toContain("Card added");
      expect(page.html).toContain(
        `data-link="ponzu-dev://billing/card?setup=${id}&amp;result=added"`,
      );
      expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(t.payments.count("useCard")).toBe(useCards);
    });
  });

  test("the return page first, then the webhook, settles once", async () => {
    await withBilling("on", async () => {
      const ws = await team();
      const id: string = (await start(ws, { capUsd: 80, scheme: "ponzu" })).body.id;
      t.payments.completeSetup(sessionOf(id).id);
      const added = t.analytics.of("card added").length;

      const page = await back(`setup=${id}&session_id=${sessionOf(id).id}`);
      expect(page.html).toContain(`data-link="ponzu://billing/card?setup=${id}&amp;result=added"`);
      const useCards = t.payments.count("useCard");
      await deliver(checkoutEvent("checkout.session.completed", id, ws.id));

      expect(t.payments.count("useCard")).toBe(useCards);
      expect(t.analytics.of("card added").length).toBe(added + 1);
      expect((await getWorkspace(t.db, ws.id))!.monthlyCapCents).toBe(8_000);
      expect((await poll(ws, id)).body.status).toBe("added");
    });
  });

  test("the app's poll settles a finished page by itself after a few seconds", async () => {
    await withBilling("on", async () => {
      const ws = await team();
      const id: string = (await start(ws)).body.id;
      t.payments.completeSetup(sessionOf(id).id);
      expect((await poll(ws, id)).body.status).toBe("waiting");
      t.clock.advance(POLL_ASKS_STRIPE_AFTER_MS);
      expect((await poll(ws, id)).body.status).toBe("added");
      expect((await getWorkspace(t.db, ws.id))!.cardLast4).toBe("4242");
      // Another person's poll finds nothing.
      expect((await poll(ws, id, member(ws))).status).toBe(404);
    });
  });

  test("a page left with Cancel says no card was added, and links back with that", async () => {
    await withBilling("on", async () => {
      const ws = await team();
      const id: string = (await start(ws, { capUsd: 100, scheme: "ponzu-dev" })).body.id;
      const page = await back(`setup=${id}&cancelled=1`);
      expect(page.status).toBe(200);
      expect(page.html).toContain("No card added");
      expect(page.html).toContain(`result=cancelled`);
      expect((await poll(ws, id)).body.status).toBe("cancelled");
      expect(t.analytics.of("card setup ended").at(-1)?.properties).toMatchObject({
        outcome: "cancelled",
      });
      expect((await getWorkspace(t.db, ws.id))!.stripePaymentMethodId).toBeNull();
    });
  });

  test("a card finished after Cancel still lands, with the cap chosen with it", async () => {
    await withBilling("on", async () => {
      const ws = await team();
      const id: string = (await start(ws, { capUsd: 120, scheme: "ponzu" })).body.id;
      expect((await back(`setup=${id}&cancelled=1`)).html).toContain("No card added");
      expect((await poll(ws, id)).body.status).toBe("cancelled");
      // The admin went back to the still-open Checkout tab and finished it there.
      t.payments.completeSetup(sessionOf(id).id);
      await deliver(checkoutEvent("checkout.session.completed", id, ws.id));
      expect(await getWorkspace(t.db, ws.id)).toMatchObject({
        stripePaymentMethodId: sessionOf(id).paymentMethodId,
        monthlyCapCents: 12_000,
      });
      expect((await poll(ws, id)).body.status).toBe("added");
      const page = await back(`setup=${id}&session_id=${sessionOf(id).id}`);
      expect(page.html).toContain(`data-link="ponzu://billing/card?setup=${id}&amp;result=added"`);
    });
  });

  test("Stripe failing as the card is made the default leaves the setup waiting, not broken", async () => {
    await withBilling("on", async () => {
      const ws = await team();
      const id: string = (await start(ws)).body.id;
      t.payments.completeSetup(sessionOf(id).id);
      t.clock.advance(POLL_ASKS_STRIPE_AFTER_MS);
      t.payments.failNext(
        "useCard",
        new PaymentsError({ type: "api_error", code: null, status: 500, requestId: null }),
      );
      const fresh = (await t.signInAs({ login: "maya" })).headers;
      const down = await poll(ws, id, fresh);
      expect(down.status).toBe(200);
      expect(down.body.status).toBe("waiting");
      expect((await getWorkspace(t.db, ws.id))!.stripePaymentMethodId).toBeNull();
      // Asked again, once Stripe answers: added.
      expect((await poll(ws, id, fresh)).body.status).toBe("added");
    });
  });

  test("a build that takes no links gets a page that names none and closes", async () => {
    await withBilling("on", async () => {
      const ws = await team();
      const id: string = (await start(ws)).body.id;
      t.payments.completeSetup(sessionOf(id).id);
      const page = await back(`setup=${id}`);
      expect(page.html).toContain("Card added");
      expect(page.html).not.toContain(`data-link="`);
      expect(page.html).toContain(`data-closes="true"`);
    });
  });

  test("a page Stripe expired, or one past the setup's time, ends expired", async () => {
    await withBilling("on", async () => {
      const ws = await team();
      const first: string = (await start(ws)).body.id;
      t.payments.expireSetup(sessionOf(first).id);
      await deliver(checkoutEvent("checkout.session.expired", first, ws.id));
      expect((await poll(ws, first)).body.status).toBe("expired");

      const second: string = (await start(ws)).body.id;
      t.clock.advance(CARD_SETUP_LIFETIME_MS);
      // Signed in again: the access token has run out in that time.
      const fresh = (await t.signInAs({ login: "maya" })).headers;
      expect((await poll(ws, second, fresh)).body.status).toBe("expired");
      expect((await getWorkspace(t.db, ws.id))!.stripePaymentMethodId).toBeNull();
    });
  });

  test("a new setup takes the place of the one open, and either's card still lands", async () => {
    await withBilling("on", async () => {
      const ws = await team();
      const first: string = (await start(ws)).body.id;
      const second: string = (await start(ws)).body.id;
      // One customer for the workspace, however many setups.
      expect(t.payments.count("ensureCustomer")).toBeGreaterThan(0);
      const customers = [...t.payments.customers.values()].filter((c) => c.workspaceId === ws.id);
      expect(customers.length).toBe(1);
      expect((await readCardSetup(t.db, { id: first }))!.consumedAt).not.toBeNull();

      t.payments.completeSetup(sessionOf(first).id);
      await deliver(checkoutEvent("checkout.session.completed", first, ws.id));
      expect((await getWorkspace(t.db, ws.id))!.stripePaymentMethodId).toBe(
        sessionOf(first).paymentMethodId,
      );
      expect((await poll(ws, second)).body.status).toBe("waiting");
    });
  });

  test("a card added after the free credits ran out lets the workspace go", async () => {
    await withBilling("on", async () => {
      const ws = await team();
      await t.db.execute(
        `update workspaces set billing_period_anchor = '2025-10-09T00:00:00Z' where id = '${ws.id}'`,
      );
      // 41 hours is 205 credits: past the team's 200 free ones.
      await t.db.insert(usageEvents).values({
        id: `cards-${n++}`,
        workspaceId: ws.id,
        canvasId: null,
        userId: ws.people.maya!.userId,
        kind: "sandbox",
        seconds: 41 * 3600,
        credits: 0,
        costMicrousd: 0,
        payer: "ponzu",
        rateCardVersion: 1,
        occurredAt: new Date(t.clock.now() - 60_000),
      });
      await t.db.execute(`update workspaces set billing_gate = 'free_used' where id = '${ws.id}'`);
      const id: string = (await start(ws)).body.id;
      t.payments.completeSetup(sessionOf(id).id);
      await deliver(checkoutEvent("checkout.session.completed", id, ws.id));
      expect((await getWorkspace(t.db, ws.id))!.billingGate).toBe("ok");
      expect(
        t.logs.some((l) => l.event === "billing_gate_changed" && l.workspaceId === ws.id),
      ).toBe(true);
    });
  });

  test("only an admin may add a card, and never below what the month has billed", async () => {
    await withBilling("on", async () => {
      const ws = await team();
      const calls = t.payments.calls.length;
      const refused = await call(
        t,
        member(ws),
        "POST",
        `/v1/workspaces/${ws.id}/billing/card-setups`,
        {
          capUsd: 100,
        },
      );
      expect(refused.status).toBe(403);
      expect(t.payments.calls.length).toBe(calls);

      await t.db.insert(usageEvents).values({
        id: `cards-${n++}`,
        workspaceId: ws.id,
        canvasId: null,
        userId: ws.people.maya!.userId,
        kind: "sandbox",
        // 400 hours is 2,000 credits: 1,800 past free, $180 billed.
        seconds: 400 * 3600,
        credits: 0,
        costMicrousd: 0,
        payer: "ponzu",
        rateCardVersion: 1,
        occurredAt: new Date(t.clock.now() - 60_000),
      });
      const low = await start(ws, { capUsd: 100 });
      expect(low.status).toBe(400);
      expect(low.body.error).toMatchObject({ code: "cap_too_low", details: { lowestUsd: 180 } });
      expect(t.payments.calls.length).toBe(calls);
    });
  });

  test("Stripe down: 503 with Stripe's words, and nothing is written", async () => {
    await withBilling("on", async () => {
      const ws = await team();
      t.payments.failNext(
        "ensureCustomer",
        new PaymentsError({
          type: "connection_error",
          code: null,
          status: null,
          requestId: null,
        }),
      );
      const down = await start(ws);
      expect(down.status).toBe(503);
      expect(down.body.error).toEqual({
        code: "upstream_unavailable",
        message: "Couldn't reach Stripe. Try again.",
      });
      expect((await getWorkspace(t.db, ws.id))!.stripeCustomerId).toBeNull();
      expect(
        await rows(
          `select 1 from auth_states where kind = 'card_setup' and payload->>'workspaceId' = '${ws.id}'`,
        ),
      ).toEqual([]);
    });
  });

  test("the portal: 409 with no customer, Stripe's address once there is one", async () => {
    await withBilling("on", async () => {
      const ws = await team();
      const none = await call(t, admin(ws), "POST", `/v1/workspaces/${ws.id}/billing/portal`);
      expect(none.status).toBe(409);
      expect(none.body.error.code).toBe("no_card");
      await start(ws);
      const portal = await call(t, admin(ws), "POST", `/v1/workspaces/${ws.id}/billing/portal`);
      expect(portal.status).toBe(200);
      expect(portal.body.url).toStartWith("https://billing.stripe.test/");
      const asked = t.payments.calls.filter((c) => c.method === "portalUrl").at(-1)!.args[0];
      expect(asked).toMatchObject({
        returnUrl: `${t.deps.config.sandbox.apiUrl}/v1/billing/return?kind=portal`,
      });
      expect(
        (await call(t, member(ws), "POST", `/v1/workspaces/${ws.id}/billing/portal`)).status,
      ).toBe(403);
      const page = await back("kind=portal");
      expect(page.status).toBe(200);
      expect(page.html).toContain("Back to Ponzu");
      expect(page.html).not.toContain(`data-link="`);
    });
  });

  test("a card changed or removed in the portal follows Stripe, read fresh", async () => {
    await withBilling("on", async () => {
      const ws = await team();
      const id: string = (await start(ws)).body.id;
      t.payments.completeSetup(sessionOf(id).id);
      await deliver(checkoutEvent("checkout.session.completed", id, ws.id));
      const customerId = (await getWorkspace(t.db, ws.id))!.stripeCustomerId!;

      const replaced = t.payments.replaceCard(customerId, { brand: "amex", last4: "0005" });
      await deliver({
        type: "customer.updated",
        object: { id: customerId, object: "customer" },
      });
      expect(await getWorkspace(t.db, ws.id)).toMatchObject({
        stripePaymentMethodId: replaced,
        cardBrand: "amex",
        cardLast4: "0005",
        cardAddedByUserId: null,
      });

      t.payments.detachCard(customerId);
      await deliver({
        type: "payment_method.detached",
        object: { id: replaced, object: "payment_method", customer: null },
        previousAttributes: { customer: customerId },
      });
      expect(await getWorkspace(t.db, ws.id)).toMatchObject({
        stripePaymentMethodId: null,
        cardBrand: null,
        cardLast4: null,
      });
    });
  });

  test("a delivery that is not signed by our secret is refused with 400, and nothing is taken", async () => {
    await withBilling("on", async () => {
      const jobs = (await stripeJobs()).length;
      const { body } = await t.payments.webhookFor({
        type: "customer.updated",
        object: { id: "cus_x" },
      });
      for (const signature of [undefined, "t=1,v1=deadbeef"]) {
        const response = await t.app.request("/v1/stripe/webhook", {
          method: "POST",
          headers: signature ? { "stripe-signature": signature } : {},
          body,
        });
        expect(response.status).toBe(400);
        expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
          "signature_invalid",
        );
      }
      // Signed, then changed on the way.
      const signed = await t.payments.webhookFor({
        type: "customer.updated",
        object: { id: "cus_y" },
      });
      const tampered = await t.app.request("/v1/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": signed.signature },
        body: signed.body.replace("cus_y", "cus_z"),
      });
      expect(tampered.status).toBe(400);
      expect((await stripeJobs()).length).toBe(jobs);
    });
  });

  test("an event of the other mode, of another deployment, or not acted on is acknowledged and dropped", async () => {
    await withBilling("on", async () => {
      const ws = await team();
      const id: string = (await start(ws)).body.id;
      t.payments.completeSetup(sessionOf(id).id);
      const jobs = (await stripeJobs()).length;
      const reads = t.payments.count("readDefaultCard");
      const event = checkoutEvent("checkout.session.completed", id, ws.id);

      expect(await deliver({ ...event, livemode: true })).toEqual({
        status: 200,
        body: { received: true },
      });
      const otherScope = {
        ...event,
        object: {
          ...event.object,
          metadata: { ...event.object.metadata, ponzu_scope: "0ther0scope0" },
        },
      };
      expect((await deliver(otherScope)).status).toBe(200);
      expect((await deliver({ type: "invoice.created", object: { id: "in_1" } })).status).toBe(200);
      // A customer that is no workspace's here.
      expect(
        (
          await deliver({
            type: "customer.updated",
            object: { id: "cus_elsewhere", object: "customer" },
          })
        ).status,
      ).toBe(200);

      expect((await stripeJobs()).length).toBe(jobs + 1);
      expect((await getWorkspace(t.db, ws.id))!.stripePaymentMethodId).toBeNull();
      expect(t.payments.count("readDefaultCard")).toBe(reads);
    });
  });
});
