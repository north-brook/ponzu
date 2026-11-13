import { describe, expect, test } from "bun:test";
import type { RateCardNumbers, UsagePerson, WorkspaceUsageRead } from "@ponzu/db";
import fc from "fast-check";
import {
  apportion,
  awakeUnits,
  billedCredits,
  capWarning,
  centsFor,
  chargedCents,
  chargedCredits,
  creditsOf,
  creditUnits,
  freeCredits,
  lowestCapUsd,
  MIN_INVOICE_CENTS,
} from "./credits.ts";
import { type BillingGateInput, billingGate, GRACE_MS } from "./gate.ts";
import { CUT_EVERY_MS, nextCut } from "./meter.ts";
import { billingPeriod } from "./period.ts";
import { countedPeople, ungranted, workspaceUsage } from "./usage.ts";

/*
 * The credit model against the spec's own examples (Settings and pricing: "How the drawn numbers
 * are derived", and the Pay as you go table), worked by hand: $0.10 a credit, 5 credits an
 * awake hour, 100 free per member, pooled.
 */

const HOUR = 3600;
const CARD: RateCardNumbers = {
  version: 1,
  creditMicrousd: 100_000,
  sandboxCreditsPerAwakeHour: 5,
  freeCreditsPerMember: 100,
  defaultCapCents: 10_000,
};
const period = {
  start: new Date("2026-11-09T00:00:00Z"),
  end: new Date("2026-12-09T00:00:00Z"),
};

const person = (id: string, role: UsagePerson["role"] = "member"): UsagePerson => ({
  id,
  name: id[0]!.toUpperCase() + id.slice(1),
  githubLogin: id,
  avatarUrl: null,
  role,
});

/** A period of awake hours by person, each in a canvas of their own. */
function read(
  hours: Record<string, number>,
  extra: Partial<WorkspaceUsageRead> = {},
): WorkspaceUsageRead {
  const ids = Object.keys(hours);
  return {
    current: CARD,
    cards: [CARD],
    monthlyCapCents: null,
    rows: ids.map((id) => ({
      userId: id,
      canvasId: `cnv_${id}`,
      rateCardVersion: 1,
      seconds: hours[id]! * HOUR,
      modelCredits: 0,
    })),
    people: ids.map((id, i) => person(id, i === 0 ? "admin" : "member")),
    canvases: ids.map((id) => ({ id: `cnv_${id}`, name: `${id}'s canvas`, readable: true })),
    granted: { userIds: [], departed: 0 },
    adjustedCredits: 0,
    ...extra,
  };
}

const viewer = (id: string, role: "admin" | "member" = "admin") => ({
  user: { id, name: null, githubLogin: id, avatarUrl: null },
  member: { role, githubAccess: "member" as const },
});

describe("the rounding rules", () => {
  test("a credit is 720 awake seconds at 5 an hour, and a partial one is not charged", () => {
    expect(creditsOf(awakeUnits(719, 5))).toBe(0);
    expect(creditsOf(awakeUnits(720, 5))).toBe(1);
    expect(creditsOf(awakeUnits(HOUR, 5))).toBe(5);
    // Added up exactly before rounding: two stretches of 6 minutes are one credit.
    expect(creditsOf(awakeUnits(360, 5) + awakeUnits(360, 5))).toBe(1);
  });

  test("fractional rates and model credits add up exactly", () => {
    expect(creditsOf(awakeUnits(HOUR, 2.5))).toBe(2);
    expect(creditsOf(awakeUnits(2 * HOUR, 2.5))).toBe(5);
    expect(creditsOf(creditUnits(0.4) + creditUnits(0.6))).toBe(1);
    expect(creditsOf(creditUnits(12.3456))).toBe(12);
  });

  test("free credits are spent first, and nothing is billed below them", () => {
    expect(billedCredits(320, 100)).toBe(220);
    expect(billedCredits(60, 100)).toBe(0);
    expect(freeCredits(5, 100)).toBe(500);
  });

  test("cents round down, and a cap may not go below what was billed", () => {
    expect(centsFor(220, 100_000)).toBe(2200);
    expect(centsFor(1, 123_456)).toBe(12);
    expect(lowestCapUsd(0)).toBe(1);
    expect(lowestCapUsd(2200)).toBe(22);
    expect(lowestCapUsd(2201)).toBe(23);
  });
});

describe("the spec's examples", () => {
  test("solo, 64 awake hours: 320 credits, 100 free, $22.00", () => {
    const usage = workspaceUsage(read({ bryce: 64 }), period, viewer("bryce"));
    expect(usage).toMatchObject({
      usedCredits: 320,
      freeCredits: 100,
      billedCredits: 220,
      billedCents: 2200,
      creditCents: 10,
      people: 1,
      cap: { usd: 100, isDefault: true, lowestUsd: 22 },
    });
  });

  test("a team of five, 412 hours: 2,060 credits, 500 free, $156.00, each person gross", () => {
    const usage = workspaceUsage(
      read({ bryce: 141, sam: 112, maya: 96, jordan: 41, alex: 22 }, { monthlyCapCents: 50_000 }),
      period,
      viewer("bryce"),
    );
    expect(usage).toMatchObject({
      usedCredits: 2060,
      freeCredits: 500,
      billedCredits: 1560,
      billedCents: 15_600,
      people: 5,
      cap: { usd: 500, isDefault: false },
    });
    expect(usage.byPerson!.map((row) => [row.person.login, row.usedCredits])).toEqual([
      ["bryce", 705],
      ["sam", 560],
      ["maya", 480],
      ["jordan", 205],
      ["alex", 110],
    ]);
    // $70.50 for 141 hours: gross, before the pooled free credits.
    expect(centsFor(usage.byPerson![0]!.usedCredits, CARD.creditMicrousd)).toBe(7050);
  });

  test("the Pay as you go table, with 100 free credits", () => {
    const pays = (hours: number) =>
      workspaceUsage(read({ solo: hours }), period, viewer("solo")).billedCents;
    expect(pays(12)).toBe(0); // Trying it: 60 credits
    expect(pays(30)).toBe(500); // Light: 150 credits
    expect(pays(60)).toBe(2000); // Typical: 300 credits
    expect(pays(200)).toBe(9000); // Heavy: 1,000 credits
  });

  test("a team of five pays $150 for 400 hours: 100 free each, pooled", () => {
    const usage = workspaceUsage(read({ a: 80, b: 80, c: 80, d: 80, e: 80 }), period, viewer("a"));
    expect(usage.usedCredits).toBe(2000);
    expect(usage.billedCents).toBe(15_000);
  });

  test("a stretch priced by an older card keeps that card's rate", () => {
    const older = { ...CARD, version: 1, sandboxCreditsPerAwakeHour: 10 };
    const current = { ...CARD, version: 2 };
    const usage = workspaceUsage(
      read({ solo: 10 }, { current, cards: [older, current] }),
      period,
      viewer("solo"),
    );
    expect(usage.usedCredits).toBe(100);
  });
});

describe("whom the free credits are counted for", () => {
  test("a member now, someone granted this period and gone, and a deleted account's grant", () => {
    // Ada and Ben are members; Cy left after his grant; one grant's account was deleted.
    const got = read(
      { ada: 30, ben: 34 },
      { granted: { userIds: ["ada", "ben", "cy"], departed: 1 } },
    );
    expect(countedPeople(got)).toBe(4);
    const usage = workspaceUsage(got, period, viewer("ada"));
    // 64 hours is 320 credits; 400 are free.
    expect(usage).toMatchObject({ people: 4, freeCredits: 400, billedCents: 0 });
  });

  test("grants go to the members who lack one, never to someone only their use names", () => {
    const got = read(
      { ada: 1, ben: 1 },
      {
        people: [person("ada", "admin"), person("ben"), person("cy", null)],
        granted: { userIds: ["ada"], departed: 0 },
      },
    );
    expect(ungranted(got)).toEqual(["ben"]);
    expect(countedPeople(got)).toBe(3);
  });
});

describe("where the meter cuts", () => {
  const anchor = new Date("2026-01-09T15:00:00Z");
  const t = (iso: string) => new Date(iso);

  test("not before an hour, and within one period", () => {
    expect(nextCut(t("2026-11-20T10:00:00Z"), anchor, t("2026-11-20T10:59:59.999Z"))).toBeNull();
  });

  test("an hour on, at the last whole second of the stretch", () => {
    expect(nextCut(t("2026-11-20T10:00:00.250Z"), anchor, t("2026-11-20T11:20:07.900Z"))).toEqual(
      t("2026-11-20T11:20:07.250Z"),
    );
    expect(CUT_EVERY_MS).toBe(3_600_000);
  });

  test("at the end of the period it began in, once that has passed, however short", () => {
    expect(nextCut(t("2026-12-08T23:55:00Z"), anchor, t("2026-12-09T00:00:30Z"))).toEqual(
      t("2026-12-09T00:00:00Z"),
    );
    // Down for a month: the first period end first, then the next on the next cut.
    expect(nextCut(t("2026-11-01T00:00:00Z"), anchor, t("2027-01-20T00:00:00Z"))).toEqual(
      t("2026-11-09T00:00:00Z"),
    );
    expect(nextCut(t("2026-11-09T00:00:00Z"), anchor, t("2027-01-20T00:00:00Z"))).toEqual(
      t("2026-12-09T00:00:00Z"),
    );
  });
});

describe("adjustments", () => {
  test("support's credits add to the free credits, and a correction takes some away", () => {
    // 64 hours is 320 credits; one person's 100 are free.
    const plus = workspaceUsage(read({ ada: 64 }, { adjustedCredits: 50 }), period, viewer("ada"));
    expect(plus).toMatchObject({ freeCredits: 150, billedCredits: 170, billedCents: 1700 });
    const minus = workspaceUsage(
      read({ ada: 64 }, { adjustedCredits: -30 }),
      period,
      viewer("ada"),
    );
    expect(minus).toMatchObject({ freeCredits: 70, billedCredits: 250, billedCents: 2500 });
  });

  test("free credits never go below zero, and none means as before", () => {
    expect(freeCredits(1, 100, -250)).toBe(0);
    expect(freeCredits(3, 100)).toBe(300);
    expect(freeCredits(3, 100, 0)).toBe(300);
    const usage = workspaceUsage(
      read({ ada: 64 }, { adjustedCredits: -500 }),
      period,
      viewer("ada"),
    );
    expect(usage).toMatchObject({ freeCredits: 0, billedCredits: 320 });
  });
});

describe("who sees what", () => {
  const team = read(
    { bryce: 10, maya: 4 },
    {
      rows: [
        {
          userId: "bryce",
          canvasId: "cnv_a",
          rateCardVersion: 1,
          seconds: 10 * HOUR,
          modelCredits: 0,
        },
        {
          userId: "maya",
          canvasId: "cnv_b",
          rateCardVersion: 1,
          seconds: 4 * HOUR,
          modelCredits: 0,
        },
        { userId: null, canvasId: null, rateCardVersion: 1, seconds: 2 * HOUR, modelCredits: 0 },
      ],
      canvases: [
        { id: "cnv_a", name: "Checkout", readable: true },
        { id: "cnv_b", name: "Secret project", readable: false },
      ],
    },
  );

  test("an admin sees everyone, nobody's use, and the canvases they may know of by name", () => {
    const usage = workspaceUsage(team, period, viewer("bryce"));
    expect(usage.canManage).toBe(true);
    expect(usage.unattributedCredits).toBe(10);
    // A deleted canvas's use is its own line, not "canvases you can't open".
    expect(usage.byCanvas).toEqual([
      { kind: "canvas", canvas: { id: "cnv_a", name: "Checkout" }, usedCredits: 50 },
      { kind: "deleted", canvas: null, usedCredits: 10 },
      { kind: "hidden", canvas: null, usedCredits: 20 },
    ]);
  });

  test("a member sees the totals and only their own use", () => {
    const usage = workspaceUsage(team, period, viewer("maya", "member"));
    expect(usage.usedCredits).toBe(80);
    expect(usage.canManage).toBe(false);
    expect(usage.mine.usedCredits).toBe(20);
    expect(usage.byPerson).toBeNull();
    expect(usage.byCanvas).toBeNull();
    expect(usage.unattributedCredits).toBeNull();
  });

  test("an admin who reaches the workspace only through shared repos sees no one else", () => {
    const usage = workspaceUsage(team, period, {
      ...viewer("bryce"),
      member: { role: "admin", githubAccess: "collaborator" },
    });
    expect(usage.byPerson).toBeNull();
  });
});

describe("the billing period", () => {
  const at = (iso: string) => new Date(iso);

  test("starts on the anchor's day, at midnight UTC", () => {
    expect(billingPeriod(at("2026-10-09T15:30:00Z"), at("2026-11-11T08:00:00Z"))).toEqual({
      start: at("2026-11-09T00:00:00Z"),
      end: at("2026-12-09T00:00:00Z"),
    });
    expect(billingPeriod(at("2026-10-09T15:30:00Z"), at("2026-11-08T23:59:59Z"))).toEqual({
      start: at("2026-10-09T00:00:00Z"),
      end: at("2026-11-09T00:00:00Z"),
    });
  });

  test("a day past a month's end starts it on its last day", () => {
    const anchor = at("2026-01-31T12:00:00Z");
    expect(billingPeriod(anchor, at("2027-02-15T00:00:00Z"))).toEqual({
      start: at("2027-01-31T00:00:00Z"),
      end: at("2027-02-28T00:00:00Z"),
    });
    expect(billingPeriod(anchor, at("2028-02-29T10:00:00Z")).start).toEqual(
      at("2028-02-29T00:00:00Z"),
    );
    expect(billingPeriod(anchor, at("2027-03-31T00:00:00Z")).start).toEqual(
      at("2027-03-31T00:00:00Z"),
    );
  });

  test("turns over the year", () => {
    expect(billingPeriod(at("2026-05-20T00:00:00Z"), at("2027-01-05T00:00:00Z"))).toEqual({
      start: at("2026-12-20T00:00:00Z"),
      end: at("2027-01-20T00:00:00Z"),
    });
  });
});

describe("a breakdown adds up to the headline", () => {
  const minutes = (m: number) => m * 60;

  test("the second run's numbers: 4 credits used, and the canvases share all 4", () => {
    // Canvases at 1.6, 0.4 and 2.4 credits of awake time (4.4 in all, 4 used): rounded each on
    // its own they read 1 + 0 + 2 = 3 against a headline of 4.
    const usage = workspaceUsage(
      read(
        { bryce: 0 },
        {
          rows: [
            ["cnv_a", 19.2],
            ["cnv_b", 4.8],
            [null, 28.8],
          ].map(([canvasId, m]) => ({
            userId: "bryce",
            canvasId: canvasId as string | null,
            rateCardVersion: 1,
            seconds: minutes(m as number),
            modelCredits: 0,
          })),
          canvases: [
            { id: "cnv_a", name: "Checkout", readable: true },
            { id: "cnv_b", name: "Onboarding", readable: true },
          ],
        },
      ),
      period,
      viewer("bryce"),
    );
    expect(usage.usedCredits).toBe(4);
    expect(usage.byCanvas?.map((row) => [row.kind, row.usedCredits])).toEqual([
      ["canvas", 2],
      ["canvas", 0],
      ["deleted", 2],
    ]);
    expect(usage.byPerson?.map((row) => row.usedCredits)).toEqual([4]);
  });

  test("apportion: each part is its use rounded down or up, and they sum to the total", () => {
    return fc.assert(
      fc.property(fc.array(fc.nat({ max: 50 * HOUR }), { maxLength: 40 }), (seconds) => {
        const parts = seconds.map((s) => awakeUnits(s, 5));
        const credits = apportion(parts);
        const total = creditsOf(parts.reduce((sum, units) => sum + units, 0));
        expect(credits.reduce((sum, n) => sum + n, 0)).toBe(total);
        for (const [i, units] of parts.entries()) {
          expect([0, 1]).toContain(credits[i]! - creditsOf(units));
        }
      }),
    );
  });

  test("by canvas and by person, for any usage, sum exactly to what was used", () => {
    const people = ["ada", "bryce", "maya"];
    const canvases = ["cnv_a", "cnv_b", "cnv_c", "cnv_d"];
    const second: RateCardNumbers = { ...CARD, version: 2, sandboxCreditsPerAwakeHour: 2.5 };
    const row = fc.record({
      userId: fc.constantFrom<string | null>(null, ...people),
      canvasId: fc.constantFrom<string | null>(null, "cnv_unknown", ...canvases),
      rateCardVersion: fc.constantFrom(1, 2),
      seconds: fc.nat({ max: 20 * HOUR }),
      modelCredits: fc.integer({ min: 0, max: 99_999 }).map((n) => n / 10_000),
    });
    const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);
    return fc.assert(
      fc.property(
        fc.array(row, { maxLength: 30 }),
        fc.array(fc.boolean(), { minLength: canvases.length, maxLength: canvases.length }),
        (rows, readable) => {
          const got = workspaceUsage(
            {
              ...read({}),
              cards: [CARD, second],
              rows,
              people: people.map((id) => person(id, "admin")),
              canvases: canvases.map((id, i) => ({ id, name: id, readable: readable[i]! })),
            },
            period,
            viewer("ada"),
          );
          expect(sum(got.byCanvas!.map((d) => d.usedCredits))).toBe(got.usedCredits);
          expect(sum(got.byPerson!.map((p) => p.usedCredits)) + got.unattributedCredits!).toBe(
            got.usedCredits,
          );
          // An admin's own line is the number their list shows for them.
          expect(got.mine.usedCredits).toBe(
            got.byPerson!.find((p) => p.person.id === "ada")!.usedCredits,
          );
        },
      ),
    );
  });

  test("a member who sees only their own line sees their own use, which others' can't move", () => {
    const row = (userId: string, seconds: number) => ({
      userId,
      canvasId: null,
      rateCardVersion: 1,
      seconds,
      modelCredits: 0,
    });
    // 0.6 credits theirs, then someone else's use whose remainder passes theirs.
    const people = [person("maya"), person("ada", "admin")];
    const theirs = [row("maya", 432)];
    const usage = (rows: ReturnType<typeof row>[]) =>
      workspaceUsage({ ...read({}), rows, people }, period, viewer("maya", "member"));
    expect(usage(theirs).mine.usedCredits).toBe(0);
    return fc.assert(
      fc.property(fc.array(fc.nat({ max: 20 * HOUR }), { maxLength: 10 }), (others) => {
        const got = usage([...theirs, ...others.map((s) => row("ada", s))]);
        expect(got.byPerson).toBeNull();
        expect(got.mine.usedCredits).toBe(creditsOf(awakeUnits(432, 5)));
      }),
    );
  });

  test("a tie goes the same way however the rows came back", () => {
    // Half a credit in each of three canvases: 1.5 in all, 1 used.
    const rows = ["cnv_a", "cnv_b", "cnv_c"].map((canvasId) => ({
      userId: "bryce",
      canvasId,
      rateCardVersion: 1,
      seconds: 360,
      modelCredits: 0,
    }));
    const canvases = ["cnv_a", "cnv_b", "cnv_c"].map((id) => ({ id, name: id, readable: true }));
    const credited = (order: typeof rows) =>
      workspaceUsage(
        read({ bryce: 0 }, { rows: order, canvases }),
        period,
        viewer("bryce"),
      ).byCanvas?.find((row) => row.usedCredits === 1)?.canvas?.id;
    expect(credited(rows)).toBe("cnv_a");
    expect(credited(rows.toReversed())).toBe("cnv_a");
  });
});

describe("what a period is charged", () => {
  test("what was billed, up to the cap and never past it", () => {
    // $100 at 10 cents a credit pays for 1,000 credits.
    expect(chargedCredits(220, 10_000, 100_000)).toBe(220);
    expect(chargedCredits(999, 10_000, 100_000)).toBe(999);
    expect(chargedCredits(1000, 10_000, 100_000)).toBe(1000);
    expect(chargedCredits(1001, 10_000, 100_000)).toBe(1000);
    expect(chargedCredits(0, 10_000, 100_000)).toBe(0);
  });

  test("a cap of $1 with a 10-cent credit charges at most 10 credits, $1.00", () => {
    expect(chargedCredits(9, 100, 100_000)).toBe(9);
    expect(chargedCredits(10, 100, 100_000)).toBe(10);
    expect(chargedCredits(11, 100, 100_000)).toBe(10);
    expect(chargedCredits(5000, 100, 100_000)).toBe(10);
    expect(chargedCents(10, 100_000)).toBe(100);
  });

  test("a credit price that doesn't divide the cap charges the whole credits under it", () => {
    // $1 at $0.123456 a credit pays for 8 credits ($0.98), not 9 ($1.11).
    expect(chargedCredits(50, 100, 123_456)).toBe(8);
    expect(chargedCents(8, 123_456)).toBe(98);
  });

  test("the charge never passes what was billed or the cap, and is the most the cap allows", () => {
    return fc.assert(
      fc.property(
        fc.nat({ max: 10_000_000 }),
        fc.integer({ min: 100, max: 100_000_000 }),
        fc.integer({ min: 1, max: 10_000_000 }),
        (billed, capCents, creditMicrousd) => {
          const charged = chargedCredits(billed, capCents, creditMicrousd);
          expect(charged).toBeLessThanOrEqual(billed);
          expect(chargedCents(charged, creditMicrousd)).toBeLessThanOrEqual(capCents);
          // One more credit would cost more than the cap, in exact millionths of a dollar.
          if (charged < billed) {
            expect((charged + 1) * creditMicrousd).toBeGreaterThan(capCents * 10_000);
          }
        },
      ),
      { seed: 6, numRuns: 2000 },
    );
  });

  test("a charge under $1.00 is not invoiced", () => {
    expect(MIN_INVOICE_CENTS).toBe(100);
    expect(chargedCents(9, 100_000)).toBeLessThan(MIN_INVOICE_CENTS);
    expect(chargedCents(10, 100_000)).toBe(MIN_INVOICE_CENTS);
  });
});

describe("the warning before the cap", () => {
  test("at 80% of the cap exactly, and not a cent before", () => {
    expect(capWarning(0, 10_000, 0.8)).toBe(false);
    expect(capWarning(7999, 10_000, 0.8)).toBe(false);
    expect(capWarning(8000, 10_000, 0.8)).toBe(true);
    expect(capWarning(10_000, 10_000, 0.8)).toBe(true);
    expect(capWarning(12_000, 10_000, 0.8)).toBe(true);
  });

  test("a $1 cap warns at 80 cents", () => {
    expect(capWarning(79, 100, 0.8)).toBe(false);
    expect(capWarning(80, 100, 0.8)).toBe(true);
  });

  test("a fraction that floating point can't hold still compares exactly", () => {
    // 100 × 0.07 is 7.000000000000001 in floating point, but 7 cents is 7% of $1, and
    // 10,000 × 0.035 is 350.00000000000006, but $3.50 is 3.5% of $100. A plain multiply misses both.
    expect(100 * 0.07).toBeGreaterThan(7);
    expect(capWarning(7, 100, 0.07)).toBe(true);
    expect(capWarning(6, 100, 0.07)).toBe(false);
    expect(10_000 * 0.035).toBeGreaterThan(350);
    expect(capWarning(350, 10_000, 0.035)).toBe(true);
    expect(capWarning(349, 10_000, 0.035)).toBe(false);
    expect(capWarning(575, 1000, 0.575)).toBe(true);
    expect(capWarning(574, 1000, 0.575)).toBe(false);
  });
});

describe("the billing gate", () => {
  const now = new Date("2026-11-20T12:00:00.000Z");
  const base: BillingGateInput = {
    usedCredits: 0,
    freeCredits: 100,
    billedCents: 0,
    capCents: 10_000,
    hasCard: false,
    pastDueSince: null,
    now,
    graceMs: GRACE_MS,
  };
  const gate = (over: Partial<BillingGateInput>) => billingGate({ ...base, ...over });
  const ago = (ms: number) => new Date(now.getTime() - ms);

  test("the grace is 7 days to the millisecond", () => {
    expect(GRACE_MS).toBe(604_800_000);
  });

  const cases: [string, Partial<BillingGateInput>, ReturnType<typeof billingGate>][] = [
    ["nothing used, no card", {}, "ok"],
    ["free credits nearly used, no card", { usedCredits: 99 }, "ok"],
    ["free credits exactly used up, no card", { usedCredits: 100 }, "free_used"],
    ["past free, no card", { usedCredits: 140, billedCents: 400 }, "free_used"],
    ["no free credits counted and nothing used, no card", { freeCredits: 0 }, "free_used"],
    [
      "past free with a card, under the cap",
      { usedCredits: 140, billedCents: 400, hasCard: true },
      "ok",
    ],
    ["a cent under the cap", { hasCard: true, usedCredits: 1099, billedCents: 9999 }, "ok"],
    [
      "exactly at the cap",
      { hasCard: true, usedCredits: 1100, billedCents: 10_000 },
      "cap_reached",
    ],
    ["past the cap", { hasCard: true, usedCredits: 1200, billedCents: 11_000 }, "cap_reached"],
    [
      "a $1 cap reached by ten 10-cent credits",
      { hasCard: true, usedCredits: 110, billedCents: 100, capCents: 100 },
      "cap_reached",
    ],
    [
      "a $1 cap with nine credits billed",
      { hasCard: true, usedCredits: 109, billedCents: 90, capCents: 100 },
      "ok",
    ],
    [
      "no card and inside free: the cap is not looked at",
      { usedCredits: 50, billedCents: 20_000 },
      "ok",
    ],
    [
      "past due a millisecond short of 7 days",
      { hasCard: true, pastDueSince: ago(GRACE_MS - 1) },
      "ok",
    ],
    ["past due exactly 7 days", { hasCard: true, pastDueSince: ago(GRACE_MS) }, "payment_failed"],
    ["past due longer", { hasCard: true, pastDueSince: ago(GRACE_MS + 1) }, "payment_failed"],
    [
      "past due inside its grace, at the cap",
      { hasCard: true, billedCents: 10_000, pastDueSince: ago(GRACE_MS - 1) },
      "cap_reached",
    ],
    [
      "payment failed comes before the cap",
      { hasCard: true, billedCents: 10_000, pastDueSince: ago(GRACE_MS) },
      "payment_failed",
    ],
    [
      "payment failed comes before free used",
      { usedCredits: 100, pastDueSince: ago(GRACE_MS) },
      "payment_failed",
    ],
    [
      "past due in the future (clock skew) is inside the grace",
      { hasCard: true, pastDueSince: new Date(now.getTime() + 1) },
      "ok",
    ],
  ];
  for (const [name, over, expected] of cases) {
    test(name, () => expect(gate(over)).toBe(expected));
  }

  test("the grace passed in is the one used", () => {
    expect(gate({ hasCard: true, pastDueSince: ago(1000), graceMs: 1000 })).toBe("payment_failed");
    expect(gate({ hasCard: true, pastDueSince: ago(999), graceMs: 1000 })).toBe("ok");
  });
});
