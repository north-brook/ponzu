/*
 * The period's charge against Stripe itself, in test mode, on Stripe's test clocks: opt-in only.
 * Run it with PONZU_LIVE_STRIPE=1, a test-mode STRIPE_SECRET_KEY (never a live one: it refuses)
 * and STRIPE_CREDIT_PRICE_ID from the setup script; without them every test is skipped.
 *
 * A customer on a test clock with Stripe's test card `pm_card_visa` is charged one period by the
 * seam's `chargePeriod`; the clock is moved past Stripe's first attempt and the invoice reads
 * `paid`. Another with `pm_card_chargeCustomerFail` reads open, with a failed attempt. Deleting
 * each clock deletes what was made on it. The test-clock calls go through Stripe's REST API with
 * fetch, so the SDK stays imported by deps/payments.ts alone.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { FakeClock } from "@ponzu/sandbox";
import { isLiveKey, type Payments, stripePayments } from "./payments.ts";

const key = process.env.STRIPE_SECRET_KEY ?? "";
const priceId = process.env.STRIPE_CREDIT_PRICE_ID ?? "";
const enabled =
  process.env.PONZU_LIVE_STRIPE === "1" && key.length > 0 && !isLiveKey(key) && priceId.length > 0;

const clocks: string[] = [];

async function stripe<T>(method: "GET" | "POST" | "DELETE", path: string, form = {}): Promise<T> {
  const body = new URLSearchParams(form as Record<string, string>);
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    ...(method === "GET" ? {} : { body }),
  });
  const json = (await response.json()) as T & { error?: { type: string; code?: string } };
  // Only Stripe's error type and code: never the request, which names the key's account.
  if (!response.ok)
    throw new Error(`Stripe ${response.status}: ${json.error?.type} ${json.error?.code ?? ""}`);
  return json;
}

/** Moves a test clock and waits, with a deadline, until Stripe has run what came due. */
async function advance(clockId: string, to: number) {
  await stripe("POST", `test_helpers/test_clocks/${clockId}/advance`, { frozen_time: String(to) });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const clock = await stripe<{ status: string }>("GET", `test_helpers/test_clocks/${clockId}`);
    if (clock.status === "ready") return;
    if (clock.status === "internal_failure") throw new Error("The test clock failed.");
    await Bun.sleep(2_000);
  }
  throw new Error("The test clock did not finish advancing in time.");
}

/** A customer on its own test clock, charged to `card` (one of Stripe's test payment methods). */
async function customerWith(card: string, start: number) {
  const clock = await stripe<{ id: string }>("POST", "test_helpers/test_clocks", {
    frozen_time: String(start),
    name: "ponzu live payments test",
  });
  clocks.push(clock.id);
  const customer = await stripe<{ id: string }>("POST", "customers", {
    test_clock: clock.id,
    name: "Ponzu live test",
    payment_method: card,
    "invoice_settings[default_payment_method]": card,
  });
  return { clockId: clock.id, customerId: customer.id };
}

afterAll(async () => {
  for (const id of clocks) await stripe("DELETE", `test_helpers/test_clocks/${id}`).catch(() => {});
});

describe.skipIf(!enabled)("a period charged at Stripe, on test clocks", () => {
  const start = Math.floor(Date.now() / 1000);
  const payments = (): Payments =>
    stripePayments(
      {
        secretKey: key,
        webhookSecret: "whsec_unused_by_this_test",
        creditPriceId: priceId,
        portalConfigurationId: null,
        tax: false,
      },
      { scope: `live${start.toString(16)}`, clock: new FakeClock(start * 1000) },
    );

  const charge = (customerId: string, workspaceId: string) =>
    payments().chargePeriod({
      workspaceId,
      periodStart: new Date((start - 30 * 86_400) * 1000),
      periodEnd: new Date(start * 1000),
      customerId,
      credits: 15,
      description: "Live test · 115 credits used, 100 free",
      lineDescription: "Ponzu usage, live test · 15 credits",
      invoiceId: null,
      onInvoice: async () => {},
    });

  test("the price is the rate card's", async () => {
    const price = await payments().readCreditPrice();
    expect(price).toMatchObject({ unitAmountDecimal: "10", currency: "usd", active: true });
  });

  test("a good card pays the period's one invoice once Stripe tries it", async () => {
    const { clockId, customerId } = await customerWith("pm_card_visa", start);
    const made = await charge(customerId, "ws_live_paid");
    expect(made).toMatchObject({ status: "open", totalCents: 150, lineCount: 1 });
    await advance(clockId, start + 3 * 3600);
    expect(await payments().readInvoice(made.id)).toMatchObject({ status: "paid" });
  }, 300_000);

  test("a card that declines leaves it open with a failed attempt", async () => {
    const { clockId, customerId } = await customerWith("pm_card_chargeCustomerFail", start);
    const made = await charge(customerId, "ws_live_failed");
    await advance(clockId, start + 3 * 3600);
    const state = await payments().readInvoice(made.id);
    expect(state.status).toBe("open");
    expect(state.attemptCount).toBeGreaterThanOrEqual(1);
  }, 300_000);
});
