import {
  beginPeriodClose,
  type BillingPeriod as ClosedPeriod,
  cutAwake,
  dueClosings,
  getWorkspace,
  listAwakeToMeter,
  listUnscheduledClosings,
  periodHasActivity,
  readWorkspaceUsage,
  scheduleClosings,
  setNextClose,
  setPeriodInvoice,
  settleUncharged,
  type Workspace,
} from "@ponzu/db";
import { z } from "zod";
import { creditCents } from "../deps/payments.ts";
import type { RunNowDeps } from "../jobs/run.ts";
import { runNow } from "../jobs/run.ts";
import { chargedCents, chargedCredits, MIN_INVOICE_CENTS } from "./credits.ts";
import { applyInvoice } from "./invoices.ts";
import { nextCut } from "./meter.ts";
import { type BillingPeriod, billingPeriod } from "./period.ts";
import { type RefreshDeps, refreshBillingGate } from "./refresh.ts";
import { workspaceUsage } from "./usage.ts";

/*
 * The period close (docs/cloud.md, "Billing", "The period close"). Ten minutes or more after a
 * workspace's period ends, the minute's cron records a `billing_close` job for it, and the job:
 *
 *   1. cuts the workspace's awake stretches at the period's end (the meter has, normally);
 *   2. reads the period's usage, counting the members who joined before its end, and works out
 *      what is billed and what is charged: never more than the cap in effect now;
 *   3. freezes those numbers in `billing_periods`, once (a second close gets the first's);
 *   4. settles it: `unbilled` while billing is not on (or when the close comes days after the
 *      period ended: billing was off meanwhile), `waived` under $1 or with no card, otherwise
 *      one invoice with one line at Stripe, charged to the card;
 *   5. moves the workspace's next close to the next period's end;
 *   6. works the gate out again, which wakes what the old period's limits held back.
 *
 * Every step is safe to run again after a crash at any point: the numbers are frozen once, the
 * invoice's id is stored as soon as Stripe makes it and is never made again, and its line is
 * added only when it has none (`chargePeriod`). Ponzu never charges above the cap, and never
 * charges a period whose numbers were frozen while billing was not on.
 *
 * While PONZU_BILLING is off none of this runs: the cron step is not run at all, and a job left
 * from before does nothing. In observe periods close as `unbilled` and nothing reaches Stripe.
 */

/** The job that closes one period. */
export const CLOSE_JOB = "billing_close";
/** Its attempts: with the retry waits doubling from a minute, a little over two hours. */
export const CLOSE_JOB_ATTEMPTS = 8;
/** How long after a period ends it is closed, so the meter's cut and late sleeps land first. */
export const CLOSE_DELAY_MS = 10 * 60_000;
/** A close that failed for good is tried again this long after. */
export const RETRY_FAILED_CLOSE_MS = 24 * 60 * 60_000;
/**
 * A period first closed this long after it ended is not billed: billing was off (or the cron was
 * down) meanwhile, and a period closed while billing was off is never billed later.
 */
export const LATE_CLOSE_MS = 2 * 24 * 60 * 60_000;
/** Workspaces whose next close is worked out in one run, at most. */
export const SCHEDULED_PER_RUN = 200;
/** Periods whose close one run records, at most. */
export const CLOSES_PER_RUN = 20;

const CloseJob = z.object({
  workspaceId: z.string(),
  periodStart: z.coerce.date(),
  periodEnd: z.coerce.date(),
  /** The workspace's next close as the cron found it: the close moves it on only from this. */
  closeAt: z.coerce.date(),
});
export type CloseJobPayload = z.infer<typeof CloseJob>;

/** A close's job key: one close of a period waits at a time. */
export const closeKey = (workspaceId: string, periodStart: Date) =>
  `${workspaceId}:${periodStart.toISOString()}`;

/** The period that ends at `end` for a workspace anchored at `anchor`. */
export function periodEndingAt(anchor: Date, end: Date): BillingPeriod {
  return billingPeriod(anchor, new Date(end.getTime() - 1));
}

/**
 * The cron's part: work out the next close of workspaces that have none yet (the end of the
 * period running now, so a period is billed only from the one billing was turned on in), move
 * past periods with nothing in them, and record a close for each period due. Answers counts.
 */
export async function closeDuePeriods(
  deps: RunNowDeps,
  now: Date,
): Promise<{ scheduled: number; queued: number; skipped: number }> {
  if (deps.features.billing === "off") return { scheduled: 0, queued: 0, skipped: 0 };
  const unscheduled = await listUnscheduledClosings(deps.db, { limit: SCHEDULED_PER_RUN });
  const scheduled = await scheduleClosings(
    deps.db,
    unscheduled.map((row) => ({
      workspaceId: row.workspaceId,
      at: billingPeriod(row.billingPeriodAnchor, now).end,
    })),
  );
  const due = await dueClosings(deps.db, {
    before: new Date(now.getTime() - CLOSE_DELAY_MS),
    limit: CLOSES_PER_RUN,
    jobKind: CLOSE_JOB,
    failedSince: new Date(now.getTime() - RETRY_FAILED_CLOSE_MS),
  });
  let queued = 0;
  let skipped = 0;
  for (const row of due) {
    try {
      const period = periodEndingAt(row.billingPeriodAnchor, row.nextCloseAt);
      const active = await periodHasActivity(deps.db, {
        workspaceId: row.workspaceId,
        start: period.start,
        end: period.end,
      });
      if (!active) {
        // Nothing used, nothing awake, no card: nothing to record. On to the next period.
        const next = billingPeriod(row.billingPeriodAnchor, period.end).end;
        const moved = await setNextClose(deps.db, {
          workspaceId: row.workspaceId,
          at: next,
          ifAt: row.nextCloseAt,
        });
        if (moved) skipped++;
        continue;
      }
      const recorded = await runNow(deps, {
        kind: CLOSE_JOB,
        key: closeKey(row.workspaceId, period.start),
        payload: {
          workspaceId: row.workspaceId,
          periodStart: period.start.toISOString(),
          periodEnd: period.end.toISOString(),
          closeAt: row.nextCloseAt.toISOString(),
        },
        maxAttempts: CLOSE_JOB_ATTEMPTS,
      });
      if (recorded) queued++;
    } catch (error) {
      deps.log.warn("billing_close_failed", { workspaceId: row.workspaceId, error });
      deps.analytics.exception(error, { cron_step: "close_periods" });
    }
  }
  return { scheduled, queued, skipped };
}

/** The `billing_close` job. */
export async function runCloseJob(deps: RefreshDeps, stored: unknown): Promise<void> {
  const job = CloseJob.parse(stored);
  if (deps.features.billing === "off") {
    // Billing was turned off after the close was recorded: nothing is read or written now.
    deps.log.info("billing_close_skipped", { workspaceId: job.workspaceId, reason: "billing_off" });
    return;
  }
  await closePeriod(deps, job);
}

/** Close one period, from wherever a close before it stopped. Answers the period as it ends. */
export async function closePeriod(
  deps: RefreshDeps,
  { workspaceId, periodStart, periodEnd, closeAt }: CloseJobPayload,
): Promise<ClosedPeriod | null> {
  const workspace = await getWorkspace(deps.db, workspaceId);
  if (!workspace) return null;
  const now = new Date(deps.clock.now());
  await cutAtPeriodEnd(deps, workspaceId, periodEnd, now);

  const read = await readWorkspaceUsage(deps.db, {
    workspaceId,
    // Nobody's view: only the totals are used.
    viewerId: "",
    start: periodStart,
    end: periodEnd,
    now,
    membersBefore: periodEnd,
  });
  if (!read) return null;
  const usage = workspaceUsage(
    read,
    { start: periodStart, end: periodEnd },
    {
      user: { id: "", name: null, githubLogin: "", avatarUrl: null },
      member: { role: "member", githubAccess: "member" },
    },
  );
  const { current } = read;
  const capCents = read.monthlyCapCents ?? current.defaultCapCents;
  const charged = chargedCredits(usage.billedCredits, capCents, current.creditMicrousd);
  const { period: frozen, created } = await beginPeriodClose(deps.db, {
    workspaceId,
    periodStart,
    periodEnd,
    usedCredits: usage.usedCredits,
    freeCredits: usage.freeCredits,
    billedCredits: usage.billedCredits,
    chargedCredits: charged,
    chargedCents: chargedCents(charged, current.creditMicrousd),
    capCents,
    people: usage.people,
    rateCardVersion: current.version,
    at: now,
  });
  if (created) {
    deps.log.info("billing_period_frozen", {
      workspaceId,
      periodStart: periodStart.toISOString(),
      chargedCents: frozen.chargedCents,
    });
  }

  let period = frozen;
  if (period.status === "closing") {
    period = await settle(deps, workspace, period, read.cards);
    if (period.status !== "closing") capturePeriodClosed(deps, period);
  }

  await setNextClose(deps.db, {
    workspaceId,
    at: billingPeriod(workspace.billingPeriodAnchor, periodEnd).end,
    ifAt: closeAt,
  });
  // A new period: its free credits and cap start again, so what the old one held back may go.
  await refreshBillingGate(deps, workspaceId);
  return period;
}

/** Why a period is charged nothing, or null when it is charged. */
export function unchargedReason(
  mode: RefreshDeps["features"]["billing"],
  workspace: Pick<Workspace, "stripeCustomerId" | "stripePaymentMethodId">,
  period: Pick<ClosedPeriod, "closedAt" | "periodEnd" | "chargedCents" | "stripeInvoiceId">,
): { status: "unbilled" | "waived"; why: string } | null {
  // An invoice already made is a charge under way: it is finished, never dropped.
  if (period.stripeInvoiceId !== null) return null;
  if (mode !== "on") return { status: "unbilled", why: "billing_not_on" };
  if (period.closedAt.getTime() - period.periodEnd.getTime() > LATE_CLOSE_MS) {
    return { status: "unbilled", why: "closed_late" };
  }
  if (period.chargedCents < MIN_INVOICE_CENTS) return { status: "waived", why: "under_minimum" };
  if (workspace.stripeCustomerId === null || workspace.stripePaymentMethodId === null) {
    return { status: "waived", why: "no_card" };
  }
  return null;
}

/**
 * Settle a frozen period: charged nothing, or charged at Stripe. Throws, for the job to be tried
 * again, when it cannot be settled now.
 */
async function settle(
  deps: RefreshDeps,
  workspace: Workspace,
  period: ClosedPeriod,
  cards: readonly { version: number; creditMicrousd: number }[],
): Promise<ClosedPeriod> {
  const uncharged = unchargedReason(deps.features.billing, workspace, period);
  const at = new Date(deps.clock.now());
  if (uncharged) {
    deps.log.info("billing_period_uncharged", {
      workspaceId: workspace.id,
      periodStart: period.periodStart.toISOString(),
      status: uncharged.status,
      why: uncharged.why,
    });
    const settled = await settleUncharged(deps.db, {
      workspaceId: workspace.id,
      periodStart: period.periodStart,
      status: uncharged.status,
      at,
    });
    if (!settled) throw new Error("The period being closed is gone.");
    return settled;
  }
  if (deps.features.billing !== "on" || !deps.payments.enabled) {
    // An invoice was made while billing was on, and billing is not on now: it waits, uncharged,
    // until billing is on again (the job is tried again, then a day later).
    throw new Error("A period's invoice is under way, and billing is not on.");
  }
  if (!workspace.stripeCustomerId) throw new Error("A period's invoice has no Stripe customer.");

  // The price at Stripe must be the rate card's: a drift stops invoicing rather than charge wrong.
  const card = cards.find((one) => one.version === period.rateCardVersion);
  const price = await deps.payments.readCreditPrice();
  const cents = card ? creditCents(card.creditMicrousd) : null;
  if (
    cents === null ||
    !price.active ||
    price.currency !== "usd" ||
    price.unitAmountDecimal === null ||
    Number(price.unitAmountDecimal) !== cents
  ) {
    deps.log.error("billing_price_mismatch", {
      workspaceId: workspace.id,
      priceId: price.id,
      rateCardVersion: period.rateCardVersion,
    });
    throw new Error("billing_price_mismatch: the Stripe credit price is not the rate card's.");
  }

  const words = invoiceWords(workspace.name, period);
  const state = await deps.payments.chargePeriod({
    workspaceId: workspace.id,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    customerId: workspace.stripeCustomerId,
    credits: period.chargedCredits,
    description: words.description,
    lineDescription: words.line,
    invoiceId: period.stripeInvoiceId,
    onInvoice: async (invoiceId) => {
      const stored = await setPeriodInvoice(deps.db, {
        workspaceId: workspace.id,
        periodStart: period.periodStart,
        stripeInvoiceId: invoiceId,
        at,
      });
      if (!stored) throw new Error("The period names another invoice.");
    },
  });
  const applied = await applyInvoice(deps, workspace.id, state);
  // Finalized, and stored by `onInvoice`: neither a draft nor unknown. If it is, try again.
  if (!applied) throw new Error("The period's invoice could not be stored.");
  return {
    ...period,
    status: applied.after,
    stripeInvoiceId: state.id,
    invoiceNumber: state.number,
    hostedInvoiceUrl: state.hostedInvoiceUrl,
    taxCents: state.taxCents,
    totalCents: state.totalCents,
    attempts: applied.attempts,
  };
}

/**
 * Cut the workspace's awake stretches at the period's end, as the meter would have: a stretch
 * that began before it is metered up to it (and at an older period's end first, if it began in
 * one), so the period's use is all in usage events before it is read.
 */
async function cutAtPeriodEnd(deps: RefreshDeps, workspaceId: string, end: Date, now: Date) {
  const rows = await listAwakeToMeter(deps.db, { workspaceId });
  for (const row of rows) {
    let since = row.awakeSince;
    for (let i = 0; i < 3 && since < end; i++) {
      const at = nextCut(since, row.periodAnchor, now);
      if (!at || at > end) break;
      if (!(await cutAwake(deps.db, { canvasId: row.canvasId, at, observedSince: since }))) break;
      since = at;
    }
  }
}

function capturePeriodClosed(deps: RefreshDeps, period: ClosedPeriod) {
  deps.analytics.capture(
    "period closed",
    {
      status: period.status,
      used_credits: period.usedCredits,
      free_credits: period.freeCredits,
      billed_credits: period.billedCredits,
      charged_cents: period.chargedCents,
      people: period.people,
    },
    { distinctId: null, workspaceId: period.workspaceId },
  );
}

const count = (n: number) => n.toLocaleString("en-US");
const credits = (n: number) => `${count(n)} ${n === 1 ? "credit" : "credits"}`;
const day = (date: Date, withYear: boolean) =>
  date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  });

/**
 * The invoice's words: its description, `<Workspace> · <used> credits used, <free> free`, and its
 * one line, `Ponzu usage, <Mon D> – <Mon D, YYYY> · <charged> credits`, from the period's first
 * day to its last (the day before the next starts), in UTC as the period is.
 */
export function invoiceWords(
  workspaceName: string,
  period: Pick<
    ClosedPeriod,
    "periodStart" | "periodEnd" | "usedCredits" | "freeCredits" | "chargedCredits"
  >,
): { description: string; line: string } {
  const last = new Date(period.periodEnd.getTime() - 1);
  const crossesYear = period.periodStart.getUTCFullYear() !== last.getUTCFullYear();
  return {
    description: `${workspaceName} · ${credits(period.usedCredits)} used, ${count(period.freeCredits)} free`,
    line: `Ponzu usage, ${day(period.periodStart, crossesYear)} – ${day(last, true)} · ${credits(period.chargedCredits)}`,
  };
}
