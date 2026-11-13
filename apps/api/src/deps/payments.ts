/*
 * Payments, through Stripe's own Node SDK (`stripe`, pinned exactly). This is the only file in the
 * repository that imports the SDK (payments.surface.test.ts holds it to that); everything else
 * reaches Stripe through the `Payments` interface, which FakePayments also implements.
 *
 * It is off, as `noPayments`, unless PONZU_BILLING is `on`: with billing off or observing, no call
 * reaches Stripe whatever keys are set (docs/cloud.md, "Billing"). The API version is the one the
 * SDK pins (`STRIPE_API_VERSION`); no override is passed.
 *
 * What may be logged: Stripe's error type, code and HTTP status, and ids. Never a key, a webhook
 * secret, an email, or Stripe's own error message, which can quote what was sent. A
 * `PaymentsError` is built from the safe parts only and carries no `cause`, so logging one, or
 * reporting it to error tracking, is safe too.
 */

import { PUBLISHED_RATE_CARD } from "@ponzu/db/rate-card";
import type { Clock } from "@ponzu/sandbox";
import Stripe from "stripe";

/** The Stripe API version every call is made at: the one this SDK release pins. */
export const STRIPE_API_VERSION: string = Stripe.API_VERSION;

/** How long one call to Stripe may take before it fails, the same as other vendors get. */
export const STRIPE_TIMEOUT_MS = 10_000;

/** The lookup key and metadata the setup script finds its own price, product and portal by. */
export const CREDIT_PRICE_LOOKUP_KEY = "ponzu_credit_v1";
const PRODUCT_MARK = "credits_v1";
const PORTAL_MARK = "v1";

/** The card a workspace is charged, as people see it: the brand's mark, and its last four digits. */
export interface Card {
  brand: "visa" | "mastercard" | "amex" | "other";
  /** Null for a method with no card number, such as Link without a card. */
  last4: string | null;
}

/** An invoice, as Ponzu acts on it: read fresh from Stripe every time, never from a webhook body. */
export interface InvoiceState {
  id: string;
  status: "draft" | "open" | "paid" | "uncollectible" | "void";
  amountDueCents: number;
  totalCents: number;
  /** The tax on it, in cents: 0 while Stripe Tax is off. */
  taxCents: number;
  attemptCount: number;
  nextPaymentAttemptAt: Date | null;
  hostedInvoiceUrl: string | null;
  number: string | null;
  /** How many lines it has: one, the period's, once the close has added it. */
  lineCount: number;
  /** True when the bank asks the payer to confirm the payment (3D Secure and the like). */
  needsAction: boolean;
  /** Our marks on it; an invoice without `ponzu_workspace_id` was made by hand at Stripe. */
  metadata: Record<string, string>;
}

/** A webhook delivery, as far as Ponzu reads it: a signal to read the object fresh, never a record. */
export interface StripeEventRef {
  id: string;
  type: string;
  livemode: boolean;
  /** The id of the object the event is about (`data.object.id`), when it has one. */
  objectId: string | null;
  /** The object's metadata, as the event carried it. */
  metadata: Record<string, string>;
  /**
   * Why the event is not this deployment's, or null when it is: it is from the other mode than
   * this deployment's key (`livemode`), or its object carries another deployment's scope
   * (`scope`). Such an event is acknowledged and ignored. An object with no scope of ours (a
   * payment method) is judged by the customer it names, which the caller looks up.
   */
  foreign: "livemode" | "scope" | null;
}

/** One period's charge: one invoice with one line, `credits` × the credit price. */
export interface PeriodCharge {
  workspaceId: string;
  periodStart: Date;
  periodEnd: Date;
  customerId: string;
  credits: number;
  /** The invoice's description: `<Workspace> · <used> credits used, <free> free`. */
  description: string;
  /** The line's: `Ponzu usage, <Mon D> – <Mon D, YYYY> · <charged> credits`. */
  lineDescription: string;
  /**
   * The invoice already made for this period, when the close stored one: it is read, never made
   * again. Stripe forgets an idempotency key after about a day; this is what holds after that.
   */
  invoiceId: string | null;
  /** Called with the invoice's id as soon as Stripe made it, before its line, to store it. */
  onInvoice: (invoiceId: string) => Promise<void>;
}

export interface Payments {
  /** False when billing is not on: every call throws `PaymentsOffError` and nothing reaches Stripe. */
  readonly enabled: boolean;
  /** Whether the key is a live one; a webhook from the other mode is ignored. */
  readonly livemode: boolean;
  /** Makes the workspace's Stripe customer. Idempotent for the workspace for about a day. */
  ensureCustomer(i: {
    workspaceId: string;
    name: string;
    email: string | null;
    /** The request's IP, for Stripe Tax's location when no address is known yet. */
    ip: string | null;
  }): Promise<{ customerId: string }>;
  /** Opens a Checkout page in setup mode, where the admin adds a card in their browser. */
  startCardSetup(i: {
    setupId: string;
    workspaceId: string;
    customerId: string;
    successUrl: string;
    cancelUrl: string;
    /** At least 30 minutes and at most 24 hours from now: Checkout's own bounds. */
    expiresAt: Date;
  }): Promise<{ sessionId: string; url: string }>;
  /** What became of a Checkout page, and the card it collected. */
  readCardSetup(
    sessionId: string,
  ): Promise<{ status: "open" | "complete" | "expired"; paymentMethodId: string | null }>;
  /** Makes the card the one the customer's invoices are charged to, and answers what it is. */
  useCard(i: { customerId: string; paymentMethodId: string }): Promise<Card>;
  /** The card the customer's invoices are charged to now, or null when there is none. */
  readDefaultCard(customerId: string): Promise<{ paymentMethodId: string; card: Card } | null>;
  /** A link into Stripe's customer portal, where an admin changes the card or reads invoices. */
  portalUrl(i: { customerId: string; returnUrl: string }): Promise<string>;
  /** The credit price, to check against the rate card before anything is charged. */
  readCreditPrice(): Promise<{
    id: string;
    unitAmountDecimal: string | null;
    currency: string;
    active: boolean;
  }>;
  /**
   * Charges one period: makes its invoice (or reads the one given), adds its one line when it has
   * none, and finalizes it when it is still a draft, so Stripe charges the card. Every step is safe
   * to run again after a crash at any point.
   */
  chargePeriod(i: PeriodCharge): Promise<InvoiceState>;
  readInvoice(id: string): Promise<InvoiceState>;
  /** Checks a delivery's signature against the raw body. Throws `WebhookSignatureError`. */
  verifyWebhook(rawBody: string, signature: string): Promise<StripeEventRef>;
}

/** Billing is not on here: nothing may be asked of Stripe. */
export class PaymentsOffError extends Error {
  readonly code = "billing_not_set_up";
  constructor() {
    super("Payments are off: PONZU_BILLING is not on.");
    this.name = "PaymentsOffError";
  }
}

/** Stripe refused a call, or could not be reached. Carries only what is safe to log. */
export class PaymentsError extends Error {
  /** Stripe's error type (`card_error`, `invalid_request_error`, …), or `connection_error`. */
  readonly type: string;
  readonly code: string | null;
  /** Stripe's HTTP status, or null when Stripe never answered. */
  readonly status: number | null;
  readonly requestId: string | null;
  constructor(parts: {
    type: string;
    code: string | null;
    status: number | null;
    requestId: string | null;
  }) {
    super(
      `Stripe ${parts.status === null ? "could not be reached" : `answered ${parts.status}`} (${parts.type}${parts.code ? `, ${parts.code}` : ""}).`,
    );
    this.name = "PaymentsError";
    this.type = parts.type;
    this.code = parts.code;
    this.status = parts.status;
    this.requestId = parts.requestId;
  }
  /** True when Stripe never answered or failed on its side: worth trying again later. */
  get unavailable(): boolean {
    return this.status === null || this.status >= 500 || this.status === 429;
  }
}

/** A webhook whose signature does not match its body under our secret, or is too old. */
export class WebhookSignatureError extends Error {
  constructor() {
    super("The webhook's signature does not match.");
    this.name = "WebhookSignatureError";
  }
}

/** Payments while billing is not on: off, and anything asked of it is a caller's mistake. */
export const noPayments: Payments = {
  enabled: false,
  livemode: false,
  ensureCustomer: off,
  startCardSetup: off,
  readCardSetup: off,
  useCard: off,
  readDefaultCard: off,
  portalUrl: off,
  readCreditPrice: off,
  chargePeriod: off,
  readInvoice: off,
  verifyWebhook: off,
};

function off(): never {
  throw new PaymentsOffError();
}

/** What the API needs of Stripe, from the environment (env.ts). */
export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  creditPriceId: string;
  /** The portal configuration the setup script made; null uses the account's default. */
  portalConfigurationId: string | null;
  /** PONZU_STRIPE_TAX=1: Stripe Tax works out tax on each invoice. */
  tax: boolean;
}

/** Where Stripe is: its API, or stripe-mock in a test. */
export interface StripeEndpoint {
  host: string;
  port: number;
  protocol: "http" | "https";
}

/** What the seam takes from the deployment besides Stripe's own settings. */
export interface StripeOptions {
  /**
   * The deployment's scope (`sandboxScope` in env.ts), marked on every object it makes, so two
   * deployments sharing one Stripe account each ignore the other's.
   */
  scope: string;
  clock: Clock;
  endpoint?: StripeEndpoint;
}

/** Whether a secret or restricted key is a live one. */
export const isLiveKey = (key: string) => /^(sk|rk)_live_/.test(key);

/**
 * Payments on Stripe, unless billing is not on, where they are `noPayments` whatever keys are set:
 * off and observe never reach Stripe.
 */
export function selectPayments(
  mode: "off" | "observe" | "on",
  config: StripeConfig | null,
  options: StripeOptions,
): Payments {
  if (mode !== "on" || config === null) return noPayments;
  return stripePayments(config, options);
}

function client(secretKey: string, endpoint?: StripeEndpoint): Stripe {
  return new Stripe(secretKey, {
    timeout: STRIPE_TIMEOUT_MS,
    // A POST the SDK sends again carries the same idempotency key, so a retry is never a second charge.
    maxNetworkRetries: 1,
    telemetry: false,
    appInfo: { name: "Ponzu" },
    ...(endpoint ?? {}),
  });
}

/** Turns anything the SDK threw into a `PaymentsError` of safe parts, or passes ours through. */
function safe(error: unknown): Error {
  if (
    error instanceof PaymentsError ||
    error instanceof PaymentsOffError ||
    error instanceof StripeCatalogError
  ) {
    return error;
  }
  if (error instanceof Stripe.errors.StripeError) {
    return new PaymentsError({
      type: error.type,
      code: error.code ?? null,
      status: error.statusCode ?? null,
      requestId: error.requestId ?? null,
    });
  }
  return new PaymentsError({ type: "unknown_error", code: null, status: null, requestId: null });
}

async function call<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw safe(error);
  }
}

/** A card brand as Stripe names it, as Ponzu shows it: the three marks it draws, else `other`. */
export function cardBrandOf(brand: string | null | undefined): Card["brand"] {
  return brand === "visa" || brand === "mastercard" || brand === "amex" ? brand : "other";
}

function cardOf(method: Stripe.PaymentMethod): Card {
  if (method.card) return { brand: cardBrandOf(method.card.brand), last4: method.card.last4 };
  return { brand: "other", last4: null };
}

function invoiceStateOf(invoice: Stripe.Invoice): InvoiceState {
  const status = invoice.status ?? "draft";
  const taxCents = (invoice.total_taxes ?? []).reduce((sum, tax) => sum + tax.amount, 0);
  return {
    id: invoice.id,
    status: (["draft", "open", "paid", "uncollectible", "void"] as const).includes(
      status as InvoiceState["status"],
    )
      ? (status as InvoiceState["status"])
      : "open",
    amountDueCents: invoice.amount_due,
    totalCents: invoice.total,
    taxCents,
    attemptCount: invoice.attempt_count,
    nextPaymentAttemptAt:
      invoice.next_payment_attempt === null ? null : new Date(invoice.next_payment_attempt * 1000),
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    number: invoice.number,
    lineCount: invoice.lines?.data.length ?? 0,
    needsAction: invoice.status === "open" && invoice.attempted && invoiceNeedsAction(invoice),
    metadata: { ...(invoice.metadata ?? {}) },
  };
}

/** Whether the last payment attempt is waiting on the payer to confirm it. */
function invoiceNeedsAction(invoice: Stripe.Invoice): boolean {
  const payment = invoice.payments?.data[0]?.payment;
  const intent = payment && "payment_intent" in payment ? payment.payment_intent : null;
  return typeof intent === "object" && intent !== null && intent.status === "requires_action";
}

/** The key one period's Stripe calls share: the deployment's scope, the workspace and the period. */
const periodKey = (scope: string, workspaceId: string, periodStart: Date) =>
  `${scope}:${workspaceId}:${periodStart.toISOString()}`;

/** Payments on Stripe's SDK. Makes no call until one is asked for. */
export function stripePayments(config: StripeConfig, options: StripeOptions): Payments {
  const stripe = client(config.secretKey, options.endpoint);
  const livemode = isLiveKey(config.secretKey);
  const marks = (workspaceId: string, more: Record<string, string> = {}) => ({
    ponzu_workspace_id: workspaceId,
    ponzu_scope: options.scope,
    ...more,
  });

  return {
    enabled: true,
    livemode,

    ensureCustomer: ({ workspaceId, name, email, ip }) =>
      call(async () => {
        const customer = await stripe.customers.create(
          {
            name,
            ...(email ? { email } : {}),
            metadata: marks(workspaceId),
            ...(ip ? { tax: { ip_address: ip } } : {}),
          },
          { idempotencyKey: `customer:${options.scope}:${workspaceId}` },
        );
        return { customerId: customer.id };
      }),

    startCardSetup: ({ setupId, workspaceId, customerId, successUrl, cancelUrl, expiresAt }) =>
      call(async () => {
        const metadata = marks(workspaceId, { ponzu_setup_id: setupId });
        const session = await stripe.checkout.sessions.create(
          {
            mode: "setup",
            ui_mode: "hosted_page",
            customer: customerId,
            currency: "usd",
            billing_address_collection: "required",
            customer_update: { address: "auto", name: "auto" },
            success_url: successUrl,
            cancel_url: cancelUrl,
            expires_at: Math.floor(expiresAt.getTime() / 1000),
            metadata,
            setup_intent_data: { metadata },
          },
          { idempotencyKey: `checkout:${options.scope}:${setupId}` },
        );
        if (!session.url) {
          throw new PaymentsError({
            type: "missing_url",
            code: null,
            status: 200,
            requestId: null,
          });
        }
        return { sessionId: session.id, url: session.url };
      }),

    readCardSetup: (sessionId) =>
      call(async () => {
        const session = await stripe.checkout.sessions.retrieve(sessionId, {
          expand: ["setup_intent"],
        });
        const intent = session.setup_intent;
        const method = intent && typeof intent === "object" ? intent.payment_method : null;
        const status: "open" | "complete" | "expired" =
          session.status === "complete"
            ? "complete"
            : session.status === "expired"
              ? "expired"
              : "open";
        return {
          status,
          paymentMethodId: method === null ? null : typeof method === "string" ? method : method.id,
        };
      }),

    useCard: ({ customerId, paymentMethodId }) =>
      call(async () => {
        await stripe.customers.update(customerId, {
          invoice_settings: { default_payment_method: paymentMethodId },
        });
        return cardOf(await stripe.paymentMethods.retrieve(paymentMethodId));
      }),

    readDefaultCard: (customerId) =>
      call(async () => {
        const customer = await stripe.customers.retrieve(customerId, {
          expand: ["invoice_settings.default_payment_method"],
        });
        if (customer.deleted) return null;
        const method = customer.invoice_settings.default_payment_method;
        if (method === null) return null;
        const full =
          typeof method === "string" ? await stripe.paymentMethods.retrieve(method) : method;
        return { paymentMethodId: full.id, card: cardOf(full) };
      }),

    portalUrl: ({ customerId, returnUrl }) =>
      call(async () => {
        const session = await stripe.billingPortal.sessions.create({
          customer: customerId,
          return_url: returnUrl,
          ...(config.portalConfigurationId ? { configuration: config.portalConfigurationId } : {}),
        });
        return session.url;
      }),

    readCreditPrice: () =>
      call(async () => {
        const price = await stripe.prices.retrieve(config.creditPriceId);
        return {
          id: price.id,
          unitAmountDecimal:
            price.unit_amount_decimal === null ? null : String(price.unit_amount_decimal),
          currency: price.currency,
          active: price.active,
        };
      }),

    chargePeriod: (charge) =>
      call(async () => {
        const key = periodKey(options.scope, charge.workspaceId, charge.periodStart);
        const periodStart = charge.periodStart.toISOString();
        let invoice = charge.invoiceId
          ? await stripe.invoices.retrieve(charge.invoiceId)
          : await stripe.invoices.create(
              {
                customer: charge.customerId,
                collection_method: "charge_automatically",
                auto_advance: true,
                pending_invoice_items_behavior: "exclude",
                automatic_tax: { enabled: config.tax },
                description: charge.description,
                metadata: marks(charge.workspaceId, { ponzu_period_start: periodStart }),
              },
              { idempotencyKey: `invoice:${key}` },
            );
        await charge.onInvoice(invoice.id);
        // Its one line, marked with the period: added once, whatever crashed before.
        const hasOurLine = (invoice.lines?.data ?? []).some(
          (line) => line.metadata?.ponzu_period_start === periodStart,
        );
        if (invoice.status === "draft" && !hasOurLine) {
          await stripe.invoiceItems.create(
            {
              customer: charge.customerId,
              invoice: invoice.id,
              pricing: { price: config.creditPriceId },
              quantity: charge.credits,
              period: {
                start: Math.floor(charge.periodStart.getTime() / 1000),
                end: Math.floor(charge.periodEnd.getTime() / 1000),
              },
              description: charge.lineDescription,
              metadata: marks(charge.workspaceId, { ponzu_period_start: periodStart }),
            },
            { idempotencyKey: `invoice-item:${key}` },
          );
        }
        if (invoice.status === "draft") {
          invoice = await stripe.invoices.finalizeInvoice(
            invoice.id,
            { auto_advance: true },
            { idempotencyKey: `invoice-finalize:${key}` },
          );
        }
        return invoiceStateOf(invoice);
      }),

    readInvoice: (id) =>
      call(async () =>
        invoiceStateOf(
          await stripe.invoices.retrieve(id, { expand: ["payments.data.payment.payment_intent"] }),
        ),
      ),

    verifyWebhook: (rawBody, signature) =>
      verifyStripeWebhook(rawBody, signature, {
        secret: config.webhookSecret,
        livemode,
        scope: options.scope,
        now: options.clock.now(),
      }),
  };
}

/**
 * Checks a Stripe webhook's signature against its raw body with Stripe's own `constructEvent`
 * (its async form, which works on every runtime the SDK supports), and reads what Ponzu needs
 * from it. FakePayments uses this too, so a test exercises the real check.
 */
export async function verifyStripeWebhook(
  rawBody: string,
  signature: string,
  {
    secret,
    livemode,
    scope,
    now,
  }: {
    secret: string;
    livemode: boolean;
    scope: string;
    /**
     * The API's clock, in epoch ms: a signature more than Stripe's five minutes older than this
     * is refused.
     */
    now: number;
  },
): Promise<StripeEventRef> {
  let event: Stripe.Event;
  try {
    event = await Stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      secret,
      undefined,
      undefined,
      now,
    );
  } catch {
    throw new WebhookSignatureError();
  }
  const object = (event.data?.object ?? {}) as { id?: unknown; metadata?: unknown };
  const metadata =
    object.metadata && typeof object.metadata === "object"
      ? Object.fromEntries(
          Object.entries(object.metadata as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : {};
  const theirScope = metadata.ponzu_scope;
  return {
    id: event.id,
    type: event.type,
    livemode: event.livemode,
    objectId: typeof object.id === "string" ? object.id : null,
    metadata,
    foreign:
      event.livemode !== livemode
        ? "livemode"
        : theirScope !== undefined && theirScope !== scope
          ? "scope"
          : null,
  };
}

/** Signs a webhook body as Stripe would, for tests: Stripe's own test helper. */
export function signTestWebhook(
  payload: string,
  secret: string,
  timestamp?: number,
): Promise<string> {
  return Stripe.webhooks.generateTestHeaderStringAsync({
    payload,
    secret,
    ...(timestamp === undefined ? {} : { timestamp }),
  });
}

// --- the setup script's catalog -------------------------------------------------------------------

/** What the setup script found at Stripe is not what the rate card says. */
export class StripeCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripeCatalogError";
  }
}

/** What the setup script made or found, by id. */
export interface StripeCatalog {
  livemode: boolean;
  productId: string;
  priceId: string;
  portalConfigurationId: string;
  /** Which of the three the run made; the rest it found from a run before. */
  created: ("product" | "price" | "portal")[];
}

/** The credit's price in whole cents, from the rate card people are shown. */
export function creditCents(creditMicrousd: number = PUBLISHED_RATE_CARD.creditMicrousd): number {
  const cents = creditMicrousd / 10_000;
  if (!Number.isInteger(cents) || cents <= 0) {
    throw new Error(`A credit at ${creditMicrousd} µ$ is not a whole number of cents.`);
  }
  return cents;
}

/**
 * Makes the product "Ponzu credits", its one-time price (lookup key `ponzu_credit_v1`, USD, the rate
 * card's cents, tax exclusive) and the customer portal's configuration, unless a run before made
 * them: each is found by its lookup key or its metadata first. A price under the key that differs
 * from the rate card is refused, never changed: a price change is a new price and a new rate card.
 */
export async function ensureStripeCatalog(
  secretKey: string,
  options: { endpoint?: StripeEndpoint } = {},
): Promise<StripeCatalog> {
  const stripe = client(secretKey, options.endpoint);
  const cents = creditCents();
  const created: StripeCatalog["created"] = [];
  return call(async () => {
    const prices = await stripe.prices.list({
      lookup_keys: [CREDIT_PRICE_LOOKUP_KEY],
      active: true,
      limit: 1,
    });
    // Only a price that really carries the key counts (Stripe's filter answers only those).
    let price = prices.data.find((candidate) => candidate.lookup_key === CREDIT_PRICE_LOOKUP_KEY);
    let productId: string;
    if (price) {
      const amount = price.unit_amount_decimal === null ? null : String(price.unit_amount_decimal);
      if (
        price.currency !== "usd" ||
        price.type !== "one_time" ||
        (amount !== null && Number(amount) !== cents) ||
        (amount === null && price.unit_amount !== cents)
      ) {
        throw new StripeCatalogError(
          `The price under ${CREDIT_PRICE_LOOKUP_KEY} (${price.id}) is not ${cents} cents USD one-time. Change nothing at Stripe by hand; make a new rate card and a new price together.`,
        );
      }
      productId = typeof price.product === "string" ? price.product : price.product.id;
    } else {
      let product: Stripe.Product | undefined;
      for await (const candidate of stripe.products.list({ active: true, limit: 100 })) {
        if (candidate.metadata?.ponzu_product === PRODUCT_MARK) {
          product = candidate;
          break;
        }
      }
      if (!product) {
        product = await stripe.products.create(
          { name: "Ponzu credits", metadata: { ponzu_product: PRODUCT_MARK } },
          { idempotencyKey: `stripe-setup:product:${PRODUCT_MARK}` },
        );
        created.push("product");
      }
      productId = product.id;
      price = await stripe.prices.create(
        {
          product: productId,
          currency: "usd",
          unit_amount: cents,
          tax_behavior: "exclusive",
          lookup_key: CREDIT_PRICE_LOOKUP_KEY,
          nickname: "Ponzu credit",
          metadata: { ponzu_rate_card: String(PUBLISHED_RATE_CARD.version) },
        },
        { idempotencyKey: `stripe-setup:price:${CREDIT_PRICE_LOOKUP_KEY}` },
      );
      created.push("price");
    }

    let portal: Stripe.BillingPortal.Configuration | undefined;
    for await (const candidate of stripe.billingPortal.configurations.list({
      active: true,
      limit: 100,
    })) {
      if (candidate.metadata?.ponzu_portal === PORTAL_MARK) {
        portal = candidate;
        break;
      }
    }
    if (!portal) {
      portal = await stripe.billingPortal.configurations.create(
        {
          name: "Ponzu",
          features: {
            payment_method_update: { enabled: true },
            invoice_history: { enabled: true },
            customer_update: {
              enabled: true,
              allowed_updates: ["email", "address", "name", "tax_id"],
            },
          },
          metadata: { ponzu_portal: PORTAL_MARK },
        },
        { idempotencyKey: `stripe-setup:portal:${PORTAL_MARK}` },
      );
      created.push("portal");
    }
    return {
      livemode: isLiveKey(secretKey),
      productId,
      priceId: price.id,
      portalConfigurationId: portal.id,
      created,
    };
  });
}
