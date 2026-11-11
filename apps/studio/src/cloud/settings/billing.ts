import type { Person } from "../model.ts";

/*
 * A workspace's usage this billing period, and the rules Plan and usage and the add-a-card
 * dialog follow (docs/cloud.md, Billing). Usage is counted in credits and shown in dollars.
 * Free credits are pooled across a team and spent first; the cap limits only what is billed.
 */

export type CardBrand = "visa" | "mastercard" | "amex" | "other";

export interface Card {
  brand: CardBrand;
  last4: string;
  /** Stripe's last charge to it failed. */
  failed: boolean;
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
 * The line under the total: what was used, in credits, and when the period ends. A team names
 * itself and its people; before a card the period "resets" rather than "bills". While Ponzu
 * can't bill, use past the free credits says it isn't billed yet.
 */
export function usageLine(usage: Usage, team?: { name: string; people: number }): string {
  const credits = Math.floor(usage.usedCredits).toLocaleString("en-US");
  const free =
    usage.usedCredits <= usage.freeCredits
      ? "all free"
      : `${usage.freeCredits.toLocaleString("en-US")} of them free`;
  const end =
    usage.notBilled && billedCredits(usage) > 0
      ? "not billed yet"
      : `${usage.card ? "bills" : "resets"} ${longDate(usage.periodEnd)}`;
  if (team) {
    const people = `${team.people} ${team.people === 1 ? "person" : "people"}`;
    return `this month for ${team.name} · ${people} · ${credits} credits · ${end}`;
  }
  return `this month · ${credits} credits, ${free} · ${end}`;
}

/**
 * The usage bar's two segments as shares of its width. The bar spans the free credits plus what
 * the cap buys; without a cap, the free credits alone. Together they never pass the end.
 */
export function usageBar(usage: Usage): { free: number; billed: number } {
  const capCredits = usage.capUsd === null ? 0 : usage.capUsd / usage.creditUsd;
  const scale = usage.freeCredits + capCredits;
  if (scale <= 0) return { free: 0, billed: 0 };
  const free = Math.min(usage.usedCredits, usage.freeCredits) / scale;
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
