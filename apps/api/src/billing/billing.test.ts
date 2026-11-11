import { describe, expect, test } from "bun:test";
import type { RateCardNumbers, UsagePerson, WorkspaceUsageRead } from "@ponzu/db";
import {
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
    expect(usage.byDesign).toEqual([
      { design: { id: "des_a", name: "Checkout" }, usedCredits: 50 },
      { design: null, usedCredits: 30 },
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
