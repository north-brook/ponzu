import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { PUBLISHED_RATE_CARD } from "@ponzu/db/rate-card";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  awakeUnits,
  billedCredits,
  centsFor,
  creditsOf,
  freeCredits,
} from "../../api/src/billing/credits.ts";
import Pricing from "../app/pricing/page.tsx";
import { dollars, EXAMPLES, monthCost, PRICES, pastDefaultCap } from "./pricing.ts";
import { BILLING_LIVE } from "./site.ts";

/*
 * The prices the site prints: exact on rate card v1, worked out the way the API bills, and typed
 * into no page. A new rate card changes PUBLISHED_RATE_CARD (rate-card.test.ts forces that), and
 * then these exact values fail until someone has read the page's new numbers.
 */

const ROOT = join(import.meta.dir, "..");

test("the three figures are rate card v1's", () => {
  expect(PUBLISHED_RATE_CARD.version).toBe(1);
  expect(PRICES).toEqual({
    credit: "$0.10",
    creditsPerHour: 5,
    hour: "$0.50",
    freeCredits: 100,
    cap: "$100",
    warningPercent: 80,
    sleepMinutes: 5,
  });
});

test("what a month costs, row by row", () => {
  const rows = EXAMPLES.map(({ label, cost }) => [
    label,
    cost.hours,
    cost.credits,
    dollars(cost.cents),
  ]);
  expect(rows).toEqual([
    ["Trying it", 12, 60, "$0"],
    ["Light", 30, 150, "$5"],
    ["Typical", 60, 300, "$20"],
    ["Heavy", 200, 1000, "$90"],
    ["A team of five", 400, 2000, "$150"],
  ]);
  const team = EXAMPLES.at(-1)!.cost;
  expect(team).toEqual({
    hours: 400,
    people: 5,
    credits: 2000,
    freeCredits: 500,
    billedCredits: 1500,
    cents: 15_000,
  });
  // A team of five goes past the cap a workspace starts with, and the page says so.
  expect(pastDefaultCap(team)).toBe(true);
  expect(EXAMPLES.slice(0, -1).some(({ cost }) => pastDefaultCap(cost))).toBe(false);
});

test("a month is worked out exactly as the API bills a period", () => {
  const card = PUBLISHED_RATE_CARD;
  for (const people of [1, 2, 5, 12]) {
    for (const hours of [0, 0.1, 0.19, 0.2, 1, 7.5, 12, 19.99, 20, 20.2, 33.3, 60, 200, 400, 999]) {
      const used = creditsOf(awakeUnits(Math.round(hours * 3600), card.sandboxCreditsPerAwakeHour));
      const billed = billedCredits(used, freeCredits(people, card.freeCreditsPerMember));
      const api = centsFor(billed, card.creditMicrousd);
      const site = monthCost(hours, people);
      expect([hours, people, site.credits, site.cents]).toEqual([hours, people, used, api]);
    }
  }
});

test("dollars reads as people write money", () => {
  expect([0, 10, 50, 100, 1_050, 15_000, 100_000].map(dollars)).toEqual([
    "$0",
    "$0.10",
    "$0.50",
    "$1",
    "$10.50",
    "$150",
    "$1,000",
  ]);
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

test("no page types a dollar amount: every price comes from the rate card", () => {
  const sources = [...walk(join(ROOT, "app")), ...walk(join(ROOT, "components"))].filter(
    (p) => /\.(tsx?|mdx)$/.test(p) && !/\.test\.tsx?$/.test(p),
  );
  const typed = sources.flatMap((p) =>
    readFileSync(p, "utf8")
      .split("\n")
      .flatMap((line, i) =>
        /\$\s?\d/.test(line) ? [`${relative(ROOT, p)}:${i + 1}: ${line.trim()}`] : [],
      ),
  );
  expect(typed).toEqual([]);
});

test("the page prints the rate card's numbers, and says billing hasn't started", () => {
  const html = renderToStaticMarkup(createElement(Pricing));
  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/\s+/g, " ");
  for (const words of [
    "Pay for what runs.",
    "100 free credits a month, per person, pooled in a team",
    "$0.10 a credit",
    "5 credits an awake hour ($0.50)",
    "sleeps 5 minutes after the last activity",
    "a monthly cap, $100 to start",
    "Trying it 12 h 60 $0",
    "Light 30 h 150 $5",
    "Typical 60 h 300 $20",
    "Heavy 200 h 1,000 $90",
    "A team of five 400 h 2,000 $150",
    "The team row assumes 5 people, so 500 credits are free.",
    "no new turn starts in the workspace until an admin raises the cap or the month resets",
    "A turn that's running finishes.",
    "you can add one any time in Settings",
  ])
    expect(text).toContain(words);
  // The source scan above misses an amount split across JSX ({"$"}100), so the rendered page is
  // checked too: every dollar amount on it is one the rate card works out.
  const worked = new Set([
    PRICES.credit,
    PRICES.hour,
    PRICES.cap,
    ...EXAMPLES.map(({ cost }) => dollars(cost.cents)),
  ]);
  const printed = [...text.matchAll(/\$\s?\d[\d,]*(?:\.\d+)?/g)].map(([amount]) => amount);
  expect(printed.length).toBeGreaterThan(0);
  expect(printed.filter((amount) => !worked.has(amount))).toEqual([]);
  expect(BILLING_LIVE).toBe(false);
  expect(text).toContain("Ponzu is free while billing is being set up.");
  expect(html).toContain('href="mailto:hello@ponzu.design"');
});
