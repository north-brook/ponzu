import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { emptyDoc } from "@ponzu/core";
import { eq, sql } from "drizzle-orm";
import { seedUser, seedWorkspace } from "../fixtures.ts";
import { users } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { createCanvas } from "./canvases.ts";
import { recapMerges, recapPerson, recapsDue, stampQuietRecaps, stampRecapSent } from "./email.ts";
import { run } from "./run.ts";

/*
 * Who the Friday recap is due for, and what it counts: on Fridays from 15:00 in the person's
 * zone (New York when unknown), once a Friday, and only merges from canvases they own in the week
 * `[last Friday 15:00, this Friday 15:00)`, computed in Postgres across daylight saving.
 *
 * Dates: Friday 2026-10-30 is the last Friday of summer time in New York (UTC-4); summer time
 * ends on Sunday 2026-11-01; Friday 2026-11-06 is in winter time (UTC-5).
 */

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

const JOB = { kind: "email.recap", keyPrefix: "recap" };

beforeEach(async () => {
  // Each test sees only its own people.
  await run(db.update(users).set({ emailRecap: false }));
});

let serial = 0;
async function person(set: Partial<{ timeZone: string | null; email: string | null }> = {}) {
  const user = await seedUser(db, `recap-${serial++}`);
  await run(
    db
      .update(users)
      .set({ emailRecap: true, timeZone: "America/New_York", ...set })
      .where(eq(users.id, user.id)),
  );
  return user.id;
}

/** A canvas `ownerId` owns, in a workspace of its own. */
async function canvasOf(ownerId: string, name = "Kettle onboarding") {
  const workspace = await seedWorkspace(db, `ws-${serial++}`);
  return createCanvas(db, {
    workspaceId: workspace.id,
    repoId: null,
    ownerId,
    claudeAccountId: null,
    name,
    branch: null,
    doc: emptyDoc(name),
  });
}

/** The notice Ponzu writes when it first sees pull request `number` reach `state`. */
async function notice(canvasId: string, number: number, at: string, state = "merged") {
  await run(
    db.execute(sql`
      insert into thread_items (id, canvas_id, kind, payload, created_at)
      values (${`ti_pr-${number}-${state}`}, ${canvasId}, 'notice',
              ${JSON.stringify({ type: "pull_request", number, state, title: "Secret title" })}::jsonb,
              ${at}::timestamptz)
    `),
  );
}

const due = async (now: string) =>
  (await recapsDue(db, { now: new Date(now), job: JOB })).map(({ userId, friday, timeZone }) => ({
    userId,
    friday,
    timeZone,
  }));

describe("when it is due", () => {
  test("from 15:00 on Friday in New York, across the change from summer to winter time", async () => {
    const id = await person();
    const canvas = await canvasOf(id);
    await notice(canvas.id, 1, "2026-10-28T12:00:00Z");
    await notice(canvas.id, 2, "2026-11-04T12:00:00Z");

    // Summer time: 15:00 EDT is 19:00 UTC.
    expect(await due("2026-10-30T18:59:00Z")).toEqual([]);
    expect(await due("2026-10-30T19:00:00Z")).toEqual([
      { userId: id, friday: "2026-10-30", timeZone: "America/New_York" },
    ]);
    await stampRecapSent(db, {
      userId: id,
      friday: "2026-10-30",
      sent: true,
      now: new Date("2026-10-30T19:00:00Z"),
    });
    // Handled: not due again that Friday, nor on Saturday.
    expect(await due("2026-10-30T23:00:00Z")).toEqual([]);
    expect(await due("2026-10-31T19:00:00Z")).toEqual([]);

    // Winter time: 15:00 EST is 20:00 UTC, an hour later in UTC than the week before.
    expect(await due("2026-11-06T19:59:00Z")).toEqual([]);
    expect(await due("2026-11-06T20:00:00Z")).toEqual([
      { userId: id, friday: "2026-11-06", timeZone: "America/New_York" },
    ]);
  });

  test("the week's edges: a merge at 14:59 on Friday is that week's, one at 15:00 is the next's", async () => {
    const id = await person();
    const canvas = await canvasOf(id);
    // 14:59 and 15:00 EDT on Friday 30 October.
    await notice(canvas.id, 1, "2026-10-30T18:59:00Z");
    await notice(canvas.id, 2, "2026-10-30T19:00:00Z");
    // 14:59 EST on Friday 6 November, in winter time.
    await notice(canvas.id, 3, "2026-11-06T19:59:00Z");
    // 15:00 EST on Friday 6 November: the week after.
    await notice(canvas.id, 4, "2026-11-06T20:00:00Z");

    const numbers = async (friday: string) =>
      (await recapMerges(db, { userId: id, friday, timeZone: "America/New_York" }))
        .map((merge) => merge.number)
        .sort();
    expect(await numbers("2026-10-30")).toEqual([1]);
    expect(await numbers("2026-11-06")).toEqual([2, 3]);
    expect(await numbers("2026-11-13")).toEqual([4]);
  });

  test("Kolkata and Chatham are timed in their own zones", async () => {
    const kolkata = await person({ timeZone: "Asia/Kolkata" });
    const chatham = await person({ timeZone: "Pacific/Chatham" });
    for (const id of [kolkata, chatham]) {
      await notice((await canvasOf(id)).id, 1, "2026-11-11T00:00:00Z");
    }
    // Kolkata is UTC+5:30: 15:00 on Friday 13 November is 09:30 UTC.
    // Chatham is UTC+13:45 in its summer: 15:00 on Friday 13 November is 01:15 UTC that day.
    expect(await due("2026-11-13T01:14:00Z")).toEqual([]);
    expect(await due("2026-11-13T01:15:00Z")).toEqual([
      { userId: chatham, friday: "2026-11-13", timeZone: "Pacific/Chatham" },
    ]);
    expect(await due("2026-11-13T09:29:00Z")).toEqual([
      { userId: chatham, friday: "2026-11-13", timeZone: "Pacific/Chatham" },
    ]);
    expect((await due("2026-11-13T09:30:00Z")).map((row) => row.userId).sort()).toEqual(
      [kolkata, chatham].sort(),
    );
    // Saturday 14 November begins at 10:15 UTC on the 13th in Chatham: its Friday is over,
    // and it is not caught up on.
    expect((await due("2026-11-13T10:15:00Z")).map((row) => row.userId)).toEqual([kolkata]);
  });

  test("a zone Postgres does not know is timed in New York, and nobody else is affected", async () => {
    const odd = await person({ timeZone: "Mars/Olympus_Mons" });
    const lisbon = await person({ timeZone: "Europe/Lisbon" });
    for (const id of [odd, lisbon]) {
      await notice((await canvasOf(id)).id, 1, "2026-11-11T00:00:00Z");
    }
    // 15:00 in Lisbon (UTC in November).
    expect(await due("2026-11-13T15:00:00Z")).toEqual([
      { userId: lisbon, friday: "2026-11-13", timeZone: "Europe/Lisbon" },
    ]);
    // 15:00 in New York.
    expect((await due("2026-11-13T20:00:00Z")).map((row) => row.userId).sort()).toEqual(
      [odd, lisbon].sort(),
    );
    expect((await due("2026-11-13T20:00:00Z")).find((row) => row.userId === odd)?.timeZone).toBe(
      "America/New_York",
    );
    // The merges read the same way when handed the unknown name.
    expect(
      await recapMerges(db, { userId: odd, friday: "2026-11-13", timeZone: "Mars/Olympus_Mons" }),
    ).toHaveLength(1);
  });

  test("the switch off, or no address: never due and never stamped", async () => {
    const off = await person();
    await run(db.update(users).set({ emailRecap: false }).where(eq(users.id, off)));
    const none = await person({ email: null });
    for (const id of [off, none]) await notice((await canvasOf(id)).id, 1, "2026-11-11T00:00:00Z");
    expect(await due("2026-11-13T20:00:00Z")).toEqual([]);
    expect(await stampQuietRecaps(db, { now: new Date("2026-11-13T20:00:00Z") })).toBe(0);
    expect((await recapPerson(db, off))!.recapSentOn).toBeNull();
  });
});

describe("the quiet are stamped in one statement, and only they", () => {
  test("someone with nothing merged from a canvas they own is stamped and never in the batch", async () => {
    const shipped = await person();
    const quiet = await person();
    const elsewhere = await person();
    await notice((await canvasOf(shipped)).id, 41, "2026-11-10T15:00:00Z");
    // Merges that do not count for `quiet`: an opened pull request on their own canvas, one
    // merged before the week, and a merge on a canvas someone else owns.
    const theirs = await canvasOf(quiet);
    await notice(theirs.id, 7, "2026-11-10T15:00:00Z", "opened");
    await notice(theirs.id, 8, "2026-11-01T15:00:00Z");
    await notice((await canvasOf(elsewhere)).id, 9, "2026-11-10T15:00:00Z");

    const now = new Date("2026-11-13T20:00:00Z");
    expect(await stampQuietRecaps(db, { now })).toBe(1);
    expect((await recapPerson(db, quiet))!.recapSentOn).toBe("2026-11-13");
    expect((await recapPerson(db, quiet))!.recapFirstSentAt).toBeNull();
    expect((await recapPerson(db, shipped))!.recapSentOn).toBeNull();
    expect((await due(now.toISOString())).map((row) => row.userId).sort()).toEqual(
      [shipped, elsewhere].sort(),
    );
    // Run again: nobody new to stamp.
    expect(await stampQuietRecaps(db, { now })).toBe(0);
  });

  test("someone whose recap job is still waiting is left to it", async () => {
    const id = await person();
    await notice((await canvasOf(id)).id, 1, "2026-11-11T00:00:00Z");
    await run(
      db.execute(sql`
        insert into jobs (id, kind, key, payload, run_at)
        values ('job_recap_waiting', 'email.recap', ${`recap:${id}:2026-11-13`}, '{}'::jsonb, now())
      `),
    );
    expect(await due("2026-11-13T20:00:00Z")).toEqual([]);
    await run(db.execute(sql`delete from jobs where id = 'job_recap_waiting'`));
    expect(await due("2026-11-13T20:00:00Z")).toHaveLength(1);
  });

  test("5,000 people: one statement stamps everyone with nothing, the batch takes the rest", async () => {
    const owners: string[] = [];
    for (let i = 0; i < 30; i++) {
      const id = await person();
      owners.push(id);
      await notice((await canvasOf(id, `Canvas ${i}`)).id, i + 1, "2026-11-12T12:00:00Z");
    }
    await run(
      db.execute(sql`
        insert into users (id, workos_user_id, github_user_id, github_login, email, email_recap,
                           time_zone)
        select 'usr_bulk_' || n, 'user_bulk_' || n, 900000000 + n, 'bulk-' || n,
               'bulk-' || n || '@example.com', true,
               (array['America/New_York', 'Europe/Lisbon', 'Europe/Berlin', 'Nowhere/Else'])[1 + n % 4]
          from generate_series(1, 4970) as n
      `),
    );
    // 20:00 UTC on Friday: 15:00 or later in every one of those zones.
    const now = new Date("2026-11-13T20:00:00Z");
    expect(await stampQuietRecaps(db, { now })).toBe(4970);
    const first = await recapsDue(db, { now, limit: 20, job: JOB });
    expect(first).toHaveLength(20);
    for (const { userId } of first) expect(owners).toContain(userId);
    const [{ quiet }] = (
      (await run(
        db.execute(
          sql`select count(*)::int as quiet from users where id like 'usr_bulk_%' and recap_sent_on = '2026-11-13'`,
        ),
      )) as unknown as { rows: { quiet: number }[] }
    ).rows as [{ quiet: number }];
    expect(Number(quiet)).toBe(4970);
    await run(db.execute(sql`delete from users where id like 'usr_bulk_%'`));
  });
});

describe("what a week holds", () => {
  test("newest first, numbers and names only, from canvases the person owns", async () => {
    const id = await person();
    const kettle = await canvasOf(id, "Kettle onboarding");
    const pricing = await canvasOf(id, "Pricing page");
    await notice(kettle.id, 41, "2026-11-10T15:00:00Z");
    await notice(kettle.id, 44, "2026-11-11T15:00:00Z");
    await notice(pricing.id, 12, "2026-11-12T15:00:00Z");
    const merges = await recapMerges(db, {
      userId: id,
      friday: "2026-11-13",
      timeZone: "America/New_York",
    });
    expect(merges.map(({ canvasName, number }) => ({ canvasName, number }))).toEqual([
      { canvasName: "Pricing page", number: 12 },
      { canvasName: "Kettle onboarding", number: 44 },
      { canvasName: "Kettle onboarding", number: 41 },
    ]);
    expect(JSON.stringify(merges)).not.toContain("Secret title");
  });

  test("stamping moves forward only, and sets the first send once", async () => {
    const id = await person();
    const at = new Date("2026-11-13T20:00:00Z");
    await stampRecapSent(db, { userId: id, friday: "2026-11-13", sent: true, now: at });
    await stampRecapSent(db, {
      userId: id,
      friday: "2026-11-06",
      sent: true,
      now: new Date("2026-11-20T20:00:00Z"),
    });
    expect(await recapPerson(db, id)).toEqual({ recapSentOn: "2026-11-13", recapFirstSentAt: at });
    await stampRecapSent(db, {
      userId: id,
      friday: "2026-11-20",
      sent: false,
      now: new Date("2026-11-20T20:00:00Z"),
    });
    expect(await recapPerson(db, id)).toEqual({ recapSentOn: "2026-11-20", recapFirstSentAt: at });
  });
});
