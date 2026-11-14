/*
 * The real `stripePayments().chargePeriod`, through the real SDK, against a small Stripe that keeps
 * state (stripe-mock answers fixtures and keeps none, so it cannot show what a retry does). The
 * small Stripe acts what matters here: idempotency keys it can forget, a draft invoice's lines, and
 * Stripe finalizing a draft by itself about an hour after it is made when `auto_advance` is on. A
 * close crashed after each Stripe step, and run again a day later with the stored invoice id, must
 * leave exactly one invoice with exactly one line.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { FakeClock } from "@ponzu/sandbox";
import { PaymentsError, type PeriodCharge, stripePayments } from "./payments.ts";

interface Invoice {
  id: string;
  object: "invoice";
  status: "draft" | "open";
  auto_advance: boolean;
  metadata: Record<string, string>;
  lines: { object: "list"; data: { id: string; metadata: Record<string, string> }[] };
}

type Step = "invoice" | "item" | "finalize";

/** Stripe, as much of it as one period's charge reaches. */
class SmallStripe {
  invoices = new Map<string, Invoice>();
  keys = new Map<string, unknown>();
  /** `auto_advance` as each invoice was made with. */
  madeWith: boolean[] = [];
  /** The next request of this step takes effect, then the answer is lost. */
  crashAfter: Step | null = null;
  #next = 0;

  reset() {
    this.invoices.clear();
    this.keys.clear();
    this.madeWith = [];
    this.crashAfter = null;
  }

  /** What Stripe does to a draft with auto_advance on, about an hour after it is made. */
  autoFinalizeDrafts() {
    for (const invoice of this.invoices.values()) {
      if (invoice.status === "draft" && invoice.auto_advance) invoice.status = "open";
    }
  }

  async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const form = new URLSearchParams(request.method === "POST" ? await request.text() : "");
    const key = request.headers.get("idempotency-key");
    const step: Step | null =
      request.method !== "POST"
        ? null
        : path === "/v1/invoices"
          ? "invoice"
          : path === "/v1/invoiceitems"
            ? "item"
            : path.endsWith("/finalize")
              ? "finalize"
              : null;
    const answer = (() => {
      if (key && this.keys.has(key)) return this.keys.get(key);
      const made = this.#apply(request.method, path, form);
      if (key && made) this.keys.set(key, made);
      return made;
    })();
    if (!answer)
      return Response.json({ error: { type: "invalid_request_error" } }, { status: 404 });
    if (step && this.crashAfter === step) {
      this.crashAfter = null;
      return Response.json(
        { error: { type: "invalid_request_error", code: "crashed" } },
        { status: 400 },
      );
    }
    return Response.json(answer);
  }

  #apply(method: string, path: string, form: URLSearchParams): unknown {
    const metadata = (prefix: string) =>
      Object.fromEntries(
        [...form.entries()]
          .filter(([name]) => name.startsWith(`${prefix}[`))
          .map(([name, value]) => [name.slice(prefix.length + 1, -1), value]),
      );
    if (method === "POST" && path === "/v1/invoices") {
      const id = `in_small${++this.#next}`;
      const invoice: Invoice = {
        id,
        object: "invoice",
        status: "draft",
        auto_advance: form.get("auto_advance") === "true",
        metadata: metadata("metadata"),
        lines: { object: "list", data: [] },
      };
      this.invoices.set(id, invoice);
      this.madeWith.push(invoice.auto_advance);
      return invoice;
    }
    if (method === "POST" && path === "/v1/invoiceitems") {
      const invoice = this.invoices.get(form.get("invoice") ?? "");
      if (!invoice || invoice.status !== "draft") return null;
      const item = { id: `ii_small${++this.#next}`, metadata: metadata("metadata") };
      invoice.lines.data.push(item);
      return { ...item, object: "invoiceitem" };
    }
    const finalize = path.match(/^\/v1\/invoices\/([^/]+)\/finalize$/);
    if (method === "POST" && finalize) {
      const invoice = this.invoices.get(finalize[1]!);
      if (!invoice) return null;
      invoice.status = "open";
      invoice.auto_advance = form.get("auto_advance") === "true";
      return invoice;
    }
    const read = path.match(/^\/v1\/invoices\/([^/]+)$/);
    if (method === "GET" && read) return this.invoices.get(read[1]!) ?? null;
    return null;
  }
}

const small = new SmallStripe();
let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => small.handle(request) });
});
afterAll(() => server.stop(true));
beforeEach(() => small.reset());

const payments = () =>
  stripePayments(
    {
      secretKey: "sk_test_small",
      webhookSecret: "whsec_small",
      creditPriceId: "price_small",
      portalConfigurationId: null,
      tax: false,
    },
    {
      scope: "7e57000000a0",
      clock: new FakeClock(),
      endpoint: { host: "127.0.0.1", port: server.port!, protocol: "http" },
    },
  );

/** The close's row: the stored invoice id, as setPeriodInvoice keeps it. */
function close() {
  let stored: string | null = null;
  const charge = (onInvoice?: PeriodCharge["onInvoice"]) =>
    payments().chargePeriod({
      workspaceId: "ws_1",
      periodStart: new Date("2026-10-13T00:00:00Z"),
      periodEnd: new Date("2026-11-13T00:00:00Z"),
      customerId: "cus_1",
      credits: 1500,
      description: "d",
      lineDescription: "l",
      invoiceId: stored,
      onInvoice:
        onInvoice ??
        (async (id) => {
          stored ??= id;
        }),
    });
  return { charge, stored: () => stored };
}

function onlyInvoice() {
  expect(small.invoices.size).toBe(1);
  const [invoice] = [...small.invoices.values()];
  return invoice!;
}

test("the invoice is made without automatic collection, and finalized with it", async () => {
  const { charge } = close();
  await charge();
  expect(small.madeWith).toEqual([false]);
  const invoice = onlyInvoice();
  expect(invoice).toMatchObject({ status: "open", auto_advance: true });
  expect(invoice.lines.data).toHaveLength(1);
});

test("crashed before the id was stored, run again inside a day: one invoice, one line", async () => {
  const { charge, stored } = close();
  await expect(
    charge(async () => {
      throw new Error("the database went away");
    }),
  ).rejects.toThrow("the database went away");
  expect(stored()).toBeNull();
  await charge();
  expect(onlyInvoice()).toMatchObject({ status: "open" });
  expect(onlyInvoice().lines.data).toHaveLength(1);
});

test("a failure to store the id comes out as the caller's own error, not Stripe's", async () => {
  const { charge } = close();
  const failure = new Error("the database went away");
  const thrown = await charge(async () => {
    throw failure;
  }).catch((error: unknown) => error);
  expect(thrown).toBe(failure);
  expect(thrown).not.toBeInstanceOf(PaymentsError);
});

for (const step of ["item", "finalize"] as const) {
  test(`crashed after the ${step}, run again a day later: one invoice, one line`, async () => {
    const { charge, stored } = close();
    small.crashAfter = step;
    await expect(charge()).rejects.toBeInstanceOf(PaymentsError);
    expect(stored()).not.toBeNull();
    small.keys.clear();
    small.autoFinalizeDrafts();
    await charge();
    const invoice = onlyInvoice();
    expect(invoice.status).toBe("open");
    expect(invoice.lines.data).toHaveLength(1);
  });
}

test("crashed after the invoice was stored, run again hours later: the line is still added", async () => {
  const { charge, stored } = close();
  let kept: string | null = null;
  // The id is stored, then the process dies before the line.
  await expect(
    charge(async (id) => {
      kept = id;
      throw new Error("killed");
    }),
  ).rejects.toThrow("killed");
  expect(stored()).toBeNull();
  // Stripe's hour passes (a draft with automatic collection on would be finalized empty here),
  // and its keys are forgotten a day later.
  small.autoFinalizeDrafts();
  small.keys.clear();
  const again = payments().chargePeriod({
    workspaceId: "ws_1",
    periodStart: new Date("2026-10-13T00:00:00Z"),
    periodEnd: new Date("2026-11-13T00:00:00Z"),
    customerId: "cus_1",
    credits: 1500,
    description: "d",
    lineDescription: "l",
    invoiceId: kept,
    onInvoice: async () => {},
  });
  await expect(again).resolves.toMatchObject({ id: kept!, status: "open", lineCount: 1 });
  expect(onlyInvoice().lines.data).toHaveLength(1);
});

test("an invoice finalized without the period's line is refused, never taken as charged", async () => {
  const { charge } = close();
  await expect(
    charge(async () => {
      throw new Error("killed");
    }),
  ).rejects.toThrow("killed");
  const [invoice] = [...small.invoices.values()];
  // Finalized by hand at Stripe, empty.
  invoice!.status = "open";
  const thrown = await payments()
    .chargePeriod({
      workspaceId: "ws_1",
      periodStart: new Date("2026-10-13T00:00:00Z"),
      periodEnd: new Date("2026-11-13T00:00:00Z"),
      customerId: "cus_1",
      credits: 1500,
      description: "d",
      lineDescription: "l",
      invoiceId: invoice!.id,
      onInvoice: async () => {},
    })
    .catch((error: unknown) => error);
  expect(thrown).toBeInstanceOf(PaymentsError);
  expect(thrown).toMatchObject({ type: "invoice_without_line", unavailable: false });
});
