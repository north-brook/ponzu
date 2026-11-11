import { describe, expect, test } from "bun:test";
import type { RateCardNumbers, UsagePerson, WorkspaceUsageRead } from "@ponzu/db";
import fc from "fast-check";
import {
  apportion,
  awakeUnits,
  billedCredits,
  centsFor,
  creditsOf,
  creditUnits,
  freeCredits,
  lowestCapUsd,
} from "./credits.ts";
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

/** A period of awake hours by person, each in a design of their own. */
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
      designId: `des_${id}`,
      rateCardVersion: 1,
      seconds: hours[id]! * HOUR,
      modelCredits: 0,
    })),
    people: ids.map((id, i) => person(id, i === 0 ? "admin" : "member")),
    designs: ids.map((id) => ({ id: `des_${id}`, name: `${id}'s design`, readable: true })),
    granted: { userIds: [], departed: 0 },
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

describe("who sees what", () => {
  const team = read(
    { bryce: 10, maya: 4 },
    {
      rows: [
        {
          userId: "bryce",
          designId: "des_a",
          rateCardVersion: 1,
          seconds: 10 * HOUR,
          modelCredits: 0,
        },
        {
          userId: "maya",
          designId: "des_b",
          rateCardVersion: 1,
          seconds: 4 * HOUR,
          modelCredits: 0,
        },
        { userId: null, designId: null, rateCardVersion: 1, seconds: 2 * HOUR, modelCredits: 0 },
      ],
      designs: [
        { id: "des_a", name: "Checkout", readable: true },
        { id: "des_b", name: "Secret project", readable: false },
      ],
    },
  );

  test("an admin sees everyone, nobody's use, and the designs they may know of by name", () => {
    const usage = workspaceUsage(team, period, viewer("bryce"));
    expect(usage.canManage).toBe(true);
    expect(usage.unattributedCredits).toBe(10);
    // A deleted design's use is its own line, not "designs you can't open".
    expect(usage.byDesign).toEqual([
      { kind: "design", design: { id: "des_a", name: "Checkout" }, usedCredits: 50 },
      { kind: "deleted", design: null, usedCredits: 10 },
      { kind: "hidden", design: null, usedCredits: 20 },
    ]);
  });

  test("a member sees the totals and only their own use", () => {
    const usage = workspaceUsage(team, period, viewer("maya", "member"));
    expect(usage.usedCredits).toBe(80);
    expect(usage.canManage).toBe(false);
    expect(usage.mine.usedCredits).toBe(20);
    expect(usage.byPerson).toBeNull();
    expect(usage.byDesign).toBeNull();
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

  test("the second run's numbers: 4 credits used, and the designs share all 4", () => {
    // Designs at 1.6, 0.4 and 2.4 credits of awake time (4.4 in all, 4 used): rounded each on
    // its own they read 1 + 0 + 2 = 3 against a headline of 4.
    const usage = workspaceUsage(
      read(
        { bryce: 0 },
        {
          rows: [
            ["des_a", 19.2],
            ["des_b", 4.8],
            [null, 28.8],
          ].map(([designId, m]) => ({
            userId: "bryce",
            designId: designId as string | null,
            rateCardVersion: 1,
            seconds: minutes(m as number),
            modelCredits: 0,
          })),
          designs: [
            { id: "des_a", name: "Checkout", readable: true },
            { id: "des_b", name: "Onboarding", readable: true },
          ],
        },
      ),
      period,
      viewer("bryce"),
    );
    expect(usage.usedCredits).toBe(4);
    expect(usage.byDesign?.map((row) => [row.kind, row.usedCredits])).toEqual([
      ["design", 2],
      ["design", 0],
      ["deleted", 2],
    ]);
    expect(usage.byPerson?.map((row) => row.usedCredits)).toEqual([4]);
  });

  test("apportion: each part is its use rounded down or up, and they sum to the total", () => {
    fc.assert(
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

  test("by design and by person, for any usage, sum exactly to what was used", () => {
    const people = ["ada", "bryce", "maya"];
    const designs = ["des_a", "des_b", "des_c", "des_d"];
    const second: RateCardNumbers = { ...CARD, version: 2, sandboxCreditsPerAwakeHour: 2.5 };
    const row = fc.record({
      userId: fc.constantFrom<string | null>(null, ...people),
      designId: fc.constantFrom<string | null>(null, "des_unknown", ...designs),
      rateCardVersion: fc.constantFrom(1, 2),
      seconds: fc.nat({ max: 20 * HOUR }),
      modelCredits: fc.integer({ min: 0, max: 99_999 }).map((n) => n / 10_000),
    });
    const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);
    fc.assert(
      fc.property(
        fc.array(row, { maxLength: 30 }),
        fc.array(fc.boolean(), { minLength: designs.length, maxLength: designs.length }),
        (rows, readable) => {
          const got = workspaceUsage(
            {
              ...read({}),
              cards: [CARD, second],
              rows,
              people: people.map((id) => person(id, "admin")),
              designs: designs.map((id, i) => ({ id, name: id, readable: readable[i]! })),
            },
            period,
            viewer("ada"),
          );
          expect(sum(got.byDesign!.map((d) => d.usedCredits))).toBe(got.usedCredits);
          expect(sum(got.byPerson!.map((p) => p.usedCredits)) + got.unattributedCredits!).toBe(
            got.usedCredits,
          );
          // The viewer's own line is the number the admin's list shows for them.
          expect(got.mine.usedCredits).toBe(
            got.byPerson!.find((p) => p.person.id === "ada")!.usedCredits,
          );
        },
      ),
    );
  });

  test("a tie goes the same way however the rows came back", () => {
    // Half a credit in each of three designs: 1.5 in all, 1 used.
    const rows = ["des_a", "des_b", "des_c"].map((designId) => ({
      userId: "bryce",
      designId,
      rateCardVersion: 1,
      seconds: 360,
      modelCredits: 0,
    }));
    const designs = ["des_a", "des_b", "des_c"].map((id) => ({ id, name: id, readable: true }));
    const credited = (order: typeof rows) =>
      workspaceUsage(read({ bryce: 0 }, { rows: order, designs }), period, viewer("bryce"))
        .byDesign?.find((row) => row.usedCredits === 1)?.design?.id;
    expect(credited(rows)).toBe("des_a");
    expect(credited(rows.toReversed())).toBe("des_a");
  });
});
