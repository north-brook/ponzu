import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { seedUser } from "../fixtures.ts";
import { users } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { digestRecipient, digestsDue, stampDigestSent } from "./notifications.ts";
import { run } from "./run.ts";

/*
 * Who the daily email is due for: on, with an address, 9:00 or later in their zone, and not yet
 * sent for that local date.
 */

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

let serial = 0;
async function person(
  set: Partial<{ emailDigest: boolean; timeZone: string | null; email: string | null }> = {},
) {
  const user = await seedUser(db, `digest-${serial++}`);
  await run(
    db
      .update(users)
      .set({ emailDigest: true, ...set })
      .where(eq(users.id, user.id)),
  );
  return user.id;
}

/** In any order: people made in the same instant tie on their creation time. */
const unordered = (due: { userId: string; localDate: string }[]) =>
  [...due].sort((a, b) => a.userId.localeCompare(b.userId));

beforeEach(async () => {
  // Each test sees only its own people.
  await run(db.update(users).set({ emailDigest: false }));
});

describe("digestsDue", () => {
  test("is due from 9:00 in the person's zone, for that zone's date", async () => {
    const tokyo = await person({ timeZone: "Asia/Tokyo" });
    const lisbon = await person({ timeZone: "Europe/Lisbon" });
    const york = await person({ timeZone: "America/New_York" });

    // 23:59 UTC on 11 Nov: 08:59 on the 12th in Tokyo, 23:59 on the 11th in Lisbon, 18:59 on
    // the 11th in New York.
    expect(unordered(await digestsDue(db, { now: new Date("2026-11-11T23:59:00Z") }))).toEqual(
      unordered([
        { userId: lisbon, localDate: "2026-11-11" },
        { userId: york, localDate: "2026-11-11" },
      ]),
    );
    // 00:00 UTC: 09:00 on the 12th in Tokyo; midnight in Lisbon, a new day before 9:00.
    expect(unordered(await digestsDue(db, { now: new Date("2026-11-12T00:00:00Z") }))).toEqual(
      unordered([
        { userId: tokyo, localDate: "2026-11-12" },
        { userId: york, localDate: "2026-11-11" },
      ]),
    );
    // 14:00 UTC is 09:00 in New York (EST, UTC-5, in November).
    const at14 = await digestsDue(db, { now: new Date("2026-11-12T14:00:00Z") });
    expect(unordered(at14)).toEqual(
      unordered([
        { userId: tokyo, localDate: "2026-11-12" },
        { userId: lisbon, localDate: "2026-11-12" },
        { userId: york, localDate: "2026-11-12" },
      ]),
    );
    expect(await digestsDue(db, { now: new Date("2026-11-12T13:59:00Z") })).not.toContainEqual({
      userId: york,
      localDate: "2026-11-12",
    });
  });

  test("goes once a local date: stamped, it is not due again until the next day's 9:00", async () => {
    const id = await person({ timeZone: "Europe/Lisbon" });
    const nine = new Date("2026-11-12T09:00:00Z");
    expect(await digestsDue(db, { now: nine })).toEqual([{ userId: id, localDate: "2026-11-12" }]);
    await stampDigestSent(db, { userId: id, localDate: "2026-11-12" });
    expect(await digestsDue(db, { now: nine })).toEqual([]);
    expect(await digestsDue(db, { now: new Date("2026-11-12T23:00:00Z") })).toEqual([]);
    expect(await digestsDue(db, { now: new Date("2026-11-13T08:59:00Z") })).toEqual([]);
    expect(await digestsDue(db, { now: new Date("2026-11-13T09:00:00Z") })).toEqual([
      { userId: id, localDate: "2026-11-13" },
    ]);
    // A late stamp for an earlier date does not move it back.
    await stampDigestSent(db, { userId: id, localDate: "2026-11-13" });
    await stampDigestSent(db, { userId: id, localDate: "2026-11-12" });
    expect((await digestRecipient(db, id))?.digestSentOn).toBe("2026-11-13");
  });

  test("no zone, or one Postgres does not know, is New York's", async () => {
    const none = await person({ timeZone: null });
    const unknown = await person({ timeZone: "Mars/Olympus_Mons" });
    // 13:59 UTC is 08:59 in New York; 14:00 is 09:00.
    expect(await digestsDue(db, { now: new Date("2026-11-12T13:59:00Z") })).toEqual([]);
    expect(unordered(await digestsDue(db, { now: new Date("2026-11-12T14:00:00Z") }))).toEqual(
      unordered([
        { userId: none, localDate: "2026-11-12" },
        { userId: unknown, localDate: "2026-11-12" },
      ]),
    );
  });

  test("is never due with the email off or no address, and takes at most `limit`", async () => {
    await person({ emailDigest: false, timeZone: "UTC" });
    await person({ email: null, timeZone: "UTC" });
    const noon = new Date("2026-11-12T12:00:00Z");
    expect(await digestsDue(db, { now: noon })).toEqual([]);
    const first = await person({ timeZone: "UTC" });
    const second = await person({ timeZone: "UTC" });
    const one = await digestsDue(db, { now: noon, limit: 1 });
    expect(one).toHaveLength(1);
    expect([first, second]).toContain(one[0]!.userId);
    expect(unordered(await digestsDue(db, { now: noon }))).toEqual(
      unordered([
        { userId: first, localDate: "2026-11-12" },
        { userId: second, localDate: "2026-11-12" },
      ]),
    );
  });
});

test("digestRecipient answers the person's email facts, or null", async () => {
  const id = await person({ timeZone: "UTC" });
  expect(await digestRecipient(db, id)).toEqual({
    email: expect.stringMatching(/@example\.com$/),
    emailDigest: true,
    digestSentOn: null,
  });
  expect(await digestRecipient(db, "usr_gone")).toBeNull();
});
