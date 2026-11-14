/*
 * The credit model's arithmetic, in one place (docs/cloud.md, "Billing"). Every number that
 * leaves the API is an integer: credits, cents and whole dollars. Rates come from the rate card
 * that priced the usage, never from code.
 *
 * The rules:
 *
 *   used credits    awake seconds × the card's credits per awake hour ÷ 3,600, plus what model
 *                   turns cost, added up exactly and then rounded down to a whole credit, so a
 *                   partial credit (under 12 minutes awake at 5 an hour) is never charged
 *   free credits    the card's free credits per member × the people counted for the period,
 *                   plus the period's adjustments (support's credits, or a correction that takes
 *                   some away), never below zero
 *   billed credits  used − free, never below zero: free credits are spent first
 *   billed cents    billed credits × what a credit sells for, rounded down to the cent
 *   a cap           whole dollars; it may not be set below what the period has billed, rounded
 *                   up to the dollar, nor below $1
 *
 * A breakdown (by person, by canvas) shares out the rounded total rather than rounding each
 * part on its own, so its parts always add up to the headline: each part gets its own use
 * rounded down, and the credits the fractions add up to go one each to the parts with the
 * largest fractions (`apportion`). A part never gets more than its exact use rounded up. It adds
 * up to the gross use, not to what was billed.
 */

/** Rates and credits carry four decimal places (`numeric(14, 4)` in the schema). */
const RATE_SCALE = 10_000;
const SECONDS_PER_HOUR = 3_600;
/**
 * Usage is added up in units of 1 / (3,600 × 10,000) credit, in which a second at any rate the
 * card can hold, and any credits it can hold, are whole numbers.
 */
const UNITS_PER_CREDIT = SECONDS_PER_HOUR * RATE_SCALE;
const MICROUSD_PER_CENT = 10_000;

/** Exact usage, in units: add them up with `+`, round with `creditsOf` once at the end. */
export type Units = number;

/** Awake time at a rate card's credits per awake hour. */
export function awakeUnits(seconds: number, creditsPerAwakeHour: number): Units {
  return seconds * Math.round(creditsPerAwakeHour * RATE_SCALE);
}

/** Credits a model turn cost, as stored. */
export function creditUnits(credits: number): Units {
  return Math.round(credits * RATE_SCALE) * SECONDS_PER_HOUR;
}

/** Whole credits used: rounded down, so a partial credit is never charged. */
export function creditsOf(units: Units): number {
  return Math.floor(units / UNITS_PER_CREDIT);
}

/**
 * Whole credits for each part of a total, adding up to `creditsOf` the total exactly (largest
 * remainder): every part gets its use rounded down, then the credits left over go one each to
 * the parts with the largest fractions, a tie to the earlier part. In the order given.
 */
export function apportion(parts: readonly Units[]): number[] {
  const total = creditsOf(parts.reduce((sum, units) => sum + units, 0));
  const credits = parts.map(creditsOf);
  let left = total - credits.reduce((sum, n) => sum + n, 0);
  const byFraction = parts
    .map((units, i) => ({ i, fraction: units - credits[i]! * UNITS_PER_CREDIT }))
    .filter(({ fraction }) => fraction > 0)
    .sort((a, b) => b.fraction - a.fraction || a.i - b.i);
  for (const { i } of byFraction) {
    if (left <= 0) break;
    credits[i]! += 1;
    left -= 1;
  }
  return credits;
}

/**
 * `apportion` over a map's values, keyed as the map is. Ties go by key, not by the order the
 * map was filled in, so the same use reads the same however its rows came back.
 */
export function apportionMap<K extends string | null>(
  parts: ReadonlyMap<K, Units>,
): Map<K, number> {
  const order = (key: K) => key ?? "";
  const keys = [...parts.keys()].sort((a, b) =>
    order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0,
  );
  const credits = apportion(keys.map((key) => parts.get(key)!));
  return new Map(keys.map((key, i) => [key, credits[i]!]));
}

/**
 * The free credits of a period: each counted person's allowance, pooled, with the period's
 * adjustments in whole credits added (a negative one takes some away), never below zero.
 */
export function freeCredits(people: number, perMember: number, adjusted = 0): number {
  return Math.max(0, people * Math.floor(perMember) + Math.trunc(adjusted));
}

/** What is billed of what was used: free credits are spent first. */
export function billedCredits(used: number, free: number): number {
  return Math.max(0, used - free);
}

/** What credits sell for, in cents, rounded down. */
export function centsFor(credits: number, creditMicrousd: number): number {
  return Math.floor((credits * creditMicrousd) / MICROUSD_PER_CENT);
}

/** The lowest cap that may be set, in whole dollars, once `billedCents` have been billed. */
export function lowestCapUsd(billedCents: number): number {
  return Math.max(1, Math.ceil(billedCents / 100));
}

/*
 * What a period is charged. Ponzu never charges above the cap: a turn that was already running
 * when the cap was reached finishes, and what it used past the cap is Ponzu's cost, not the
 * workspace's. The cap is in cents and a credit may not divide it, so the charge is the whole
 * credits the cap can pay for, rounded down, and its cents never exceed the cap.
 */

/** The credits a period is charged: what was billed, but never more than the cap pays for. */
export function chargedCredits(billed: number, capCents: number, creditMicrousd: number): number {
  return Math.min(billed, Math.floor((capCents * MICROUSD_PER_CENT) / creditMicrousd));
}

/** What the charged credits come to, in cents, rounded down. */
export function chargedCents(charged: number, creditMicrousd: number): number {
  return centsFor(charged, creditMicrousd);
}

/** A period whose charge is under this many cents ($1.00) is not invoiced: it is waived. */
export const MIN_INVOICE_CENTS = 100;

/** The rate card's `cap_warning_fraction` has three decimal places (`numeric(4, 3)`). */
const FRACTION_SCALE = 1_000;

/**
 * Whether what is billed has reached the warning share of the cap (0.8 on rate card v1), so
 * admins are told before the cap stops new turns. It stays true at and past the cap; telling the
 * warning from the cap itself is the caller's. Compared in whole thousandths of a cent, so 0.8 of
 * $100 is reached at exactly $80.00 and not a cent before.
 */
export function capWarning(billedCents: number, capCents: number, fraction: number): boolean {
  return billedCents * FRACTION_SCALE >= capCents * Math.round(fraction * FRACTION_SCALE);
}
