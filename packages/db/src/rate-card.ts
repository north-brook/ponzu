/*
 * The rate card people are shown: the newest row of `rate_cards`, written out as a constant, so
 * the site (apps/web's /pricing and the home page's pricing band) can print the prices without a
 * database. The API never reads this; it prices usage from the rows themselves. rate-card.test.ts
 * holds the two together: a migration that adds a rate card fails CI until this constant says the
 * same.
 *
 * This module imports nothing, so a page can import `@ponzu/db/rate-card` without pulling in the
 * schema, drizzle or a driver.
 */

/** The rate card in effect, as people read it. Field for field the newest `rate_cards` row. */
export const PUBLISHED_RATE_CARD = {
  version: 1,
  /** What one credit sells for, in millionths of a dollar ($0.10). */
  creditMicrousd: 100_000,
  /** Credits an awake sandbox hour costs, metered by the second. */
  sandboxCreditsPerAwakeHour: 5,
  /** Free credits each counted person adds to a workspace's period, pooled. */
  freeCreditsPerMember: 100,
  /** A workspace's monthly cap until an admin sets one, in cents ($100). */
  defaultCapCents: 10_000,
  /** The share of the cap at which admins are warned. */
  capWarningFraction: 0.8,
  /** How long a canvas's sandbox stays awake after the last activity. */
  idleSleepSeconds: 300,
} as const;

export type PublishedRateCard = typeof PUBLISHED_RATE_CARD;
