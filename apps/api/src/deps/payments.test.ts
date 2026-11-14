import { describe, expect, test } from "bun:test";
import { FakeClock } from "@ponzu/sandbox";
import { FakePayments, TEST_STRIPE_WEBHOOK_SECRET } from "../testing/fake-payments.ts";
import {
  cardBrandOf,
  creditCents,
  isLiveKey,
  noPayments,
  PaymentsError,
  PaymentsOffError,
  STRIPE_API_VERSION,
  type StripeConfig,
  selectPayments,
  verifyStripeWebhook,
  WebhookSignatureError,
} from "./payments.ts";

const CONFIG: StripeConfig = {
  secretKey: "sk_test_notreal",
  webhookSecret: "whsec_notreal",
  creditPriceId: "price_notreal",
  portalConfigurationId: null,
  tax: false,
};
const SCOPE = "7e57000000a0";

test("every call is made at the API version this SDK release pins", () => {
  expect(STRIPE_API_VERSION).toBe("2026-10-28.endive");
});

describe("off and observe never reach Stripe", () => {
  test("noPayments refuses every call as billing_not_set_up", async () => {
    expect(noPayments.enabled).toBe(false);
    const calls: (() => Promise<unknown>)[] = [
      () => noPayments.ensureCustomer({ workspaceId: "ws", name: "n", email: null, ip: null }),
      () =>
        noPayments.startCardSetup({
          setupId: "auth",
          workspaceId: "ws",
          customerId: "cus",
          successUrl: "https://x",
          cancelUrl: "https://x",
          expiresAt: new Date(),
        }),
      () => noPayments.readCardSetup("cs"),
      () => noPayments.useCard({ customerId: "cus", paymentMethodId: "pm" }),
      () => noPayments.readDefaultCard("cus"),
      () => noPayments.portalUrl({ customerId: "cus", returnUrl: "https://x" }),
      () => noPayments.readCreditPrice(),
      () =>
        noPayments.chargePeriod({
          workspaceId: "ws",
          periodStart: new Date(),
          periodEnd: new Date(),
          customerId: "cus",
          credits: 1,
          description: "",
          lineDescription: "",
          invoiceId: null,
          onInvoice: async () => {},
        }),
      () => noPayments.readInvoice("in"),
      () => noPayments.verifyWebhook("{}", "t=1,v1=x"),
    ];
    for (const call of calls) {
      let thrown: unknown;
      try {
        await call();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(PaymentsOffError);
      expect((thrown as PaymentsOffError).code).toBe("billing_not_set_up");
    }
  });

  test("Stripe is used only when billing is on, whatever keys are set", () => {
    const options = { scope: SCOPE, clock: new FakeClock() };
    expect(selectPayments("off", CONFIG, options)).toBe(noPayments);
    expect(selectPayments("observe", CONFIG, options)).toBe(noPayments);
    expect(selectPayments("off", null, options)).toBe(noPayments);
    const on = selectPayments("on", CONFIG, options);
    expect(on).not.toBe(noPayments);
    expect(on.enabled).toBe(true);
    expect(on.livemode).toBe(false);
  });
});

test("a live key is told from a test key", () => {
  expect(isLiveKey("sk_live_abc")).toBe(true);
  expect(isLiveKey("rk_live_abc")).toBe(true);
  expect(isLiveKey("sk_test_abc")).toBe(false);
  expect(isLiveKey("rk_test_abc")).toBe(false);
});

test("card brands: the three marks Ponzu draws, everything else other", () => {
  expect(cardBrandOf("visa")).toBe("visa");
  expect(cardBrandOf("mastercard")).toBe("mastercard");
  expect(cardBrandOf("amex")).toBe("amex");
  for (const other of ["discover", "jcb", "unionpay", "diners", "unknown", "", null, undefined]) {
    expect(cardBrandOf(other)).toBe("other");
  }
});

test("a credit is 10 cents on rate card v1, and a price that is not whole cents is refused", () => {
  expect(creditCents()).toBe(10);
  expect(creditCents(250_000)).toBe(25);
  expect(() => creditCents(105_000)).toThrow("not a whole number of cents");
});

test("an error from Stripe says what is safe and nothing else", () => {
  const error = new PaymentsError({
    type: "card_error",
    code: "card_declined",
    status: 402,
    requestId: "req_1",
  });
  expect(error.message).toBe("Stripe answered 402 (card_error, card_declined).");
  expect(error.unavailable).toBe(false);
  expect(
    new PaymentsError({ type: "api_error", code: null, status: 503, requestId: null }).unavailable,
  ).toBe(true);
  expect(
    new PaymentsError({ type: "connection_error", code: null, status: null, requestId: null })
      .message,
  ).toBe("Stripe could not be reached (connection_error).");
});

describe("webhooks, through Stripe's own signature check", () => {
  // Far from the real time on purpose: only the API's clock decides a signature's age.
  const clock = new FakeClock(Date.UTC(2026, 10, 13, 12));

  test("a delivery FakePayments signs passes the real check and reads as a reference", async () => {
    const payments = new FakePayments({ clock });
    const { body, signature } = await payments.webhookFor({
      id: "evt_1",
      type: "checkout.session.completed",
      object: {
        id: "cs_test_1",
        object: "checkout.session",
        customer: "cus_1",
        metadata: { ponzu_setup_id: "auth_1", ponzu_workspace_id: "ws_1", ponzu_scope: SCOPE },
      },
    });
    expect(await payments.verifyWebhook(body, signature)).toEqual({
      id: "evt_1",
      type: "checkout.session.completed",
      livemode: false,
      objectId: "cs_test_1",
      metadata: { ponzu_setup_id: "auth_1", ponzu_workspace_id: "ws_1", ponzu_scope: SCOPE },
      customerId: "cus_1",
      foreign: null,
    });
  });

  test("the customer an event is about: the customer itself, its object's, or the one it left", async () => {
    const payments = new FakePayments({ clock });
    const read = async (event: Parameters<FakePayments["webhookFor"]>[0]) => {
      const { body, signature } = await payments.webhookFor(event);
      return (await payments.verifyWebhook(body, signature)).customerId;
    };
    expect(
      await read({ type: "customer.updated", object: { id: "cus_2", object: "customer" } }),
    ).toBe("cus_2");
    expect(
      await read({
        type: "payment_method.attached",
        object: { id: "pm_1", object: "payment_method", customer: "cus_3" },
      }),
    ).toBe("cus_3");
    expect(
      await read({
        type: "payment_method.detached",
        object: { id: "pm_1", object: "payment_method", customer: null },
        previousAttributes: { customer: "cus_4" },
      }),
    ).toBe("cus_4");
    expect(
      await read({
        type: "charge.refunded",
        object: { id: "ch_1", object: "charge", customer: { id: "cus_5", object: "customer" } },
      }),
    ).toBe("cus_5");
    expect(await read({ type: "invoice.created", object: { id: "in_1" } })).toBeNull();
  });

  test("a changed body, another secret, or an old signature is refused", async () => {
    const payments = new FakePayments({ clock });
    const { body, signature } = await payments.webhookFor({
      type: "invoice.paid",
      object: { id: "in_1", object: "invoice" },
    });
    await expect(payments.verifyWebhook(body.replace("in_1", "in_2"), signature)).rejects.toThrow(
      WebhookSignatureError,
    );
    await expect(
      verifyStripeWebhook(body, signature, {
        secret: "whsec_someone_else",
        livemode: false,
        scope: SCOPE,
        now: clock.now(),
      }),
    ).rejects.toThrow(WebhookSignatureError);
    await expect(payments.verifyWebhook(body, "")).rejects.toThrow(WebhookSignatureError);
    // Five minutes later by the API's own clock it still passes; a second past that it does not.
    const later = new FakeClock(clock.now());
    const checker = new FakePayments({ clock: later });
    later.advance(300_000);
    expect((await checker.verifyWebhook(body, signature)).id).toMatch(/^evt_/);
    later.advance(1_000);
    await expect(checker.verifyWebhook(body, signature)).rejects.toThrow(WebhookSignatureError);
  });

  test("another mode's event, or another deployment's object, is foreign", async () => {
    const payments = new FakePayments({ clock });
    const live = await payments.webhookFor({
      type: "invoice.paid",
      livemode: true,
      object: { id: "in_1", metadata: { ponzu_scope: SCOPE } },
    });
    expect((await payments.verifyWebhook(live.body, live.signature)).foreign).toBe("livemode");
    const other = await payments.webhookFor({
      type: "invoice.paid",
      object: { id: "in_2", metadata: { ponzu_scope: "000000000000" } },
    });
    expect((await payments.verifyWebhook(other.body, other.signature)).foreign).toBe("scope");
    // A payment method carries no scope of ours: the caller judges it by its customer.
    const method = await payments.webhookFor({
      type: "payment_method.detached",
      object: { id: "pm_1", metadata: {} },
    });
    expect(await payments.verifyWebhook(method.body, method.signature)).toMatchObject({
      objectId: "pm_1",
      foreign: null,
    });
  });

  test("the test app's secret is what FakePayments signs with by default", () => {
    expect(new FakePayments({ clock }).webhookSecret).toBe(TEST_STRIPE_WEBHOOK_SECRET);
  });
});

describe("FakePayments acts Stripe's part", () => {
  test("off, it records every call and refuses it, as noPayments does", async () => {
    const payments = new FakePayments({ clock: new FakeClock(), enabled: false });
    await expect(payments.readCreditPrice()).rejects.toBeInstanceOf(PaymentsOffError);
    expect(payments.calls.map((call) => call.method)).toEqual(["readCreditPrice"]);
  });

  test("a card setup round trip, made once per setup", async () => {
    const clock = new FakeClock(Date.UTC(2026, 10, 13, 12));
    const payments = new FakePayments({ clock });
    const { customerId } = await payments.ensureCustomer({
      workspaceId: "ws_1",
      name: "North Brook",
      email: null,
      ip: null,
    });
    expect(
      (await payments.ensureCustomer({ workspaceId: "ws_1", name: "x", email: null, ip: null }))
        .customerId,
    ).toBe(customerId);
    const start = {
      setupId: "auth_1",
      workspaceId: "ws_1",
      customerId,
      successUrl: "https://api.test/ok",
      cancelUrl: "https://api.test/no",
      expiresAt: new Date("2026-11-13T12:30:00Z"),
    };
    const session = await payments.startCardSetup(start);
    expect(await payments.startCardSetup(start)).toEqual(session);
    expect(await payments.readCardSetup(session.sessionId)).toEqual({
      status: "open",
      paymentMethodId: null,
    });
    const method = payments.completeSetup(session.sessionId, { brand: "amex", last4: "0005" });
    expect(await payments.readCardSetup(session.sessionId)).toEqual({
      status: "complete",
      paymentMethodId: method,
    });
    expect(await payments.useCard({ customerId, paymentMethodId: method })).toEqual({
      brand: "amex",
      last4: "0005",
    });
    expect(await payments.readDefaultCard(customerId)).toEqual({
      paymentMethodId: method,
      card: { brand: "amex", last4: "0005" },
    });
  });

  test("a close crashed after each step still makes one invoice with one line", async () => {
    const payments = new FakePayments({ clock: new FakeClock() });
    const stored: string[] = [];
    const charge = (invoiceId: string | null) =>
      payments.chargePeriod({
        workspaceId: "ws_1",
        periodStart: new Date("2026-10-13T00:00:00Z"),
        periodEnd: new Date("2026-11-13T00:00:00Z"),
        customerId: "cus_1",
        credits: 1500,
        description: "d",
        lineDescription: "l",
        invoiceId,
        onInvoice: async (id) => {
          stored.push(id);
        },
      });
    payments.failNext("chargePeriod", new Error("crashed"), "after");
    await expect(charge(null)).rejects.toThrow("crashed");
    // A day later Stripe has forgotten the keys; the stored id is what holds.
    payments.forgetIdempotencyKeys();
    const state = await charge(stored[0]!);
    expect(payments.invoices.size).toBe(1);
    expect(state).toMatchObject({ status: "open", lineCount: 1, totalCents: 15_000 });
  });

  for (const step of ["invoice", "item", "finalize"] as const) {
    test(`crashChargeAfter("${step}") stops the charge there, and a retry still makes one of each`, async () => {
      const payments = new FakePayments({ clock: new FakeClock() });
      let stored: string | null = null;
      const charge = () =>
        payments.chargePeriod({
          workspaceId: "ws_1",
          periodStart: new Date("2026-10-13T00:00:00Z"),
          periodEnd: new Date("2026-11-13T00:00:00Z"),
          customerId: "cus_1",
          credits: 1500,
          description: "d",
          lineDescription: "l",
          invoiceId: stored,
          onInvoice: async (id) => {
            stored = id;
          },
        });
      payments.crashChargeAfter(step);
      await expect(charge()).rejects.toThrow(`crashed after ${step}`);
      expect(stored === null).toBe(step === "invoice");
      const [made] = [...payments.invoices.values()];
      expect(made!.lineCount).toBe(step === "invoice" ? 0 : 1);
      expect(made!.status).toBe(step === "finalize" ? "open" : "draft");
      if (step !== "invoice") payments.forgetIdempotencyKeys();
      expect(await charge()).toMatchObject({ status: "open", lineCount: 1, totalCents: 15_000 });
      expect(payments.invoices.size).toBe(1);
    });
  }
});
