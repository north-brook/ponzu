import {
  beginCardSetup,
  type CardSetup,
  type CardSetupOutcome,
  type CardSetupPayload,
  clearCard,
  getWorkspace,
  readCardSetup,
  setCard,
  setCardSetupSession,
  setCustomer,
  setMonthlyCap,
  settleCardSetup,
  type User,
} from "@ponzu/db";
import { type Card, PaymentsError, PaymentsOffError } from "../deps/payments.ts";
import { ApiError } from "../http/errors.ts";
import { lowestCapUsd } from "./credits.ts";
import { readBillingGate } from "./reading.ts";
import { type RefreshDeps, refreshBillingGate } from "./refresh.ts";

/*
 * Cards (docs/cloud.md, "Billing", "Cards"). An admin adds the workspace's card on Stripe's own
 * Checkout page, in setup mode, in their browser: the app asks for a setup (`startCardSetup`),
 * opens the page, and waits. Whichever comes first settles it, and every later one finds it
 * settled: the app's poll (`cardSetupStatus`), the page Checkout returns to (`finishReturn`), or
 * Stripe's `checkout.session.*` webhook (`settleFromStripe`). Each reads the Checkout session
 * from Stripe as it is now; nothing a browser brings is believed but the setup's id, which only
 * picks the row.
 *
 * Settling with a card makes it the customer's default at Stripe, stores it, sets the cap the
 * admin chose with it, and works the gate out again, which wakes what the gate held back. The
 * card is applied before the setup is marked, so a crash between leaves it to be applied again,
 * and a card Stripe has is applied even when the setup was meanwhile marked cancelled or expired:
 * what Stripe has is the truth.
 *
 * None of this runs unless PONZU_BILLING is `on`: the routes refuse first (`requireBillingOn`),
 * and `deps.payments` refuses every call while it is not.
 */

/** How long a setup stays open: Checkout's page lives 31 minutes, and the poll a little longer. */
export const CARD_SETUP_LIFETIME_MS = 35 * 60_000;
/** Checkout's page: at least Stripe's 30 minutes, with a minute to spare for the request. */
export const CHECKOUT_LIFETIME_MS = 31 * 60_000;
/** A poll on a setup this young only reads the row; past it, it asks Stripe too. */
export const POLL_ASKS_STRIPE_AFTER_MS = 5_000;

/** The words people read when Stripe cannot be reached. */
export const STRIPE_DOWN = "Couldn't reach Stripe. Try again.";

/** Refuses unless billing is on and Stripe is set up: before anything is read or written. */
export function requireBillingOn(deps: Pick<RefreshDeps, "features" | "payments">): void {
  if (deps.features.billing !== "on" || !deps.payments.enabled) {
    throw new ApiError(409, "billing_not_set_up", "Billing isn't set up here.");
  }
}

/** A Stripe failure, as a person's request answers it. */
export function stripeFailure(error: unknown): unknown {
  if (error instanceof PaymentsOffError) {
    return new ApiError(409, "billing_not_set_up", "Billing isn't set up here.");
  }
  if (error instanceof PaymentsError) {
    return new ApiError(503, "upstream_unavailable", STRIPE_DOWN, { cause: error });
  }
  return error;
}

export type CardSetupScheme = CardSetupPayload["scheme"];
export type CardSetupSource = NonNullable<CardSetupPayload["source"]>;

/**
 * Begin adding a card: the workspace's Stripe customer (made the first time), a setup row in
 * place of any the workspace had open, and a Checkout page for it. Answers the setup's id, for
 * the poll, and the page's address. The caller has checked billing is on and the person is an
 * admin of the workspace.
 */
export async function startCardSetup(
  deps: RefreshDeps,
  {
    user,
    workspaceId,
    capUsd,
    scheme,
    source,
    ip,
  }: {
    user: Pick<User, "id" | "email">;
    workspaceId: string;
    capUsd: number;
    scheme: CardSetupScheme;
    source: CardSetupSource;
    ip: string | null;
  },
): Promise<{ id: string; url: string }> {
  const { db, clock, payments, config } = deps;
  const reading = await readBillingGate(deps, workspaceId);
  if (!reading) throw new ApiError(404, "not_found", "There is no such workspace.");
  // The same rule as setting the cap in Settings: never below what this month has billed.
  const lowestUsd = lowestCapUsd(reading.billedCents);
  if (capUsd < lowestUsd) {
    throw new ApiError(
      400,
      "cap_too_low",
      `The cap can't be below $${lowestUsd}, which this month has billed.`,
      { details: { lowestUsd } },
    );
  }
  const { workspace } = reading;

  let customerId = workspace.stripeCustomerId;
  if (customerId === null) {
    // Asked of Stripe only while the workspace has none: its idempotency key is the workspace's,
    // and a second ask with another admin's email inside a day would be refused for it.
    const made = await payments
      .ensureCustomer({ workspaceId, name: workspace.name, email: user.email ?? null, ip })
      .catch((error) => {
        throw stripeFailure(error);
      });
    const stored = await setCustomer(db, { workspaceId, customerId: made.customerId });
    if (!stored) throw new ApiError(404, "not_found", "There is no such workspace.");
    if (!stored.stored) {
      // Two first setups at once: the other stored its customer first, and this one sits unused.
      deps.log.warn("stripe_customer_orphan", { workspaceId, customerId: made.customerId });
    }
    customerId = stored.customerId;
  }

  const now = new Date(clock.now());
  const begin = () =>
    beginCardSetup(db, {
      userId: user.id,
      workspaceId,
      capCents: capUsd * 100,
      scheme,
      source,
      now,
      expiresAt: new Date(now.getTime() + CARD_SETUP_LIFETIME_MS),
    });
  // Null only when another start for the workspace won this same moment: this one replaces it.
  const setup = (await begin()) ?? (await begin());
  if (!setup) throw new Error("Two card setups kept starting at once.");
  if (setup.replaced.length > 0) {
    deps.log.info("card_setup_replaced", { workspaceId, replaced: setup.replaced.length });
  }

  const back = `${config.sandbox.apiUrl}/v1/billing/return?setup=${encodeURIComponent(setup.id)}`;
  let page: { sessionId: string; url: string };
  try {
    page = await payments.startCardSetup({
      setupId: setup.id,
      workspaceId,
      customerId,
      // Stripe fills in the session's id; the return page reads the one the row records.
      successUrl: `${back}&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${back}&cancelled=1`,
      expiresAt: new Date(now.getTime() + CHECKOUT_LIFETIME_MS),
    });
  } catch (error) {
    // No page was made, so this setup can never finish: it ends here, and a new one starts over.
    await settleCardSetup(db, { id: setup.id, outcome: "failed", at: now });
    deps.log.warn("card_setup_failed", { workspaceId, step: "checkout", error });
    deps.analytics.capture("card setup ended", { outcome: "failed" }, { workspaceId });
    throw stripeFailure(error);
  }
  await setCardSetupSession(db, { id: setup.id, sessionId: page.sessionId });
  deps.log.info("card_setup_started", { workspaceId, setupId: setup.id });
  deps.analytics.capture("card setup started", { source }, { workspaceId });
  return { id: setup.id, url: page.url };
}

/** How a setup stands, as the app's poll reads it. */
export type CardSetupStatus = "waiting" | CardSetupOutcome;

/**
 * How a setup this person started stands. A setup still waiting after a few seconds is read from
 * Stripe and settled when Stripe says it ended, so the app learns of the card without the return
 * page's link or the webhook. Null when there is no such setup of theirs.
 */
export async function cardSetupStatus(
  deps: RefreshDeps,
  { id, userId }: { id: string; userId: string },
): Promise<{ status: CardSetupStatus; workspaceId: string } | null> {
  let setup = await readCardSetup(deps.db, { id, userId });
  if (!setup) return null;
  const age = deps.clock.now() - setup.createdAt.getTime();
  if (setup.payload.outcome === null && age >= POLL_ASKS_STRIPE_AFTER_MS) {
    setup = (await settleFromStripe(deps, setup)).setup;
  }
  return { status: setup.payload.outcome ?? "waiting", workspaceId: setup.payload.workspaceId };
}

/** What became of a setup once Stripe was asked: the row as it now is. */
export interface Settled {
  setup: CardSetup;
  /** Stripe could not be reached: the setup is left as it was, to be asked again. */
  unreachable: boolean;
}

/**
 * Ask Stripe what became of the setup's Checkout page and settle it by that: a card it collected
 * is applied and the setup marked `added`; a page Stripe expired, or one past the setup's time,
 * marks it `expired`; a page still open leaves it waiting. `cancelled` is the cancel link's, for
 * a page Stripe says is not complete. A Stripe failure leaves the setup as it was.
 */
export async function settleFromStripe(
  deps: RefreshDeps,
  setup: CardSetup,
  { cancelled = false, sessionId }: { cancelled?: boolean; sessionId?: string } = {},
): Promise<Settled> {
  const session = sessionId ?? setup.payload.checkoutSessionId;
  const now = new Date(deps.clock.now());
  const expired = now.getTime() >= setup.expiresAt.getTime();
  if (setup.payload.outcome === "added") return { setup, unreachable: false };
  if (session === null) {
    // Checkout never made its page (or the setup was replaced first): nothing at Stripe to read.
    if (setup.payload.outcome !== null) return { setup, unreachable: false };
    if (!expired && !cancelled) return { setup, unreachable: false };
    return {
      setup: await settle(deps, setup, cancelled ? "cancelled" : "expired"),
      unreachable: false,
    };
  }
  let page: Awaited<ReturnType<RefreshDeps["payments"]["readCardSetup"]>>;
  try {
    page = await deps.payments.readCardSetup(session);
  } catch (error) {
    deps.log.warn("card_setup_unreachable", { setupId: setup.id, error });
    return { setup, unreachable: true };
  }
  if (page.status === "complete" && page.paymentMethodId !== null) {
    // Applied whatever the row says: a card Stripe has is the workspace's card.
    await applyCard(deps, setup, page.paymentMethodId);
    return { setup: await settle(deps, setup, "added"), unreachable: false };
  }
  if (setup.payload.outcome !== null) return { setup, unreachable: false };
  if (page.status === "expired" || expired) {
    return { setup: await settle(deps, setup, "expired"), unreachable: false };
  }
  if (cancelled) return { setup: await settle(deps, setup, "cancelled"), unreachable: false };
  return { setup, unreachable: false };
}

/** Mark the setup's outcome, once, and say so where it is the first to. */
async function settle(
  deps: RefreshDeps,
  setup: CardSetup,
  outcome: CardSetupOutcome,
): Promise<CardSetup> {
  const now = new Date(deps.clock.now());
  const settled = await settleCardSetup(deps.db, { id: setup.id, outcome, at: now });
  if (!settled) return setup;
  if (settled.settled) {
    const { workspaceId } = setup.payload;
    deps.log.info("card_setup_settled", { workspaceId, setupId: setup.id, outcome });
    if (outcome === "added") {
      // The brand only: never the last four digits, the customer or the method.
      const workspace = await getWorkspace(deps.db, workspaceId);
      deps.analytics.capture(
        "card added",
        {
          brand: workspace?.cardBrand ?? "other",
          source: setup.payload.source ?? "settings",
          seconds_to_add: Math.max(
            0,
            Math.round((now.getTime() - setup.createdAt.getTime()) / 1000),
          ),
        },
        { distinctId: setup.userId, workspaceId },
      );
    } else {
      deps.analytics.capture(
        "card setup ended",
        { outcome },
        { distinctId: setup.userId, workspaceId },
      );
    }
  }
  return settled.setup;
}

/**
 * Make the card the customer's default at Stripe, store it, set the cap the admin chose with it,
 * then work the gate out again (which wakes what it held back). Safe to run twice.
 */
async function applyCard(deps: RefreshDeps, setup: CardSetup, paymentMethodId: string) {
  const { workspaceId, capCents } = setup.payload;
  const workspace = await getWorkspace(deps.db, workspaceId);
  if (!workspace?.stripeCustomerId) {
    throw new Error("A card setup's workspace has no Stripe customer.");
  }
  const card = await deps.payments.useCard({
    customerId: workspace.stripeCustomerId,
    paymentMethodId,
  });
  const now = new Date(deps.clock.now());
  await setCard(deps.db, {
    workspaceId,
    paymentMethodId,
    brand: card.brand,
    last4: card.last4,
    addedByUserId: setup.userId,
    at: now,
  });
  // The cap chosen with the card, once: a setup settled before has had its say.
  if (setup.payload.outcome === null) {
    await setMonthlyCap(deps.db, { workspaceId, capCents });
  }
  await refreshBillingGate(deps, workspaceId);
}

/**
 * Bring the stored card in line with the customer's default at Stripe, read now: what a webhook
 * about the customer or one of its payment methods asks for (a card changed or removed in the
 * portal). A card stored meanwhile by a settle is never replaced by this older read. Answers
 * whether the stored card changed.
 */
export async function syncCard(deps: RefreshDeps, workspaceId: string): Promise<boolean> {
  const workspace = await getWorkspace(deps.db, workspaceId);
  if (!workspace?.stripeCustomerId) return false;
  const stored = workspace.stripePaymentMethodId;
  const current = await deps.payments.readDefaultCard(workspace.stripeCustomerId);
  let changed = false;
  if (current === null) {
    if (stored !== null) {
      changed = await clearCard(deps.db, { workspaceId, paymentMethodId: stored });
    }
  } else if (current.paymentMethodId !== stored || !sameCard(current.card, workspace)) {
    changed = await setCard(deps.db, {
      workspaceId,
      paymentMethodId: current.paymentMethodId,
      brand: current.card.brand,
      last4: current.card.last4,
      addedByUserId: null,
      at: new Date(deps.clock.now()),
      ifPaymentMethodId: stored,
    });
  }
  if (changed) {
    deps.log.info("card_synced", { workspaceId, card: current === null ? "removed" : "changed" });
    await refreshBillingGate(deps, workspaceId);
  }
  return changed;
}

const sameCard = (card: Card, stored: { cardBrand: string | null; cardLast4: string | null }) =>
  card.brand === stored.cardBrand && card.last4 === stored.cardLast4;
