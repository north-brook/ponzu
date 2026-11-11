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
 *   free credits    the card's free credits per member × the people counted for the period
 *   billed credits  used − free, never below zero: free credits are spent first
 *   billed cents    billed credits × what a credit sells for, rounded down to the cent
 *   a cap           whole dollars; it may not be set below what the period has billed, rounded
 *                   up to the dollar, nor below $1
 *
 * A person's or a design's credits are their own exact use, rounded down the same way, so a
 * breakdown never overstates anyone; it adds up to the gross use, not to what was billed.
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

/** The free credits of a period: each counted person's allowance, pooled. */
export function freeCredits(people: number, perMember: number): number {
  return people * Math.floor(perMember);
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
