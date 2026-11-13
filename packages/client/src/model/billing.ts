import type { Person } from "./model.ts";

/*
 * A workspace's usage this billing period, and the rules Plan and usage and the add-a-card
 * dialog follow (docs/cloud.md, Billing). Usage is counted in credits and shown in dollars.
 * Free credits are pooled across a team and spent first; the cap limits only what is billed.
 */

export type CardBrand = "visa" | "mastercard" | "amex" | "other";

export interface Card {
  brand: CardBrand;
  /** Null for a card Stripe gave no digits for (a wallet). */
  last4: string | null;
}

/**
 * The workspace's last invoice didn't get paid: the charge failed, or the bank asks the payer to
 * confirm it. `invoiceUrl` is Stripe's page to pay it on. Only an admin is told.
 */
export interface PastDue {
  reason: "failed" | "needs_confirmation";
  invoiceUrl: string | null;
}

export interface Usage {
  usedCredits: number;
  /** This period's allowance: 100 for each member, pooled. */
  freeCredits: number;
  /** What a credit costs, from the rate card the API bills with. */
  creditUsd: number;
  /** The monthly cap on what is billed, in whole dollars; null until a card is added. */
  capUsd: number | null;
  /** When the period ends: the bill, or before a card, the free credits renewing. */
  periodEnd: string;
  card: Card | null;
  /**
   * Ponzu can't bill yet (the API's billing is `not_set_up`): what passes the free credits is
   * counted, and the cap stored, but nothing is charged, so nothing reads as billed.
   */
  notBilled?: boolean;
  /** What is past due, for an admin while billing is on; absent or null otherwise. */
  pastDue?: PastDue | null;
}

/** The Card row's words for what is past due. */
export function pastDueWords(pastDue: PastDue): string {
  return pastDue.reason === "needs_confirmation"
    ? "Payment needs your confirmation"
    : "Payment failed";
}

/** A card's brand as the API names it (Stripe's word), as the marks Ponzu draws. */
export function cardBrand(brand: string): CardBrand {
  return brand === "visa" || brand === "mastercard" || brand === "amex" ? brand : "other";
}

/*
 * The billing wall (docs/cloud.md, "Billing"). While billing is on, a send that would start work
 * past a limit is answered 402 `billing_required` with these details, and nothing is written.
 * The app keeps the send and opens the dialog the reason calls for.
 */

/** Why the workspace's work waits: its free credits, its cap, or a payment. */
export type BillingReason = "free_used" | "cap_reached" | "payment_failed";

/** A 402 `billing_required`'s details, as the dialogs read them. */
export interface BillingRequired {
  reason: BillingReason;
  workspaceId: string;
  workspaceName: string;
  /** May add the card, raise the cap or pay: an admin. */
  canManage: boolean;
  capUsd: number;
  billedCents: number;
  /** When the period ends and the cap resets (ISO 8601). */
  periodEnd: string;
  /** Stripe's page for the unpaid invoice; null for a member, or when there is none. */
  invoiceUrl: string | null;
}

const REASONS: readonly string[] = ["free_used", "cap_reached", "payment_failed"];

/**
 * The 402 `billing_required` an error is, or null: anything else, including a 402 an older or
 * newer API shaped otherwise, is left to the caller's own handling. Duck-typed on the client's
 * `ApiError` so the rule stays pure.
 */
export function billingRequired(error: unknown): BillingRequired | null {
  if (typeof error !== "object" || error === null) return null;
  const { status, code, details } = error as {
    status?: unknown;
    code?: unknown;
    details?: unknown;
  };
  if (status !== 402 || code !== "billing_required") return null;
  if (typeof details !== "object" || details === null) return null;
  const d = details as Record<string, unknown>;
  if (typeof d.reason !== "string" || !REASONS.includes(d.reason)) return null;
  if (typeof d.workspaceId !== "string" || typeof d.workspaceName !== "string") return null;
  return {
    reason: d.reason as BillingReason,
    workspaceId: d.workspaceId,
    workspaceName: d.workspaceName,
    canManage: d.canManage === true,
    capUsd: typeof d.capUsd === "number" ? d.capUsd : 0,
    billedCents: typeof d.billedCents === "number" ? d.billedCents : 0,
    periodEnd: typeof d.periodEnd === "string" ? d.periodEnd : new Date().toISOString(),
    invoiceUrl: typeof d.invoiceUrl === "string" ? d.invoiceUrl : null,
  };
}

/**
 * What adding a card in the browser came to, in the words the dialog shows under its button:
 * null once it is added. In the wall a prompt is held, and the words say it is kept; in Settings
 * there is none to keep.
 */
export function cardSetupError(
  outcome: "added" | "cancelled" | "expired" | "failed",
  held: boolean,
): string | null {
  switch (outcome) {
    case "added":
      return null;
    case "cancelled":
    case "failed":
      return held ? "The card wasn't added. Your prompt is still here." : "The card wasn't added.";
    case "expired":
      return "That took too long. Try again.";
  }
}

/** What the use past the free credits is called: billed, or before billing exists, past free. */
export function pastFreeWord(usage: Usage): string {
  return usage.notBilled ? "past free" : "billed";
}

/** One person's share of a team's use this period: gross, before the pooled free credits. */
export interface PersonUsage {
  person: Person;
  admin: boolean;
  usedCredits: number;
}

export function billedCredits(usage: Usage): number {
  return Math.max(0, usage.usedCredits - usage.freeCredits);
}

export function billedUsd(usage: Usage): number {
  return billedCredits(usage) * usage.creditUsd;
}

/** "$22.00", or with `whole` "$22" (rounded down, so a legend never overstates a bill). */
export function money(usd: number, whole = false): string {
  if (whole) return `$${Math.floor(usd + 1e-9).toLocaleString("en-US")}`;
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "December 9", in the person's time zone. */
export function longDate(at: string): string {
  return new Date(at).toLocaleDateString("en-US", { month: "long", day: "numeric" });
}

/**
 * The total at the top: what is billed (or, before billing, used past the free credits) once
 * there is any; until then what was used, all of it free, so the number never reads $0.00 beside
 * rows that add up to more.
 */
export function headlineUsd(usage: Usage): number {
  return billedCredits(usage) > 0 ? billedUsd(usage) : usage.usedCredits * usage.creditUsd;
}

/**
 * The line under the total: first what the total is (used, billed, or past free), then the
 * credits, and when the period ends. A team names itself and its people; before a card the period
 * "resets" rather than "bills". While Ponzu can't bill, use past the free credits says it isn't
 * billed yet.
 */
export function usageLine(usage: Usage, team?: { name: string; people: number }): string {
  const credits = Math.floor(usage.usedCredits).toLocaleString("en-US");
  const past = billedCredits(usage) > 0;
  const what = !past ? "used" : usage.notBilled ? "past free" : "billed";
  const free = !past
    ? `all free of ${money(usage.freeCredits * usage.creditUsd, true)}`
    : `${usage.freeCredits.toLocaleString("en-US")} of them free`;
  const end =
    usage.notBilled && past
      ? "not billed yet"
      : `${usage.card ? "bills" : "resets"} ${longDate(usage.periodEnd)}`;
  if (team) {
    const people = `${team.people} ${team.people === 1 ? "person" : "people"}`;
    return `${what} this month in ${team.name} · ${people} · ${credits} credits${past ? "" : ", all free"} · ${end}`;
  }
  return `${what} this month · ${credits} credits, ${free} · ${end}`;
}

/** The least share of the bar that any use takes, so a few cents of it can be seen. */
const MIN_SHOWN = 0.015;

/**
 * The usage bar's two segments as shares of its width. The bar spans the free credits plus what
 * the cap buys; without a cap, the free credits alone. Together they never pass the end.
 */
export function usageBar(usage: Usage): { free: number; billed: number } {
  const capCredits = usage.capUsd === null ? 0 : usage.capUsd / usage.creditUsd;
  const scale = usage.freeCredits + capCredits;
  if (scale <= 0) return { free: 0, billed: 0 };
  const used = Math.min(usage.usedCredits, usage.freeCredits) / scale;
  // A little use still shows: a sliver, not an empty bar beside a total that says otherwise.
  const free = used > 0 ? Math.max(used, MIN_SHOWN) : 0;
  const billed = Math.min(billedCredits(usage) / scale, 1 - free);
  return { free, billed };
}

/** The cap is reached: nothing in the workspace wakes until it is raised or the month turns. */
export function atCap(usage: Usage): boolean {
  return usage.capUsd !== null && billedUsd(usage) >= usage.capUsd;
}

/**
 * What a typed cap is, in whole dollars, or why it can't be one. It can't go below what this
 * period has already billed, nor below a dollar.
 */
export function parseCap(
  typed: string,
  billed: number,
  /** What the use past the free credits is called: "billed", or "used past free" before billing. */
  word = "billed",
): { ok: true; usd: number } | { ok: false; error: string } {
  const text = typed.trim().replace(/^\$/, "").replaceAll(",", "");
  if (!text) return { ok: false, error: "Enter an amount" };
  if (!/^\d+$/.test(text)) return { ok: false, error: "Whole dollars only" };
  const usd = Number(text);
  const least = Math.max(1, Math.ceil(billed - 1e-9));
  if (usd < least) {
    return {
      ok: false,
      error: billed > 0 ? `At least ${money(least, true)}, ${word} so far` : "At least $1",
    };
  }
  return { ok: true, usd };
}

/** The cap the cap-reached dialog offers: twice the current one. */
export function nextCap(capUsd: number): number {
  return capUsd * 2;
}
