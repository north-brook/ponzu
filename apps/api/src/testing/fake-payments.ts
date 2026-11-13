import type { Clock } from "@ponzu/sandbox";
import {
  type Card,
  type InvoiceState,
  type Payments,
  PaymentsError,
  PaymentsOffError,
  type PeriodCharge,
  type StripeEventRef,
  signTestWebhook,
  verifyStripeWebhook,
} from "../deps/payments.ts";

/** The webhook secret the test app's FakePayments signs with. Nothing secret. */
export const TEST_STRIPE_WEBHOOK_SECRET = "whsec_test_fake_payments_secret";

/** Every method of the seam, by name: what `calls` records and `failNext` aims at. */
export type PaymentsMethod = Exclude<keyof Payments, "enabled" | "livemode">;

/** The Stripe steps of one period's charge, in order. */
export type ChargeStep = "invoice" | "item" | "finalize";

interface FakeSession {
  id: string;
  setupId: string;
  workspaceId: string;
  customerId: string;
  status: "open" | "complete" | "expired";
  paymentMethodId: string | null;
  url: string;
  expiresAt: Date;
}

interface FakeInvoice extends InvoiceState {
  customerId: string;
  lines: { quantity: number; description: string; periodStart: string }[];
}

/**
 * Payments in memory, with Ponzu's own clock. It keeps customers, Checkout sessions, cards and
 * invoices the way Stripe would answer about them, records every call (`calls`), and lets a test
 * act Stripe's part: `completeSetup`, `expireSetup`, `payInvoice`, `failInvoice`, `requireAction`.
 * `failNext` makes the next call of a method throw, before or after its effect, which is how a
 * test crashes the close between Stripe calls. `webhookFor` signs a payload with Stripe's own
 * test helper, and `verifyWebhook` checks it with Stripe's own `constructEvent`, so the signature
 * path a test drives is the real one.
 *
 * `enabled: false` acts out billing not being on: every call is still recorded, then throws
 * `PaymentsOffError` as `noPayments` does, so a test can show that nothing asked.
 */
export class FakePayments implements Payments {
  readonly #enabled: () => boolean;
  readonly livemode: boolean;
  readonly webhookSecret: string;
  readonly scope: string;
  /** Every call, oldest first, whether it succeeded or not. */
  readonly calls: { method: PaymentsMethod; args: unknown[] }[] = [];
  readonly customers = new Map<
    string,
    { workspaceId: string; name: string; email: string | null; defaultPaymentMethod: string | null }
  >();
  readonly sessions = new Map<string, FakeSession>();
  readonly cards = new Map<string, Card>();
  readonly invoices = new Map<string, FakeInvoice>();
  /** The credit price, as `readCreditPrice` answers it: 10 cents unless a test says otherwise. */
  creditPrice = {
    id: "price_fake",
    unitAmountDecimal: "10" as string | null,
    currency: "usd",
    active: true,
  };
  readonly #clock: Clock;
  readonly #failures: { method: PaymentsMethod; when: "before" | "after"; error: Error }[] = [];
  readonly #chargeCrashes: { step: ChargeStep; error: Error }[] = [];
  readonly #idempotency = new Map<string, string>();
  #next = 0;

  constructor({
    clock,
    enabled = true,
    livemode = false,
    webhookSecret = TEST_STRIPE_WEBHOOK_SECRET,
    scope = "7e57000000a0",
  }: {
    clock: Clock;
    /** Whether billing is on; a function is asked at every call, so a test may switch it. */
    enabled?: boolean | (() => boolean);
    livemode?: boolean;
    webhookSecret?: string;
    scope?: string;
  }) {
    this.#clock = clock;
    this.#enabled = typeof enabled === "function" ? enabled : () => enabled;
    this.livemode = livemode;
    this.webhookSecret = webhookSecret;
    this.scope = scope;
  }

  get enabled(): boolean {
    return this.#enabled();
  }

  /**
   * The next call of `method` throws `error`: `before` it has any effect (Stripe refused it, or
   * was never reached), or `after` it took effect (the answer was lost: a crash right after).
   */
  failNext(method: PaymentsMethod, error: Error, when: "before" | "after" = "before"): void {
    this.#failures.push({ method, when, error });
  }

  /**
   * The next `chargePeriod` crashes right after one of its Stripe steps took effect: the invoice
   * was made (before `onInvoice` hears of it), its line was added, or it was finalized. This is
   * how a test crashes the close between Stripe's calls.
   */
  crashChargeAfter(step: ChargeStep, error: Error = new Error(`crashed after ${step}`)): void {
    this.#chargeCrashes.push({ step, error });
  }

  /** How many calls of a method were made. */
  count(method: PaymentsMethod): number {
    return this.calls.filter((call) => call.method === method).length;
  }

  // --- acting Stripe's part ---------------------------------------------------------------------

  /** The admin finished Checkout: the session is complete with a new card. Answers its id. */
  completeSetup(sessionId: string, card: Card = { brand: "visa", last4: "4242" }): string {
    const session = this.#session(sessionId);
    const paymentMethodId = this.#id("pm");
    this.cards.set(paymentMethodId, card);
    session.status = "complete";
    session.paymentMethodId = paymentMethodId;
    return paymentMethodId;
  }

  expireSetup(sessionId: string): void {
    this.#session(sessionId).status = "expired";
  }

  payInvoice(id: string): void {
    const invoice = this.#invoice(id);
    invoice.status = "paid";
    invoice.attemptCount += 1;
    invoice.amountDueCents = 0;
    invoice.needsAction = false;
    invoice.nextPaymentAttemptAt = null;
  }

  failInvoice(id: string, nextAttemptAt: Date | null = null): void {
    const invoice = this.#invoice(id);
    invoice.status = "open";
    invoice.attemptCount += 1;
    invoice.needsAction = false;
    invoice.nextPaymentAttemptAt = nextAttemptAt;
  }

  requireAction(id: string): void {
    const invoice = this.#invoice(id);
    invoice.status = "open";
    invoice.attemptCount += 1;
    invoice.needsAction = true;
  }

  /** Signs a webhook event as Stripe would send it: its body and its `Stripe-Signature`. */
  async webhookFor(event: {
    id?: string;
    type: string;
    object: Record<string, unknown>;
    livemode?: boolean;
  }): Promise<{ body: string; signature: string }> {
    const body = JSON.stringify({
      id: event.id ?? this.#id("evt"),
      object: "event",
      api_version: "2026-10-28.endive",
      created: Math.floor(this.#clock.now() / 1000),
      type: event.type,
      livemode: event.livemode ?? this.livemode,
      data: { object: event.object },
    });
    const signature = await signTestWebhook(
      body,
      this.webhookSecret,
      Math.floor(this.#clock.now() / 1000),
    );
    return { body, signature };
  }

  // --- the seam ---------------------------------------------------------------------------------

  ensureCustomer(i: Parameters<Payments["ensureCustomer"]>[0]) {
    return this.#call("ensureCustomer", [i], () => {
      const id = this.#once(`customer:${this.scope}:${i.workspaceId}`, () => {
        const made = this.#id("cus");
        this.customers.set(made, {
          workspaceId: i.workspaceId,
          name: i.name,
          email: i.email,
          defaultPaymentMethod: null,
        });
        return made;
      });
      return { customerId: id };
    });
  }

  startCardSetup(i: Parameters<Payments["startCardSetup"]>[0]) {
    return this.#call("startCardSetup", [i], () => {
      const id = this.#once(`checkout:${this.scope}:${i.setupId}`, () => {
        const made = this.#id("cs_test");
        this.sessions.set(made, {
          id: made,
          setupId: i.setupId,
          workspaceId: i.workspaceId,
          customerId: i.customerId,
          status: "open",
          paymentMethodId: null,
          url: `https://checkout.stripe.test/c/pay/${made}`,
          expiresAt: i.expiresAt,
        });
        return made;
      });
      const session = this.#session(id);
      return { sessionId: session.id, url: session.url };
    });
  }

  readCardSetup(sessionId: string) {
    return this.#call("readCardSetup", [sessionId], () => {
      const session = this.#session(sessionId);
      if (session.status === "open" && this.#clock.now() >= session.expiresAt.getTime()) {
        session.status = "expired";
      }
      return { status: session.status, paymentMethodId: session.paymentMethodId };
    });
  }

  useCard(i: { customerId: string; paymentMethodId: string }) {
    return this.#call("useCard", [i], () => {
      const customer = this.#customer(i.customerId);
      const card = this.cards.get(i.paymentMethodId);
      if (!card) throw this.#stripeError(404, "resource_missing");
      customer.defaultPaymentMethod = i.paymentMethodId;
      return card;
    });
  }

  readDefaultCard(customerId: string) {
    return this.#call("readDefaultCard", [customerId], () => {
      const method = this.#customer(customerId).defaultPaymentMethod;
      if (method === null) return null;
      return { paymentMethodId: method, card: this.cards.get(method)! };
    });
  }

  /** Acts out the admin removing the card in the portal. */
  detachCard(customerId: string): void {
    this.#customer(customerId).defaultPaymentMethod = null;
  }

  portalUrl(i: { customerId: string; returnUrl: string }) {
    return this.#call("portalUrl", [i], () => {
      this.#customer(i.customerId);
      return `https://billing.stripe.test/p/session/${this.#id("bps")}`;
    });
  }

  readCreditPrice() {
    return this.#call("readCreditPrice", [], () => ({ ...this.creditPrice }));
  }

  chargePeriod(charge: PeriodCharge) {
    return this.#call("chargePeriod", [charge], async () => {
      const periodStart = charge.periodStart.toISOString();
      const key = `${this.scope}:${charge.workspaceId}:${periodStart}`;
      const crash = (step: ChargeStep) => {
        const index = this.#chargeCrashes.findIndex((crash) => crash.step === step);
        if (index !== -1) throw this.#chargeCrashes.splice(index, 1)[0]!.error;
      };
      const id =
        charge.invoiceId ??
        this.#once(`invoice:${key}`, () => {
          const made = this.#id("in");
          this.invoices.set(made, {
            id: made,
            customerId: charge.customerId,
            status: "draft",
            amountDueCents: 0,
            totalCents: 0,
            taxCents: 0,
            attemptCount: 0,
            nextPaymentAttemptAt: null,
            hostedInvoiceUrl: null,
            number: null,
            lineCount: 0,
            needsAction: false,
            metadata: {
              ponzu_workspace_id: charge.workspaceId,
              ponzu_scope: this.scope,
              ponzu_period_start: periodStart,
            },
            lines: [],
          });
          return made;
        });
      crash("invoice");
      await charge.onInvoice(id);
      const invoice = this.#invoice(id);
      const hasOurLine = invoice.lines.some((l) => l.periodStart === periodStart);
      if (invoice.status !== "draft" && !hasOurLine) {
        throw new PaymentsError({
          type: "invoice_without_line",
          code: null,
          status: 200,
          requestId: null,
        });
      }
      if (invoice.status === "draft" && !hasOurLine) {
        this.#once(`invoice-item:${key}`, () => {
          invoice.lines.push({
            quantity: charge.credits,
            description: charge.lineDescription,
            periodStart,
          });
          invoice.lineCount = invoice.lines.length;
          return "added";
        });
        crash("item");
      }
      if (invoice.status === "draft") {
        const cents = Number(this.creditPrice.unitAmountDecimal ?? "0");
        const total = invoice.lines.reduce((sum, line) => sum + line.quantity * cents, 0);
        invoice.status = "open";
        invoice.totalCents = total;
        invoice.amountDueCents = total;
        invoice.number = `PONZU-${String(++this.#next).padStart(4, "0")}`;
        invoice.hostedInvoiceUrl = `https://invoice.stripe.test/i/${id}`;
        crash("finalize");
      }
      return this.#state(invoice);
    });
  }

  readInvoice(id: string) {
    return this.#call("readInvoice", [id], () => this.#state(this.#invoice(id)));
  }

  verifyWebhook(rawBody: string, signature: string): Promise<StripeEventRef> {
    return this.#call("verifyWebhook", [rawBody, signature], () =>
      verifyStripeWebhook(rawBody, signature, {
        secret: this.webhookSecret,
        livemode: this.livemode,
        scope: this.scope,
        now: this.#clock.now(),
      }),
    );
  }

  // --- inside -----------------------------------------------------------------------------------

  async #call<T>(method: PaymentsMethod, args: unknown[], work: () => T | Promise<T>): Promise<T> {
    this.calls.push({ method, args });
    if (!this.enabled) throw new PaymentsOffError();
    const failure = this.#takeFailure(method);
    if (failure?.when === "before") throw failure.error;
    const answer = await work();
    if (failure?.when === "after") throw failure.error;
    return answer;
  }

  #takeFailure(method: PaymentsMethod) {
    const index = this.#failures.findIndex((failure) => failure.method === method);
    return index === -1 ? undefined : this.#failures.splice(index, 1)[0];
  }

  /** Stripe's idempotency: the same key gives the same object, made once. */
  #once(key: string, make: () => string): string {
    const known = this.#idempotency.get(key);
    if (known) return known;
    const made = make();
    this.#idempotency.set(key, made);
    return made;
  }

  /** Forgets every idempotency key, as Stripe does after about a day. */
  forgetIdempotencyKeys(): void {
    this.#idempotency.clear();
  }

  #id(prefix: string): string {
    return `${prefix}_fake${String(++this.#next).padStart(6, "0")}`;
  }

  #session(id: string): FakeSession {
    const session = this.sessions.get(id);
    if (!session) throw this.#stripeError(404, "resource_missing");
    return session;
  }

  #customer(id: string) {
    const customer = this.customers.get(id);
    if (!customer) throw this.#stripeError(404, "resource_missing");
    return customer;
  }

  #invoice(id: string): FakeInvoice {
    const invoice = this.invoices.get(id);
    if (!invoice) throw this.#stripeError(404, "resource_missing");
    return invoice;
  }

  #state(invoice: FakeInvoice): InvoiceState {
    const { customerId: _customer, lines: _lines, ...state } = invoice;
    return structuredClone(state);
  }

  #stripeError(status: number, code: string): PaymentsError {
    return new PaymentsError({ type: "invalid_request_error", code, status, requestId: null });
  }
}
