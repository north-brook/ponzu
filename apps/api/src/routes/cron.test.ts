import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  authStates,
  enqueueJob,
  getWorkspaceByInstallation,
  jobs,
  repos,
  webhookDeliveries,
  workspaces,
} from "@ponzu/db";
import { lastCronRun } from "../cron/heartbeat.ts";
import { jobsStep } from "../cron/steps/jobs.ts";
import { CRON_STEPS, type CronStep, runCronSteps, slotOf } from "../cron/steps.ts";
import { syncGithub } from "../github/sync.ts";
import {
  createTestApp,
  type FakeInstallation,
  TEST_CRON_SECRET,
  type TestApp,
} from "../testing/index.ts";
import { runTimeOf, SCHEDULED_AT_WINDOW_MS } from "./cron.ts";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const run = (authorization?: string) =>
  t.app.request("/v1/cron/minute", { headers: authorization ? { authorization } : {} });

const ran = async () => {
  const response = await run(`Bearer ${TEST_CRON_SECRET}`);
  expect(response.status).toBe(200);
  return (await response.json()) as { steps: Record<string, Record<string, number>> };
};

/** On to `minute` past this hour, or past the next one once this hour's is behind. */
const toMinute = (minute: number) => {
  const now = t.clock.now();
  const target = now - (now % HOUR) + minute * MINUTE;
  t.clock.advance(target > now ? target - now : target + HOUR - now);
};

/** On to `minute` past the next hour. */
const nextHour = (minute: number) => {
  const now = t.clock.now();
  t.clock.advance(now - (now % HOUR) + HOUR + minute * MINUTE - now);
};

/** A step that counts its runs, on the schedule given. */
const counting = (name: string, schedule: Pick<CronStep, "everyMinutes" | "atMinute"> = {}) => {
  const step = {
    name,
    ...schedule,
    runs: 0,
    run: async () => ({ runs: ++step.runs }),
  };
  return step;
};

const now = () => new Date(t.clock.now());

test("only the scheduler's secret runs it", async () => {
  for (const authorization of [undefined, "Bearer wrong", `Bearer ${TEST_CRON_SECRET}x`]) {
    const response = await run(authorization);
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("unauthenticated");
  }
  const response = await run(`Bearer ${TEST_CRON_SECRET}`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    steps: {
      jobs: { ran: 0, abandoned: 0 },
      drivers: { ended: 0 },
      installations: { swept: 0 },
      sandboxes: {
        retire: 0,
        stop: 0,
        restart: 0,
        lapse: 0,
        stalled: 0,
        sleep: 0,
        cycle: 0,
        extend: 0,
        repair: 0,
        reconciled: 0,
      },
      search_backfill: { queued: 0 },
      receipts: { lost: 0 },
      resolve_questions: { lowered: 0 },
      prune_notifications: { expired: 0, deleted: 0, devices: 0 },
      // Email is off without RESEND_API_KEY, as here: nothing is found due, and the Friday
      // recap's step does not run at all, so this answer is the one from before email.
      digests: { due: 0, recorded: 0 },
      maintenance: { lifted: 0, started: 0, queued: 0 },
      pull_requests: { swept: 0 },
      // The test clock starts on the hour, when the hourly retention sweep is due.
      retention: { auth_states: 0, jobs: 0, webhook_deliveries: 0 },
    },
  });
  // The same answer, logged.
  expect(t.logs.find((line) => line.event === "cron_ran")).toMatchObject({
    level: "info",
    steps: { jobs: { ran: 0, abandoned: 0 }, installations: { swept: 0 } },
  });
});

test("installations nobody has read for hours are read again, which catches a lost uninstall", async () => {
  const una = await t.signInAs({ login: "una" });
  const installation: FakeInstallation = {
    id: 60_001,
    account: { id: 60_002, login: "sweptco", type: "Organization", members: [una.github.id] },
    repositorySelection: "selected",
    repositories: [{ id: 60_003, fullName: "sweptco/app", access: { [una.github.id]: "write" } }],
  };
  t.github.installations.push(installation);
  const [workspace] = await syncGithub(t.deps, una.userId);

  // Still fresh: nothing to read.
  expect((await ran()).steps.installations).toEqual({ swept: 0 });

  // Removed from GitHub, and its webhook never arrived. Hours pass.
  t.github.installations.pop();
  t.clock.advance(6 * 3600_000 + 60_000);
  expect((await ran()).steps.installations).toEqual({ swept: 1 });

  expect(await getWorkspaceByInstallation(t.db, installation.id)).toBeNull();
  const [row] = (await t.db.select().from(workspaces)).filter((w) => w.id === workspace!.id);
  expect(row!.installationId).toBeNull();
  const [repo] = (await t.db.select().from(repos)).filter((r) => r.workspaceId === workspace!.id);
  expect(repo!.removedAt).toBeInstanceOf(Date);
  // Gone, it is not read again.
  expect((await ran()).steps.installations).toEqual({ swept: 0 });
});

test("on the hour, the retention sweep deletes the operational rows past their time, and logs counts only", async () => {
  const una = await t.signInAs({ login: "retained" });
  const at = (ms: number) => new Date(t.clock.now() + ms);
  toMinute(30);
  // Rows on the test clock: one of each past its retention, one of each not yet.
  await t.db.insert(authStates).values([
    { id: "auth_gone", kind: "github_install", userId: una.userId, expiresAt: at(-25 * HOUR) },
    { id: "auth_kept", kind: "github_install", userId: una.userId, expiresAt: at(-23 * HOUR) },
  ]);
  await t.db.insert(jobs).values([
    { id: "job_gone", kind: "test.retention", key: "token-like", completedAt: at(-31 * 24 * HOUR) },
    { id: "job_kept", kind: "test.retention", completedAt: at(-29 * 24 * HOUR) },
  ]);
  await t.db.insert(webhookDeliveries).values([
    { source: "github", deliveryId: "gone", event: "push", receivedAt: at(-31 * 24 * HOUR) },
    { source: "github", deliveryId: "kept", event: "push", receivedAt: at(-29 * 24 * HOUR) },
  ]);

  // Not at :30: it is an hourly step.
  expect((await ran()).steps.retention).toBeUndefined();

  nextHour(0);
  expect((await ran()).steps.retention).toEqual({ auth_states: 1, jobs: 1, webhook_deliveries: 1 });
  const named = (names: string[], rows: { id: string }[]) =>
    rows.map((row) => row.id).filter((id) => names.includes(id));
  const left = async () => ({
    auth: named(
      ["auth_gone", "auth_kept"],
      await t.db.select({ id: authStates.id }).from(authStates),
    ),
    jobs: named(["job_gone", "job_kept"], await t.db.select({ id: jobs.id }).from(jobs)),
    webhooks: named(
      ["gone", "kept"],
      await t.db.select({ id: webhookDeliveries.deliveryId }).from(webhookDeliveries),
    ),
  });
  expect(await left()).toEqual({ auth: ["auth_kept"], jobs: ["job_kept"], webhooks: ["kept"] });
  const logged = t.logs.filter((line) => line.event === "rows_swept");
  expect(logged).toEqual([
    expect.objectContaining({ auth_states: 1, jobs: 1, webhook_deliveries: 1 }),
  ]);
  // Counts, and nothing the rows held.
  expect(JSON.stringify(logged)).not.toMatch(/token-like|auth_gone|job_gone|test\.retention/);

  // A second run in the same hour does not sweep again.
  expect((await ran()).steps.retention).toBeUndefined();

  // Two days on, the state that had a day to go has gone too.
  t.clock.advance(2 * 24 * HOUR);
  toMinute(0);
  expect((await ran()).steps.retention).toMatchObject({ auth_states: 1 });
  expect((await left()).auth).toEqual([]);
});

test("a step that throws is logged and answered as failed, and the others still run", async () => {
  const job = await enqueueJob(t.db, {
    kind: "test.nothing_runs_this",
    key: "isolation",
    runAt: now(),
    maxAttempts: 1,
  });
  const after = counting("after");
  const broken: CronStep = {
    name: "broken",
    run: async () => {
      throw new Error("the vendor is down");
    },
  };
  // Even listed ahead of the jobs step, a throw holds nothing up.
  const answer = await runCronSteps(t.deps, now(), [broken, jobsStep, after]);

  expect(answer).toEqual({
    steps: { broken: { failed: 1 }, jobs: { ran: 1, abandoned: 0 }, after: { runs: 1 } },
  });
  // The due job was taken and tried.
  const row = (await t.db.select().from(jobs)).find((stored) => stored.id === job!.id);
  expect(row!.attempts).toBe(1);
  expect(t.logs.filter((line) => line.event === "cron_step_failed")).toMatchObject([
    { level: "error", step: "broken" },
  ]);
  expect(
    t.analytics.exceptions.some((captured) => captured.properties.cron_step === "broken"),
  ).toBe(true);

  // A throwing jobs step, too, leaves the rest to run.
  const brokenJobs: CronStep = { ...broken, name: "jobs" };
  expect(await runCronSteps(t.deps, now(), [brokenJobs, after])).toEqual({
    steps: { jobs: { failed: 1 }, after: { runs: 2 } },
  });
});

test("the jobs step finishes before the others start", async () => {
  const order: string[] = [];
  const first: CronStep = {
    name: "first",
    run: async () => {
      await Promise.resolve();
      order.push("first");
      return {};
    },
  };
  const second: CronStep = {
    name: "second",
    run: async () => {
      order.push("second");
      return {};
    },
  };
  await runCronSteps(t.deps, now(), [first, second]);
  expect(order).toEqual(["first", "second"]);
});

test("an hourly step runs once at its minute, even with two runs at once", async () => {
  const hourly = counting("hourly_test", { atMinute: 0 });
  const steps = [hourly];

  toMinute(0);
  const [a, b] = await Promise.all([
    runCronSteps(t.deps, now(), steps),
    runCronSteps(t.deps, now(), steps),
  ]);
  expect(hourly.runs).toBe(1);
  // Only the run that took the hour answers for the step.
  expect([a.steps.hourly_test, b.steps.hourly_test].filter(Boolean)).toEqual([{ runs: 1 }]);

  // The rest of the hour: not again.
  for (const minute of [1, 2, 30, 59]) {
    toMinute(minute);
    expect(await runCronSteps(t.deps, now(), steps)).toEqual({ steps: {} });
  }
  expect(hourly.runs).toBe(1);

  // The next hour, once more.
  nextHour(0);
  await runCronSteps(t.deps, now(), steps);
  await runCronSteps(t.deps, now(), steps);
  expect(hourly.runs).toBe(2);

  // An hour whose :00 run never came: the next run within five minutes does it, once.
  nextHour(2);
  await runCronSteps(t.deps, now(), steps);
  toMinute(3);
  await runCronSteps(t.deps, now(), steps);
  expect(hourly.runs).toBe(3);

  // An hour with no run in its first five minutes is skipped, not done late.
  nextHour(5);
  await runCronSteps(t.deps, now(), steps);
  expect(hourly.runs).toBe(3);
});

test("a step at another minute, and one every ten minutes, run once in each of their slots", async () => {
  const at7 = counting("at_seven", { atMinute: 7 });
  const tenth = counting("every_ten", { everyMinutes: 10 });
  const every = counting("every_minute");
  const steps = [every, at7, tenth];

  toMinute(0);
  for (let minute = 0; minute < 60; minute++) {
    await runCronSteps(t.deps, now(), steps);
    t.clock.advance(MINUTE);
  }
  expect(every.runs).toBe(60);
  expect(at7.runs).toBe(1);
  expect(tenth.runs).toBe(6);
});

test("which slot a step is in, by the minute", () => {
  const at = (iso: string) => new Date(iso);
  const hourly: CronStep = { name: "h", atMinute: 7, run: async () => ({}) };
  expect(slotOf(hourly, at("2026-11-12T10:07:30Z"))).toBe("2026-11-12T10:07:00.000Z");
  expect(slotOf(hourly, at("2026-11-12T10:11:59Z"))).toBe("2026-11-12T10:07:00.000Z");
  expect(slotOf(hourly, at("2026-11-12T10:12:00Z"))).toBe("skip");
  expect(slotOf(hourly, at("2026-11-12T10:06:59Z"))).toBe("skip");
  // A step at :55 catches up only until :59; the next hour has its own :55.
  const late: CronStep = { name: "l", atMinute: 55, run: async () => ({}) };
  expect(slotOf(late, at("2026-11-12T10:59:00Z"))).toBe("2026-11-12T10:55:00.000Z");
  expect(slotOf(late, at("2026-11-12T11:00:00Z"))).toBe("skip");
  expect(slotOf(late, at("2026-11-12T11:54:00Z"))).toBe("skip");
  expect(slotOf(late, at("2026-11-12T11:55:00Z"))).toBe("2026-11-12T11:55:00.000Z");

  const tenth: CronStep = { name: "t", everyMinutes: 10, run: async () => ({}) };
  expect(slotOf(tenth, at("2026-11-12T10:20:00Z"))).toBe("2026-11-12T10:20:00.000Z");
  expect(slotOf(tenth, at("2026-11-12T10:24:59Z"))).toBe("2026-11-12T10:20:00.000Z");
  expect(slotOf(tenth, at("2026-11-12T10:25:00Z"))).toBe("skip");
  // Short slots catch up only within themselves.
  const third: CronStep = { name: "3", everyMinutes: 3, run: async () => ({}) };
  expect(slotOf(third, at("2026-11-12T10:04:00Z"))).toBe("2026-11-12T10:03:00.000Z");
  expect(slotOf(third, at("2026-11-12T10:05:00Z"))).toBe("2026-11-12T10:03:00.000Z");

  // Every minute: no slot to record.
  expect(slotOf({ name: "m", run: async () => ({}) }, at("2026-11-12T10:24:00Z"))).toBeNull();
  expect(
    slotOf({ name: "m", everyMinutes: 1, run: async () => ({}) }, at("2026-11-12T10:24:00Z")),
  ).toBeNull();
});

// The minute on Vercel Schedules (docs/cloud.md, "Known constraints").

test("vercel.json declares the minute as one schedule, a GET on the route, beside production's legacy cron", () => {
  // Production's minute runs on the legacy cron today, which Vercel runs only on the Production
  // target. The schedule is added beside it so production never goes a minute without a run
  // while it moves. Both run the route for each occurrence
  // (https://vercel.com/docs/schedules/migrate-from-cron-jobs), which the steps allow
  // (runCronSteps: overlapping and repeated runs take only what nobody else holds). Once the
  // schedule has fired in production, the orchestrator turns the cron off with the project's
  // Disable Cron Jobs switch (docs/production.md, "The minute"), and a later change removes
  // `crons`.
  const config = JSON.parse(
    readFileSync(new URL("../../vercel.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
  expect(config.crons).toEqual([{ path: "/v1/cron/minute", schedule: "* * * * *" }]);
  expect(config.schedules).toEqual({
    minute: {
      schedule: "* * * * *",
      path: "/v1/cron/minute",
      // A path target sends POST unless told otherwise, and this route answers only GET.
      requestMethod: "GET",
      jitter: 1,
    },
  });
});

test("the scheduler's time is the run's time only when it is a full ISO time within two minutes of the clock", () => {
  const clock = Date.parse("2026-11-12T10:01:30.000Z");
  const scheduled = (header: string | undefined) => runTimeOf(header, clock);

  // Within the window, either side of the clock.
  expect(scheduled("2026-11-12T10:01:00.000Z")).toEqual({
    now: new Date("2026-11-12T10:01:00.000Z"),
    from: "schedule",
  });
  expect(scheduled("2026-11-12T10:00:00Z").from).toBe("schedule");
  expect(scheduled("2026-11-12T10:02:00+00:00").from).toBe("schedule");
  // Exactly two minutes is in; a millisecond more is out.
  expect(scheduled("2026-11-12T09:59:30.000Z").from).toBe("schedule");
  expect(scheduled("2026-11-12T09:59:29.999Z")).toEqual({ now: new Date(clock), from: "clock" });
  expect(scheduled("2026-11-12T10:03:30.001Z").from).toBe("clock");
  // A run caught up after an outage is a run now.
  expect(scheduled("2026-11-12T09:52:00.000Z").from).toBe("clock");
  // Missing, or anything but a full ISO time with its zone, is the clock.
  for (const header of [
    undefined,
    "",
    "garbage",
    "2026-11-12",
    "2026-11-12T10:01:00",
    "Thu, 12 Nov 2026 10:01:00 GMT",
    String(clock),
    "2026-13-12T10:01:00Z",
  ]) {
    expect(scheduled(header)).toEqual({ now: new Date(clock), from: "clock" });
  }
  expect(SCHEDULED_AT_WINDOW_MS).toBe(2 * MINUTE);
});

const scheduledRun = async (scheduledAt: string) => {
  const response = await t.app.request("/v1/cron/minute", {
    headers: { authorization: `Bearer ${TEST_CRON_SECRET}`, "ce-vssscheduledat": scheduledAt },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { steps: Record<string, Record<string, number>> };
};

test("a run is for the minute the scheduler meant, when that is close to the clock", async () => {
  // 20 seconds before the hour, for the hour: the scheduler's minute is the hour, so the hourly
  // retention step runs in the hour's slot. By the clock alone it would be last hour's, long past.
  nextHour(59);
  t.clock.advance(40_000);
  const hour = new Date(t.clock.now() + 20_000).toISOString();
  expect((await scheduledRun(hour)).steps.retention).toBeDefined();
  expect(t.logs.findLast((line) => line.event === "cron_ran")).toMatchObject({ time: "schedule" });
  // And once in that slot, as ever.
  expect((await scheduledRun(hour)).steps.retention).toBeUndefined();

  // Five and a half minutes past a later hour (the one above has its slot taken), for four
  // past: inside the window, so it is the hour's slot, within its five minutes of catching up.
  nextHour(0);
  nextHour(5);
  t.clock.advance(30_000);
  const fourPast = new Date(t.clock.now() - 90_000).toISOString();
  expect((await scheduledRun(fourPast)).steps.retention).toBeDefined();
});

test("a run whose scheduled minute is far from the clock goes by the clock", async () => {
  // Five and a half minutes past, for three past: outside the window, so the clock says the
  // hour's catch-up is over and the hourly step waits for the next hour.
  nextHour(5);
  t.clock.advance(30_000);
  const threePast = new Date(t.clock.now() - 150_000).toISOString();
  expect((await scheduledRun(threePast)).steps.retention).toBeUndefined();
  expect(t.logs.findLast((line) => line.event === "cron_ran")).toMatchObject({ time: "clock" });
});

test("every run records when it ran, by the clock, and a refused run records nothing", async () => {
  nextHour(1);
  await ran();
  expect(await lastCronRun(t.db)).toEqual(new Date(t.clock.now()));
  const at = t.clock.now();

  // A later run with an earlier scheduled time still records the clock it ran at.
  t.clock.advance(70_000);
  await scheduledRun(new Date(at).toISOString());
  expect(await lastCronRun(t.db)).toEqual(new Date(t.clock.now()));

  t.clock.advance(MINUTE);
  expect((await run("Bearer wrong")).status).toBe(401);
  expect(await lastCronRun(t.db)).toEqual(new Date(t.clock.now() - MINUTE));
});

test("a heartbeat that cannot be written is logged and holds no step up", async () => {
  const broken = await createTestApp();
  try {
    await broken.db.execute(`
      create function refuse_heartbeat() returns trigger language plpgsql as $$
      begin
        if new.kind = 'heartbeat' then raise exception 'no heartbeat'; end if;
        return new;
      end $$`);
    await broken.db.execute(`
      create trigger refuse_heartbeat before insert or update on jobs
        for each row execute function refuse_heartbeat()`);
    const response = await broken.app.request("/v1/cron/minute", {
      headers: { authorization: `Bearer ${TEST_CRON_SECRET}` },
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { steps: Record<string, unknown> }).steps.jobs).toEqual({
      ran: 0,
      abandoned: 0,
    });
    expect(broken.logs.map((line) => line.event)).toContain("cron_heartbeat_failed");
    expect(await lastCronRun(broken.db)).toBeNull();
  } finally {
    await broken.close();
  }
});

test("a preview never runs the minute: it answers no steps, records nothing, and still needs the bearer", async () => {
  const preview = await createTestApp({ environment: "preview" });
  try {
    const due = await enqueueJob(preview.db, { kind: "test.preview" });
    const minute = (authorization?: string) =>
      preview.app.request("/v1/cron/minute", {
        headers: authorization ? { authorization } : {},
      });

    expect((await minute()).status).toBe(401);
    const response = await minute(`Bearer ${TEST_CRON_SECRET}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ steps: {} });
    expect(preview.logs.find((line) => line.event === "cron_skipped")).toMatchObject({
      level: "info",
      reason: "preview",
    });
    expect(preview.logs.some((line) => line.event === "cron_ran")).toBe(false);
    // Nothing was taken or written: the due job is untouched, and no run was recorded, so a
    // preview on dev's database never makes dev's minute look alive.
    const rows = await preview.db.select().from(jobs);
    expect(rows).toEqual([expect.objectContaining({ id: due!.id, attempts: 0, lockedAt: null })]);
    expect(await lastCronRun(preview.db)).toBeNull();
  } finally {
    await preview.close();
  }
});

test("every step has its own name, jobs comes first, and each schedule is one the cron can keep", () => {
  const names = CRON_STEPS.map((step) => step.name);
  expect(names[0]).toBe("jobs");
  expect(new Set(names).size).toBe(names.length);
  for (const step of CRON_STEPS) {
    expect(step.name).toMatch(/^[a-z]+(_[a-z]+)*$/);
    if (step.atMinute !== undefined) {
      expect(Number.isInteger(step.atMinute) && step.atMinute >= 0 && step.atMinute < 60).toBe(
        true,
      );
    }
    if (step.everyMinutes !== undefined) {
      expect(Number.isInteger(step.everyMinutes) && step.everyMinutes >= 1).toBe(true);
      expect(60 % step.everyMinutes).toBe(0);
    }
  }
});
