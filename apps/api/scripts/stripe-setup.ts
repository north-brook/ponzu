// Make what billing needs in a Stripe account, once per account and mode (docs/cloud.md,
// "Billing"): the product "Ponzu credits", its one-time price at the rate card's cents (USD, tax
// exclusive, lookup key `ponzu_credit_v1`), and a customer portal configuration (update the
// payment method, read invoices, edit email, address, name and tax id). It is the founder's to run:
//
//   STRIPE_SECRET_KEY=<test key> bun apps/api/scripts/stripe-setup.ts
//
// It is safe to run again: each is found by its lookup key or its metadata before anything is
// made, and a price under the key that is not the rate card's is refused, never changed. It prints
// only ids: STRIPE_CREDIT_PRICE_ID and STRIPE_PORTAL_CONFIGURATION_ID for the API's environment.
// A live key is refused unless `--live` is given, so a test run never touches the live account.
// The key is read from the environment only, never an argument, so it stays out of shell history.
import { ensureStripeCatalog, isLiveKey } from "../src/deps/payments.ts";

const key = process.env.STRIPE_SECRET_KEY;
const args = process.argv.slice(2);
const live = args.includes("--live");
if (
  !key ||
  !/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(key) ||
  args.some((arg) => arg !== "--live")
) {
  console.error(
    "usage: STRIPE_SECRET_KEY=<sk_test_… or rk_test_…> bun apps/api/scripts/stripe-setup.ts [--live]",
  );
  process.exit(2);
}
if (isLiveKey(key) && !live) {
  console.error("That is a live key. Run with --live to set up the live account.");
  process.exit(2);
}
if (!isLiveKey(key) && live) {
  console.error("--live was given with a test key.");
  process.exit(2);
}

try {
  const catalog = await ensureStripeCatalog(key);
  const made = catalog.created.length > 0 ? `made ${catalog.created.join(", ")}` : "made nothing";
  console.log(`Stripe ${catalog.livemode ? "live" : "test"} mode: ${made}.`);
  console.log(`STRIPE_CREDIT_PRICE_ID=${catalog.priceId}`);
  console.log(`STRIPE_PORTAL_CONFIGURATION_ID=${catalog.portalConfigurationId}`);
} catch (error) {
  // Only the seam's safe message: never the key, never Stripe's own text.
  console.error(error instanceof Error ? error.message : "The setup failed.");
  process.exitCode = 1;
}
