import { describe, expect, test } from "bun:test";
import {
  atCap,
  billedUsd,
  money,
  nextCap,
  parseCap,
  pastFreeWord,
  type Usage,
  usageBar,
  usageLine,
} from "./billing.ts";

const periodEnd = new Date(2026, 11, 9, 12, 0).toISOString();
const visa = { brand: "visa" as const, last4: "4242", failed: false };

// The solo board: 64 awake hours, 100 free credits, a $50 cap.
const solo: Usage = {
  usedCredits: 320,
  freeCredits: 100,
  creditUsd: 0.1,
  capUsd: 50,
  periodEnd,
  card: visa,
};
// The team board: 412 hours across five people, 100 free credits each, a $500 cap.
const team: Usage = { ...solo, usedCredits: 2060, freeCredits: 500, capUsd: 500 };

describe("plan and usage", () => {
  test("bills what is past the free credits", () => {
    expect(money(billedUsd(solo))).toBe("$22.00");
    expect(money(billedUsd(team))).toBe("$156.00");
    expect(money(billedUsd({ ...solo, usedCredits: 60 }))).toBe("$0.00");
  });

  test("speaks in dollars, with credits once in the line under", () => {
    expect(usageLine(solo)).toBe("this month · 320 credits, 100 of them free · bills December 9");
    expect(usageLine(team, { name: "Northbrook", people: 5 })).toBe(
      "this month for Northbrook · 5 people · 2,060 credits · bills December 9",
    );
    expect(usageLine({ ...solo, usedCredits: 60, card: null, capUsd: null })).toBe(
      "this month · 60 credits, all free · resets December 9",
    );
  });

  test("before Ponzu can bill, use past the free credits is past free, and not billed yet", () => {
    const unbilled: Usage = { ...solo, card: null, notBilled: true };
    expect(usageLine(unbilled)).toBe("this month · 320 credits, 100 of them free · not billed yet");
    expect(pastFreeWord(unbilled)).toBe("past free");
    expect(pastFreeWord(solo)).toBe("billed");
    // All free: the period simply resets.
    expect(usageLine({ ...unbilled, usedCredits: 60 })).toBe(
      "this month · 60 credits, all free · resets December 9",
    );
    expect(parseCap("10", 22, "used past free")).toEqual({
      ok: false,
      error: "At least $22, used past free so far",
    });
  });

  test("the bar spans the free credits and what the cap buys", () => {
    const bar = usageBar(solo);
    expect(bar.free).toBeCloseTo(100 / 600);
    expect(bar.billed).toBeCloseTo(220 / 600);
    const teamBar = usageBar(team);
    expect(teamBar.free).toBeCloseTo(0.0909, 3);
    expect(teamBar.billed).toBeCloseTo(0.2836, 3);
  });

  test("before a card the bar is the free credits alone", () => {
    expect(usageBar({ ...solo, usedCredits: 60, card: null, capUsd: null })).toEqual({
      free: 0.6,
      billed: 0,
    });
  });

  test("past the cap the bar ends at its end", () => {
    const over = { ...solo, usedCredits: 700 };
    const bar = usageBar(over);
    expect(bar.free + bar.billed).toBeCloseTo(1);
    expect(atCap(over)).toBe(true);
    expect(atCap(solo)).toBe(false);
    expect(atCap({ ...solo, capUsd: null })).toBe(false);
  });

  test("legend figures round down to whole dollars", () => {
    expect(money(22.95, true)).toBe("$22");
    expect(money(1560, true)).toBe("$1,560");
  });
});

describe("editing the cap", () => {
  test("takes whole dollars, with or without the sign", () => {
    expect(parseCap("75", 22)).toEqual({ ok: true, usd: 75 });
    expect(parseCap(" $1,000 ", 22)).toEqual({ ok: true, usd: 1000 });
  });

  test("can't go below what is already billed this month", () => {
    expect(parseCap("20", 22)).toEqual({ ok: false, error: "At least $22, billed so far" });
    expect(parseCap("23", 22.4)).toEqual({ ok: true, usd: 23 });
    expect(parseCap("22", 22.4)).toEqual({ ok: false, error: "At least $23, billed so far" });
    expect(parseCap("0", 0)).toEqual({ ok: false, error: "At least $1" });
  });

  test("says what is wrong with what was typed", () => {
    expect(parseCap("", 0)).toEqual({ ok: false, error: "Enter an amount" });
    expect(parseCap("12.50", 0)).toEqual({ ok: false, error: "Whole dollars only" });
    expect(parseCap("lots", 0)).toEqual({ ok: false, error: "Whole dollars only" });
  });

  test("at the cap, the dialog offers twice as much", () => {
    expect(nextCap(50)).toBe(100);
  });
});
