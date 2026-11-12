import { PUBLISHED_RATE_CARD } from "@ponzu/db/rate-card";

/*
 * Every price the site prints, worked out from the published rate card (packages/db's
 * rate-card.ts, which a database test holds to the newest rate_cards row). No page writes a
 * number of its own: pricing.test.ts fails on a dollar amount typed into a page.
 *
 * The arithmetic is the API's (apps/api/src/billing/credits.ts), in the same order and in whole
 * numbers: credits used are rounded down, the free credits are spent first, and what is billed is
 * rounded down to the cent.
 */

const CARD = PUBLISHED_RATE_CARD;
const MICROUSD_PER_CENT = 10_000;

/** Cents as people read them: whole dollars without cents, anything else to the cent. */
export function dollars(cents: number): string {
  const whole = cents % 100 === 0;
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  });
}

/** A count with its thousands marked: 1,000. */
export function count(n: number): string {
  return n.toLocaleString("en-US");
}

/** What a number of credits sells for, in cents, rounded down. */
function centsFor(credits: number): number {
  return Math.floor((credits * CARD.creditMicrousd) / MICROUSD_PER_CENT);
}

/** The rate card's numbers, ready to print. */
export const PRICES = {
  /** What one credit sells for. */
  credit: dollars(centsFor(1)),
  /** Credits an awake hour costs. */
  creditsPerHour: CARD.sandboxCreditsPerAwakeHour,
  /** What an awake hour comes to. */
  hour: dollars(centsFor(CARD.sandboxCreditsPerAwakeHour)),
  /** Free credits each person brings a month. */
  freeCredits: CARD.freeCreditsPerMember,
  /** The cap a workspace starts with. */
  cap: dollars(CARD.defaultCapCents),
  /** When admins are warned, as a share of the cap. */
  warningPercent: Math.round(CARD.capWarningFraction * 100),
  /** How long an idle canvas stays awake, in minutes. */
  sleepMinutes: CARD.idleSleepSeconds / 60,
} as const;

/** What a month of awake time comes to for a workspace of some number of people. */
export interface MonthCost {
  hours: number;
  people: number;
  /** Credits used, rounded down. */
  credits: number;
  /** The free credits the people bring, pooled. */
  freeCredits: number;
  /** Credits past the free ones. */
  billedCredits: number;
  /** What those come to, in cents, rounded down. */
  cents: number;
}

/** A month's cost, worked out as the API works out a period: used, less free, priced. */
export function monthCost(hours: number, people = 1): MonthCost {
  const credits = Math.floor(hours * CARD.sandboxCreditsPerAwakeHour);
  const freeCredits = people * Math.floor(CARD.freeCreditsPerMember);
  const billedCredits = Math.max(0, credits - freeCredits);
  return { hours, people, credits, freeCredits, billedCredits, cents: centsFor(billedCredits) };
}

/** The examples on /pricing: a month of each, from trying it to a team of five. */
export const EXAMPLES: readonly { label: string; cost: MonthCost }[] = [
  { label: "Trying it", cost: monthCost(12) },
  { label: "Light", cost: monthCost(30) },
  { label: "Typical", cost: monthCost(60) },
  { label: "Heavy", cost: monthCost(200) },
  { label: "A team of five", cost: monthCost(400, 5) },
];

/** Whether a month's bill goes past the cap a workspace starts with, so it needs a raised cap. */
export function pastDefaultCap(cost: MonthCost): boolean {
  return cost.cents > CARD.defaultCapCents;
}
