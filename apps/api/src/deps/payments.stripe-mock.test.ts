/*
 * The contract test: every call `stripePayments` and the setup script make, sent through the real
 * SDK to Stripe's official mock server (stripe/stripe-mock, pinned by digest in CI), which checks
 * each request's parameters against Stripe's OpenAPI description and answers with fixtures. So a
 * parameter Stripe would refuse fails here. stripe-mock keeps no state and its answers are
 * fixtures, so this proves the requests' shapes, not what Stripe does with them.
 *
 * It runs when STRIPE_MOCK_URL says where stripe-mock listens (CI's Tests job sets it), and is
 * skipped otherwise. Locally:
 *
 *   docker run --rm -p 12111:12111 stripe/stripe-mock@sha256:aeb96b83e87a893d2ac005e363ac01ffa6e59a5ad85b49c155dfc9129de02e78
 *   STRIPE_MOCK_URL=http://localhost:12111 bun test apps/api/src/deps/payments.stripe-mock.test.ts
 *
 * The key is stripe-mock's own fake one: no real key is ever used here.
 */
import { describe, expect, test } from "bun:test";
import { systemClock } from "@ponzu/sandbox";
import {
  ensureStripeCatalog,
  type StripeEndpoint,
  stripePayments,
  WebhookSignatureError,
} from "./payments.ts";

const url = process.env.STRIPE_MOCK_URL;
const endpoint: StripeEndpoint | undefined = url
  ? {
      host: new URL(url).hostname,
      port: Number(new URL(url).port || 12111),
      protocol: new URL(url).protocol === "https:" ? "https" : "http",
    }
  : undefined;
const MOCK_KEY = "sk_test_123";

const payments = () =>
  stripePayments(
    {
      secretKey: MOCK_KEY,
      webhookSecret: "whsec_mock",
      creditPriceId: "price_mock",
      portalConfigurationId: "bpc_mock",
      tax: true,
    },
    { scope: "7e57000000a0", clock: systemClock, ...(endpoint ? { endpoint } : {}) },
  );

describe.skipIf(!url)("stripePayments against stripe-mock", () => {
  test("stripe-mock refuses a parameter Stripe would, so a pass here means something", async () => {
    const response = await fetch(`${url}/v1/invoiceitems`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${MOCK_KEY}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "customer=cus_contract&no_such_parameter=1",
    });
    expect(response.status).toBe(400);
  });

  test("makes a customer", async () => {
    const answer = await payments().ensureCustomer({
      workspaceId: "ws_contract",
      name: "North Brook",
      email: "maya@example.com",
      ip: "203.0.113.7",
    });
    expect(answer.customerId).toMatch(/^cus_/);
  });

  test("opens a Checkout page in setup mode and reads it back", async () => {
    const now = Date.now();
    const started = await payments().startCardSetup({
      setupId: "auth_contract",
      workspaceId: "ws_contract",
      customerId: "cus_contract",
      successUrl:
        "https://api.test/v1/billing/return?setup=auth_contract&session_id={CHECKOUT_SESSION_ID}",
      cancelUrl: "https://api.test/v1/billing/return?setup=auth_contract&cancelled=1",
      expiresAt: new Date(now + 31 * 60_000),
    });
    expect(started.sessionId).toMatch(/^cs_/);
    expect(started.url).toMatch(/^https:\/\//);
    const read = await payments().readCardSetup(started.sessionId);
    expect(["open", "complete", "expired"]).toContain(read.status);
  });

  test("uses a card, and reads the default one", async () => {
    const card = await payments().useCard({
      customerId: "cus_contract",
      paymentMethodId: "pm_card",
    });
    expect(["visa", "mastercard", "amex", "other"]).toContain(card.brand);
    const current = await payments().readDefaultCard("cus_contract");
    // stripe-mock's customer fixture may or may not name a default; either is a valid answer.
    if (current) expect(current.paymentMethodId).toMatch(/^pm_/);
  });

  test("opens the customer portal", async () => {
    const link = await payments().portalUrl({
      customerId: "cus_contract",
      returnUrl: "https://api.test/v1/billing/return?kind=portal",
    });
    expect(link).toMatch(/^https:\/\//);
  });

  test("reads the credit price", async () => {
    const price = await payments().readCreditPrice();
    expect(price.id).toMatch(/^price_/);
  });

  test("charges a period: invoice, line, finalize; and reads an invoice", async () => {
    const stored: string[] = [];
    const state = await payments().chargePeriod({
      workspaceId: "ws_contract",
      periodStart: new Date("2026-10-13T00:00:00Z"),
      periodEnd: new Date("2026-11-13T00:00:00Z"),
      customerId: "cus_contract",
      credits: 1500,
      description: "North Brook · 2000 credits used, 500 free",
      lineDescription: "Ponzu usage, Oct 13 – Nov 13, 2026 · 1500 credits",
      invoiceId: null,
      onInvoice: async (id) => {
        stored.push(id);
      },
    });
    expect(stored).toHaveLength(1);
    expect(state.id).toMatch(/^in_/);
    const read = await payments().readInvoice(state.id);
    expect(read.id).toMatch(/^in_/);
    // A close that runs again with the stored invoice reads it rather than making one.
    const again = await payments().chargePeriod({
      workspaceId: "ws_contract",
      periodStart: new Date("2026-10-13T00:00:00Z"),
      periodEnd: new Date("2026-11-13T00:00:00Z"),
      customerId: "cus_contract",
      credits: 1500,
      description: "North Brook · 2000 credits used, 500 free",
      lineDescription: "Ponzu usage, Oct 13 – Nov 13, 2026 · 1500 credits",
      invoiceId: stored[0]!,
      onInvoice: async (id) => {
        stored.push(id);
      },
    });
    expect(again.id).toMatch(/^in_/);
  });

  test("a webhook signed with another secret is refused", async () => {
    await expect(payments().verifyWebhook("{}", "t=1,v1=bad")).rejects.toBeInstanceOf(
      WebhookSignatureError,
    );
  });

  test("the setup script's calls", async () => {
    const catalog = await ensureStripeCatalog(MOCK_KEY, endpoint ? { endpoint } : {});
    expect(catalog.priceId).toMatch(/^price_/);
    expect(catalog.portalConfigurationId).toMatch(/^bpc_/);
    expect(catalog.livemode).toBe(false);
  });
});
