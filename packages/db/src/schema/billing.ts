import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import {
  BILLING_PERIOD_STATUSES,
  INVOICED_PERIOD_STATUSES,
  LEDGER_REASONS,
  USAGE_KINDS,
  USAGE_PAYERS,
} from "../enums.ts";
import { users, workspaces } from "./accounts.ts";
import { canvases } from "./canvases.ts";
import { createdAt, instant, oneOf, updatedAt } from "./columns.ts";

/** What a model costs us, in millionths of a dollar per million tokens. */
export interface ModelRate {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Credits carry four decimal places: awake time is metered by the second. */
const credits = (name: string) => numeric(name, { precision: 14, scale: 4, mode: "number" });

/**
 * The numbers the credit model runs on, by version, so a price change is a new row and every
 * usage event says which card priced it.
 */
export const rateCards = pgTable("rate_cards", {
  version: integer("version").primaryKey(),
  effectiveFrom: instant("effective_from").notNull(),
  /** What one credit sells for, in millionths of a dollar. */
  creditMicrousd: integer("credit_microusd").notNull(),
  sandboxCreditsPerAwakeHour: credits("sandbox_credits_per_awake_hour").notNull(),
  freeCreditsPerMember: credits("free_credits_per_member").notNull(),
  defaultCapCents: integer("default_cap_cents").notNull(),
  capWarningFraction: numeric("cap_warning_fraction", {
    precision: 4,
    scale: 3,
    mode: "number",
  }).notNull(),
  idleSleepSeconds: integer("idle_sleep_seconds").notNull(),
  /** By model id. */
  modelRates: jsonb("model_rates").$type<Record<string, ModelRate>>().notNull().default({}),
  createdAt: createdAt(),
});

/** One metered thing: a stretch of awake sandbox time, or one model turn. */
export const usageEvents = pgTable(
  "usage_events",
  {
    /** Chosen by the writer, so a retried report is counted once. */
    id: text("id").primaryKey(),
    // Billing history is kept: a workspace with usage cannot be deleted from under it.
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    canvasId: text("canvas_id").references(() => canvases.id, { onDelete: "set null" }),
    /** Who the usage is put down to. */
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    kind: text("kind", { enum: USAGE_KINDS }).notNull(),
    /** Awake seconds, for a sandbox event. */
    seconds: integer("seconds"),
    model: text("model"),
    inputTokens: bigint("input_tokens", { mode: "number" }),
    outputTokens: bigint("output_tokens", { mode: "number" }),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }),
    cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }),
    /** What it cost, or would have cost had Ponzu paid for the model. */
    costMicrousd: bigint("cost_microusd", { mode: "number" }).notNull().default(0),
    credits: credits("credits").notNull().default(0),
    payer: text("payer", { enum: USAGE_PAYERS }).notNull(),
    rateCardVersion: integer("rate_card_version")
      .notNull()
      .references(() => rateCards.version, { onDelete: "restrict" }),
    occurredAt: instant("occurred_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("usage_events_workspace_id_occurred_at_idx").on(t.workspaceId, t.occurredAt),
    // Deleting a canvas clears it from its usage; without this that reads the whole table.
    index("usage_events_canvas_id_idx").on(t.canvasId),
    check("usage_events_kind_check", oneOf(t.kind, USAGE_KINDS)),
    check("usage_events_payer_check", oneOf(t.payer, USAGE_PAYERS)),
    check("usage_events_seconds_check", sql`(${t.kind} = 'sandbox') = (${t.seconds} is not null)`),
    check("usage_events_model_check", sql`(${t.kind} = 'model') = (${t.model} is not null)`),
    check("usage_events_credits_check", sql`${t.credits} >= 0`),
  ],
);

/** Every change to a workspace's credits. The balance is the sum. */
export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    /** Credits in (a grant, a top-up) or out (use). */
    delta: credits("delta").notNull(),
    reason: text("reason", { enum: LEDGER_REASONS }).notNull(),
    /** The billing period it counts in. Free credits do not roll over. */
    periodStart: instant("period_start").notNull(),
    /** For a grant, the member whose monthly allowance it is. */
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    /** For use, the event that spent it. */
    usageEventId: text("usage_event_id")
      .unique()
      .references(() => usageEvents.id, { onDelete: "restrict" }),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [
    index("credit_ledger_workspace_id_period_start_idx").on(t.workspaceId, t.periodStart),
    // A member's allowance is granted once a period, however many requests race to grant it.
    uniqueIndex("credit_ledger_grant_key")
      .on(t.workspaceId, t.periodStart, t.userId)
      .where(sql`${t.reason} = 'grant'`),
    check("credit_ledger_reason_check", oneOf(t.reason, LEDGER_REASONS)),
    check(
      "credit_ledger_delta_check",
      sql`case ${t.reason} when 'use' then ${t.delta} < 0 when 'adjustment' then ${t.delta} <> 0 else ${t.delta} > 0 end`,
    ),
    check(
      "credit_ledger_usage_event_id_check",
      sql`(${t.reason} = 'use') = (${t.usageEventId} is not null)`,
    ),
  ],
);

/**
 * One closed billing period of a workspace: its numbers frozen at the close, and what became of
 * them (docs/cloud.md, "Billing"). Written only while PONZU_BILLING is observe or on; a period
 * closed while billing is not on is `unbilled` for good. A period has at most one invoice at
 * Stripe, and the `stripe_invoice_id` stored here is what keeps it to one: Stripe forgets an
 * idempotency key after about a day, and this row does not. The id may be stored while the
 * period is still `closing` (the invoice is made, its line or its finalizing is not done yet).
 */
export const billingPeriods = pgTable(
  "billing_periods",
  {
    // Billing history is kept: a workspace with a closed period cannot be deleted from under it.
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    periodStart: instant("period_start").notNull(),
    periodEnd: instant("period_end").notNull(),
    status: text("status", { enum: BILLING_PERIOD_STATUSES }).notNull().default("closing"),
    // The numbers, frozen at the close: whole credits and cents.
    usedCredits: integer("used_credits").notNull(),
    freeCredits: integer("free_credits").notNull(),
    billedCredits: integer("billed_credits").notNull(),
    /** What is charged: the billed credits, never more than the cap allows. */
    chargedCredits: integer("charged_credits").notNull(),
    chargedCents: integer("charged_cents").notNull(),
    capCents: integer("cap_cents").notNull(),
    people: integer("people").notNull(),
    rateCardVersion: integer("rate_card_version")
      .notNull()
      .references(() => rateCards.version, { onDelete: "restrict" }),
    // The invoice at Stripe, once there is one.
    stripeInvoiceId: text("stripe_invoice_id").unique(),
    invoiceNumber: text("invoice_number"),
    hostedInvoiceUrl: text("hosted_invoice_url"),
    taxCents: integer("tax_cents"),
    totalCents: integer("total_cents"),
    /** How many times Stripe has tried to collect it, and when it tries next. */
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: instant("next_attempt_at"),
    closedAt: instant("closed_at").notNull().defaultNow(),
    invoicedAt: instant("invoiced_at"),
    paidAt: instant("paid_at"),
    failedAt: instant("failed_at"),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.periodStart] }),
    // The webhook and the close look for periods whose invoice is not settled yet.
    index("billing_periods_unsettled_idx")
      .on(t.status)
      .where(sql`${t.status} in ('invoiced', 'payment_failed')`),
    check("billing_periods_status_check", oneOf(t.status, BILLING_PERIOD_STATUSES)),
    check("billing_periods_span_check", sql`${t.periodEnd} > ${t.periodStart}`),
    check(
      "billing_periods_numbers_check",
      sql`${t.usedCredits} >= 0 and ${t.freeCredits} >= 0 and ${t.billedCredits} >= 0 and ${t.chargedCredits} >= 0 and ${t.chargedCredits} <= ${t.billedCredits} and ${t.chargedCents} >= 0 and ${t.chargedCents} <= ${t.capCents} and ${t.people} >= 0 and ${t.attempts} >= 0`,
    ),
    // A period whose status says it has an invoice at Stripe names it.
    check(
      "billing_periods_invoice_check",
      sql`${t.status} not in (${sql.raw(INVOICED_PERIOD_STATUSES.map((status) => `'${status}'`).join(", "))}) or ${t.stripeInvoiceId} is not null`,
    ),
  ],
);
