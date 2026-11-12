/*
 * Rate card v1 as the home page's pricing band states it (one plan, pay as you go; the program's
 * settled point 1). home.test.ts holds these to the row packages/db seeds (migration 0001), so
 * the page can't drift from what the API would bill.
 *
 * Site slice S4 adds packages/db/src/rate-card.ts (PUBLISHED_RATE_CARD, pinned by a database
 * test to the newest rate_cards row) and components/pricing.ts; once both have landed, the band
 * reads from them and this file goes.
 */

export const HOME_RATE = {
  creditMicrousd: 100_000,
  sandboxCreditsPerAwakeHour: 5,
  freeCreditsPerMember: 100,
} as const;

/** A credit's price as people read it: "$0.10". */
export function creditPrice(rate = HOME_RATE): string {
  return `$${(rate.creditMicrousd / 1_000_000).toFixed(2)}`;
}
