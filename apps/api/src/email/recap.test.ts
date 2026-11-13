import { afterEach, describe, expect, test } from "bun:test";
import { sampleDoc } from "@ponzu/core/fixtures";
import { enqueueJob, jobs, recapPerson, recordRepoAccess } from "@ponzu/db";
import { runCronSteps } from "../cron/steps.ts";
import { runDueJobs } from "../jobs/run.ts";
import { canvasIn, workspaceWithRepo } from "../testing/canvases.ts";
import { createTestApp, type TestApp } from "../testing/index.ts";
import type { EmailConfig } from "./kinds.ts";
import {
  groupMerges,
  RECAP_BATCH,
  RECAP_FORM,
  RECAP_JOB,
  recapDateLine,
  recapEmailKey,
  recapJobKey,
  recapMayBeDue,
  weekdayIn,
} from "./recap.ts";

/*
 * The Friday recap (docs/cloud.md, "Email"), on the real app with a fake Resend and a clock that
 * moves only when a test moves it. The clock starts on Thursday 2026-01-01 00:00 UTC, so the
 * first Friday is 2 January, whose recap is due from 20:00 UTC (15:00 in New York, UTC-5), and
 * whose week is [Friday 26 December 20:00 UTC, Friday 2 January 20:00 UTC).
 *
 * Merges are written as Ponzu writes them (the thread notice `ti_pr-<n>-merged`), at the times a
 * test names. The app says it is production, so emails go as a person would get them (send.ts's
 * own tests cover the allowlist outside production).
 */

/** The first recap's introduction begins so. */
const FIRST_RECAP = "This is your first Friday recap.";
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const FRIDAY = "2026-01-02T20:00:00Z";
const NEXT_FRIDAY = "2026-01-09T20:00:00Z";

const opened: TestApp[] = [];
afterEach(async () => {
  for (const app of opened.splice(0)) await app.close();
});

async function app({
  mail = true,
  email = {},
}: {
  mail?: boolean;
  email?: Partial<EmailConfig>;
} = {}) {
  const t = await createTestApp({ mail, environment: "production", email });
  opened.push(t);
  return t;
}

/** Move the clock to `at` (never back), run the cron as Vercel would, then every job it left. */
async function cronAt(t: TestApp, at: string | number) {
  const target = typeof at === "string" ? new Date(at).getTime() : at;
  if (target > t.clock.now()) t.clock.advance(target - t.clock.now());
  const answer = await runCronSteps(t.deps, new Date(t.clock.now()));
  await t.backgroundDone();
  for (let round = 0; round < 10; round++) {
    const { ran } = await runDueJobs(t.deps, `test:${crypto.randomUUID()}`);
    await t.backgroundDone();
    if (ran === 0) break;
  }
  return answer.steps.recaps;
}

async function write(t: TestApp, statement: string) {
  await t.db.execute(statement);
}

let serial = 0;

/**
 * A person who owns a canvas in their own workspace's private repository. Their answer from
 * GitHub ("admin") was kept at `checkedAt`, and their app reported `timeZone`.
 */
async function owner(
  t: TestApp,
  {
    timeZone = "America/New_York",
    checkedAt,
  }: { timeZone?: string | null; checkedAt?: string } = {},
) {
  const login = `owner${++serial}`;
  const ws = await workspaceWithRepo(t, { [login]: "admin" });
  const person = ws.people[login]!;
  const canvas = await canvasIn(t, ws, login, sampleDoc());
  await write(
    t,
    `update users set time_zone = ${timeZone ? `'${timeZone}'` : "null"} where id = '${person.userId}'`,
  );
  const known = async (at: string) =>
    recordRepoAccess(t.db, [
      { userId: person.userId, repoId: ws.repo.id, permission: "admin", checkedAt: new Date(at) },
    ]);
  await known(checkedAt ?? new Date(t.clock.now()).toISOString());
  /** Another canvas of theirs in the same repository. */
  const another = () => canvasIn(t, ws, login, sampleDoc());
  return {
    ws,
    login,
    person,
    canvas,
    userId: person.userId,
    address: `${login}@example.com`,
    known,
    another,
  };
}

/** Pull request `number` from the canvas merged, as Ponzu records it when it first sees it. */
async function merged(t: TestApp, canvasId: string, number: number, at: string) {
  await write(
    t,
    `insert into thread_items (id, canvas_id, kind, payload, created_at)
     values ('ti_pr-${number}-merged', '${canvasId}', 'notice',
             '{"type":"pull_request","number":${number},"state":"merged","title":"Secret agent title","url":"https://github.com/acme/private-repo/pull/${number}"}'::jsonb,
             '${at}')`,
  );
}

async function recapJobs(t: TestApp) {
  return (await t.db.select().from(jobs)).filter((job) => job.kind === RECAP_JOB);
}

describe("off, paused, and outside Friday afternoon", () => {
  test("RESEND_API_KEY unset: nothing is read, stamped, recorded or sent", async () => {
    const t = await app({ mail: false });
    const { canvas, userId } = await owner(t);
    await merged(t, canvas.id, 41, "2026-01-01T12:00:00Z");
    for (const at of [FRIDAY, "2026-01-02T20:05:00Z", "2026-01-03T01:00:00Z"]) {
      expect(await cronAt(t, at)).toEqual({ stamped: 0, due: 0, recorded: 0 });
    }
    expect(await recapJobs(t)).toEqual([]);
    expect(await recapPerson(t.db, userId)).toEqual({ recapSentOn: null, recapFirstSentAt: null });
    expect(t.mail.sent).toEqual([]);
    const logged = JSON.stringify(t.logs);
    expect(logged).not.toContain('"recap_');
    expect(logged).not.toContain('"email_');
  });

  test("recap paused: the step records and stamps nothing", async () => {
    const t = await app({ email: { paused: new Set(["recap"]) } });
    const { canvas, userId } = await owner(t);
    const quiet = await owner(t);
    await merged(t, canvas.id, 41, "2026-01-01T12:00:00Z");
    expect(await cronAt(t, FRIDAY)).toEqual({ stamped: 0, due: 0, recorded: 0 });
    expect(await recapJobs(t)).toEqual([]);
    expect((await recapPerson(t.db, userId))!.recapSentOn).toBeNull();
    expect((await recapPerson(t.db, quiet.userId))!.recapSentOn).toBeNull();
    expect(t.mail.sent).toEqual([]);
  });

  test("a job recorded before the pause stamps the Friday without sending", async () => {
    const t = await app({ email: { paused: new Set(["recap"]) } });
    const { canvas, userId } = await owner(t);
    await merged(t, canvas.id, 41, "2026-01-01T12:00:00Z");
    t.clock.advance(new Date(FRIDAY).getTime() - t.clock.now());
    await enqueueJob(t.db, {
      kind: RECAP_JOB,
      key: recapJobKey(userId, "2026-01-02"),
      payload: { userId, friday: "2026-01-02", timeZone: "America/New_York" },
      runAt: new Date(t.clock.now()),
    });
    await cronAt(t, FRIDAY);
    expect(t.mail.sent).toEqual([]);
    expect(await recapPerson(t.db, userId)).toEqual({
      recapSentOn: "2026-01-02",
      recapFirstSentAt: null,
    });
    expect(t.logs.some((line) => line.event === "email_paused" && line.kind === "recap")).toBe(
      true,
    );
  });

  test("the step asks nothing from Saturday afternoon to Thursday", () => {
    // Friday 00:00 UTC to Saturday 13:00 UTC: Friday 15:00 to midnight in every zone, with an
    // hour's margin each side.
    expect(recapMayBeDue(new Date("2026-01-01T23:59:00Z"))).toBe(false);
    expect(recapMayBeDue(new Date("2026-01-02T00:00:00Z"))).toBe(true);
    expect(recapMayBeDue(new Date("2026-01-03T12:59:00Z"))).toBe(true);
    expect(recapMayBeDue(new Date("2026-01-03T13:00:00Z"))).toBe(false);
    expect(recapMayBeDue(new Date("2026-01-06T12:00:00Z"))).toBe(false);
  });
});

describe("the recap", () => {
  test("goes once on Friday from 15:00, in the counts-only form, and introduces itself once", async () => {
    const t = await app();
    const { canvas, userId, address, known } = await owner(t);
    await merged(t, canvas.id, 41, "2026-01-01T12:00:00Z");

    expect(await cronAt(t, "2026-01-02T19:55:00Z")).toEqual({ stamped: 0, due: 0, recorded: 0 });
    expect(await cronAt(t, FRIDAY)).toEqual({ stamped: 0, due: 1, recorded: 1 });
    // However often the step runs, one email that Friday.
    for (const at of ["2026-01-02T20:05:00Z", "2026-01-02T23:00:00Z", "2026-01-03T04:55:00Z"]) {
      expect(await cronAt(t, at)).toEqual({ stamped: 0, due: 0, recorded: 0 });
    }
    expect(t.mail.sent).toHaveLength(1);
    const [email] = t.mail.sent;
    expect(email!.to).toBe(address);
    expect(email!.idempotencyKey).toBe(recapEmailKey(userId, "2026-01-02"));
    expect(email!.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(email!.headers["List-Unsubscribe"]).toContain("/v1/email/unsubscribe?t=");
    expect(RECAP_FORM).toBe("counts");
    expect(email!.subject).toBe("Shipped this week: 1 canvas, 1 pull request merged");
    expect(email!.text).toContain("1 pull request from a canvas you own was merged.");
    expect(email!.text).toContain("Friday, January 2");
    expect(email!.text).toContain(FIRST_RECAP);
    // Counts only: no canvas or workspace name anywhere, and never a title or repository.
    for (const part of [email!.subject, email!.html, email!.text]) {
      expect(part).not.toContain(canvas.name);
      expect(part).not.toContain("Secret agent title");
      expect(part).not.toContain("private-repo");
    }
    const after = await recapPerson(t.db, userId);
    expect(after!.recapSentOn).toBe("2026-01-02");
    expect(after!.recapFirstSentAt).not.toBeNull();

    // The next week: two merges, the second Friday's email has no introduction.
    await known("2026-01-08T09:00:00Z");
    await merged(t, canvas.id, 44, "2026-01-07T12:00:00Z");
    await merged(t, canvas.id, 45, "2026-01-08T12:00:00Z");
    await cronAt(t, NEXT_FRIDAY);
    expect(t.mail.sent).toHaveLength(2);
    const second = t.mail.sent[1]!;
    expect(second.subject).toBe("Shipped this week: 1 canvas, 2 pull requests merged");
    expect(second.text).not.toContain(FIRST_RECAP);
    expect((await recapPerson(t.db, userId))!.recapFirstSentAt).toEqual(after!.recapFirstSentAt);
  });

  test("a week with nothing merged moves only the stamp, in the step, with no job", async () => {
    const t = await app();
    const { canvas, userId } = await owner(t);
    // Merged before the week began.
    await merged(t, canvas.id, 41, "2026-01-02T20:00:00Z");
    await cronAt(t, FRIDAY);
    // That merge is next week's.
    expect(t.mail.sent).toEqual([]);
    expect(await recapJobs(t)).toEqual([]);
    expect((await recapPerson(t.db, userId))!.recapSentOn).toBe("2026-01-02");
  });

  test("access is judged at each canvas's merge: an answer 3 days old at send time still counts", async () => {
    const t = await app();
    // GitHub's answer was kept on Tuesday at 10:00, the merge was seen two hours later, and the
    // person has not opened Ponzu since: on Friday the answer is more than 3 days old.
    const { canvas, userId, another } = await owner(t, { checkedAt: "2026-01-06T10:00:00Z" });
    await merged(t, canvas.id, 41, "2026-01-06T12:00:00Z");
    // A second canvas merged on Thursday, two days after the answer: it was not known then that
    // they could read it, so it is not counted.
    const late = await another();
    await merged(t, late.id, 7, "2026-01-08T12:00:00Z");
    await cronAt(t, NEXT_FRIDAY);
    expect(t.mail.sent.map((email) => email.subject)).toEqual([
      "Shipped this week: 1 canvas, 1 pull request merged",
    ]);
    expect(t.mail.sent[0]!.to).toContain("owner");
    expect((await recapPerson(t.db, userId))!.recapSentOn).toBe("2026-01-09");
  });

  test("a canvas the person no longer reads is dropped, and with nothing left only the stamp moves", async () => {
    const t = await app();
    const left = await owner(t);
    const lost = await owner(t);
    await merged(t, left.canvas.id, 41, "2026-01-01T12:00:00Z");
    // A Scratch canvas has no repository to ask about: only being in its workspace now counts.
    const scratch = await canvasIn(t, left.ws, left.login, sampleDoc(), "scratch");
    await merged(t, scratch.id, 43, "2026-01-01T12:00:00Z");
    await merged(t, lost.canvas.id, 42, "2026-01-01T12:00:00Z");
    // One left the workspace; GitHub said the other may no longer read the repository.
    await write(
      t,
      `delete from memberships where workspace_id = '${left.ws.id}' and user_id = '${left.userId}'`,
    );
    await recordRepoAccess(t.db, [
      {
        userId: lost.userId,
        repoId: lost.ws.repo.id,
        permission: "none",
        checkedAt: new Date("2026-01-01T11:00:00Z"),
      },
    ]);
    await cronAt(t, FRIDAY);
    expect(t.mail.sent).toEqual([]);
    expect((await recapPerson(t.db, left.userId))!.recapSentOn).toBe("2026-01-02");
    expect((await recapPerson(t.db, lost.userId))!.recapSentOn).toBe("2026-01-02");
    expect(t.logs.filter((line) => line.event === "recap_empty")).toHaveLength(2);
  });

  test("turned off between the step and the job: nothing goes, and the Friday is done", async () => {
    const t = await app();
    const { canvas, userId } = await owner(t);
    await merged(t, canvas.id, 41, "2026-01-01T12:00:00Z");
    t.clock.advance(new Date(FRIDAY).getTime() - t.clock.now());
    await enqueueJob(t.db, {
      kind: RECAP_JOB,
      key: recapJobKey(userId, "2026-01-02"),
      payload: { userId, friday: "2026-01-02", timeZone: "America/New_York" },
      runAt: new Date(t.clock.now()),
    });
    await write(t, `update users set email_recap = false where id = '${userId}'`);
    await cronAt(t, FRIDAY);
    expect(t.mail.sent).toEqual([]);
    expect(await recapPerson(t.db, userId)).toEqual({
      recapSentOn: "2026-01-02",
      recapFirstSentAt: null,
    });
  });

  test("Resend busy: the job tries again with the same key, and the Friday goes once", async () => {
    const t = await app();
    const { canvas, userId } = await owner(t);
    await merged(t, canvas.id, 41, "2026-01-01T12:00:00Z");
    t.mail.failNext("rate_limited");
    await cronAt(t, FRIDAY);
    expect(t.mail.sent).toEqual([]);
    expect((await recapPerson(t.db, userId))!.recapSentOn).toBeNull();
    // Five minutes later the job goes again, and the step does not record a second one.
    expect(await cronAt(t, "2026-01-02T20:05:00Z")).toMatchObject({ recorded: 0 });
    expect(t.mail.sent.map((email) => email.idempotencyKey)).toEqual([
      recapEmailKey(userId, "2026-01-02"),
    ]);
    expect((await recapPerson(t.db, userId))!.recapSentOn).toBe("2026-01-02");
  });

  test("a deleted account's job completes and sends nothing", async () => {
    const t = await app();
    await enqueueJob(t.db, {
      kind: RECAP_JOB,
      key: recapJobKey("usr_gone", "2026-01-02"),
      payload: { userId: "usr_gone", friday: "2026-01-02", timeZone: "America/New_York" },
      runAt: new Date(t.clock.now()),
    });
    await cronAt(t, FRIDAY);
    expect(t.mail.sent).toEqual([]);
    expect((await recapJobs(t)).every((job) => job.completedAt !== null)).toBe(true);
  });

  test("5,000 people and 30 merges: everyone is stamped and every recap sent before midnight", async () => {
    const t = await app();
    const owners = [];
    for (let i = 0; i < 30; i++) {
      const one = await owner(t);
      await merged(t, one.canvas.id, 100 + i, "2026-01-01T12:00:00Z");
      owners.push(one);
    }
    await write(
      t,
      `insert into users (id, workos_user_id, github_user_id, github_login, email, time_zone)
       select 'usr_bulk_' || n, 'user_bulk_' || n, 900000000 + n, 'bulk-' || n,
              'bulk-' || n || '@example.com',
              (array['America/New_York', 'Europe/Lisbon', 'Asia/Kolkata', 'Nowhere/Else'])[1 + n % 4]
         from generate_series(1, 4970) as n`,
    );
    // Every five minutes from Friday 09:00 UTC (before 15:00 in Kolkata) to midnight in New York.
    let at = new Date("2026-01-02T09:00:00Z").getTime();
    const midnight = new Date("2026-01-03T05:00:00Z").getTime();
    let sentBy = 0;
    while (at < midnight) {
      await cronAt(t, at);
      if (t.mail.sent.length === 30 && sentBy === 0) sentBy = at;
      at += 5 * 60_000;
    }
    expect(t.mail.sent).toHaveLength(30);
    expect(new Set(t.mail.sent.map((email) => email.to))).toEqual(
      new Set(owners.map((one) => one.address)),
    );
    // Two batches of twenty, from 15:00 in New York.
    expect(RECAP_BATCH).toBe(20);
    expect(sentBy).toBe(new Date("2026-01-02T20:05:00Z").getTime());
    const result = (await t.db.execute(
      `select count(*)::int as n from users where id like 'usr_bulk_%' and recap_sent_on = '2026-01-02'`,
    )) as unknown as { rows: { n: number }[] };
    expect(Number(result.rows[0]!.n)).toBe(4970);
    expect(await recapJobs(t)).toHaveLength(30);
  }, 120_000);
});

describe("its parts", () => {
  test("merges group by canvas, newest merge first, numbers in merge order and once each", () => {
    const at = (iso: string) => new Date(iso);
    const base = { workspaceId: "ws_1", workspaceName: "Northbrook" };
    const weeks = groupMerges([
      {
        ...base,
        canvasId: "cnv_b",
        canvasName: "B",
        number: 12,
        mergedAt: at("2026-01-08T12:00:00Z"),
      },
      {
        ...base,
        canvasId: "cnv_a",
        canvasName: "A",
        number: 44,
        mergedAt: at("2026-01-07T12:00:00Z"),
      },
      {
        ...base,
        canvasId: "cnv_a",
        canvasName: "A",
        number: 41,
        mergedAt: at("2026-01-06T12:00:00Z"),
      },
      {
        ...base,
        canvasId: "cnv_a",
        canvasName: "A",
        number: 41,
        mergedAt: at("2026-01-06T13:00:00Z"),
      },
    ]);
    expect(weeks.map(({ canvasId, numbers }) => ({ canvasId, numbers }))).toEqual([
      { canvasId: "cnv_b", numbers: [12] },
      { canvasId: "cnv_a", numbers: [41, 44] },
    ]);
  });

  test("dates and weekdays are the reader's", () => {
    expect(recapDateLine("2026-11-13")).toBe("Friday, November 13");
    // 03:00 UTC on Wednesday is still Tuesday in New York, and Wednesday in Kolkata.
    const at = new Date("2026-01-07T03:00:00Z");
    expect(weekdayIn(at, "America/New_York")).toBe("Tuesday");
    expect(weekdayIn(at, "Asia/Kolkata")).toBe("Wednesday");
    expect(weekdayIn(at, "Nowhere/Else")).toBe("Tuesday");
  });

  test("keys name the person and the Friday, within Resend's limit", () => {
    expect(recapJobKey("usr_1", "2026-01-02")).toBe("recap:usr_1:2026-01-02");
    expect(recapEmailKey("usr_1", "2026-01-02")).toBe("recap/usr_1/2026-01-02");
    expect(DAY).toBe(24 * HOUR);
  });
});
