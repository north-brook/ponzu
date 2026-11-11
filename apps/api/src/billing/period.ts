/*
 * A workspace's billing period (docs/cloud.md, "Billing"). Each workspace has an anchor, the day
 * it was made; its free credits, its cap and, later, its bill all start again on that day of
 * every month, at midnight UTC. A month too short for the day starts it on its last day: a
 * workspace made on the 31st starts its periods on February 28 (29 in a leap year), April 30,
 * and the 31st where there is one.
 */

export interface BillingPeriod {
  /** The first instant of the period. */
  start: Date;
  /** The first instant of the next one: what Plan and usage says it "bills" or "resets" on. */
  end: Date;
}

/** Where the period that holds `now` starts and ends, for a workspace anchored at `anchor`. */
export function billingPeriod(anchor: Date, now: Date): BillingPeriod {
  const day = anchor.getUTCDate();
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth();
  if (periodStart(year, month, day) > now.getTime()) {
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
  }
  const next = month === 11 ? { year: year + 1, month: 0 } : { year, month: month + 1 };
  return {
    start: new Date(periodStart(year, month, day)),
    end: new Date(periodStart(next.year, next.month, day)),
  };
}

/** Midnight UTC on `day` of the month, or on its last day when the month is shorter. */
function periodStart(year: number, month: number, day: number): number {
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(day, last));
}
