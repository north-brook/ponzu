import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { jobs } from "@ponzu/db";
import { runDueJobs, runNow } from "../jobs/run.ts";
import { call } from "../testing/canvases.ts";
import { createTestApp, type TestApp } from "../testing/index.ts";
import { ACCOUNT_FORGET_ATTEMPTS, ACCOUNT_FORGET_JOB, accountForgetJob } from "./forget.ts";

/*
 * The job that forgets a deleted person outside Ponzu: WorkOS, then PostHog, each tried again
 * until it is done, and PostHog skipped while its personal key is unset.
 */

const stored = async (t: TestApp, id: string) =>
  (await t.db.select().from(jobs)).find((job) => job.id === id)!;

const lines = (t: TestApp, event: string) => t.logs.filter((line) => line.event === event);

describe("with PostHog's personal key", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ posthogAdmin: true });
  });
  afterAll(() => t.close());

  test("deletes the WorkOS user, then asks PostHog to delete the person, once", async () => {
    const user = t.workos.addUser({ email: "rae@example.com" });
    t.posthogAdmin.people.add("usr_forget_1");
    const job = await runNow(t.deps, {
      ...accountForgetJob({ userId: "usr_forget_1", workosUserId: user.id }),
    });
    expect(job).toMatchObject({
      kind: ACCOUNT_FORGET_JOB,
      key: "usr_forget_1",
      payload: { userId: "usr_forget_1", workosUserId: user.id },
      maxAttempts: ACCOUNT_FORGET_ATTEMPTS,
    });
    // Recorded again while it is held: the one recorded does the work.
    expect(
      await runNow(t.deps, accountForgetJob({ userId: "usr_forget_1", workosUserId: user.id })),
    ).toBeNull();
    await t.backgroundDone();

    expect(t.workos.hasUser(user.id)).toBe(false);
    expect(t.posthogAdmin.forgotten).toEqual(["usr_forget_1"]);
    expect((await stored(t, job!.id)).completedAt).toBeInstanceOf(Date);
    expect(lines(t, "analytics_forgotten").at(-1)).toMatchObject({ userId: "usr_forget_1" });
  });

  test("a WorkOS user already gone is done, and PostHog is still asked", async () => {
    const job = await runNow(
      t.deps,
      accountForgetJob({ userId: "usr_forget_2", workosUserId: "user_long_gone" }),
    );
    await t.backgroundDone();
    expect((await stored(t, job!.id)).completedAt).toBeInstanceOf(Date);
    expect(t.posthogAdmin.forgotten.at(-1)).toBe("usr_forget_2");
  });

  test("no WorkOS user to delete: only PostHog is asked", async () => {
    const before = t.posthogAdmin.requests.length;
    const job = await runNow(
      t.deps,
      accountForgetJob({ userId: "usr_forget_3", workosUserId: null }),
    );
    await t.backgroundDone();
    expect((await stored(t, job!.id)).completedAt).toBeInstanceOf(Date);
    expect(t.posthogAdmin.requests.length).toBe(before + 1);
  });

  test("PostHog failing is tried again by the cron, and WorkOS's delete is safe to repeat", async () => {
    const user = t.workos.addUser({ email: "sol@example.com" });
    t.posthogAdmin.answerNext({ status: 502 }, { status: 503 });
    const job = await runNow(
      t.deps,
      accountForgetJob({ userId: "usr_forget_4", workosUserId: user.id }),
    );
    await t.backgroundDone();
    // WorkOS forgot them on the first attempt; PostHog did not take it.
    expect(t.workos.hasUser(user.id)).toBe(false);
    const first = await stored(t, job!.id);
    expect(first).toMatchObject({ attempts: 1, completedAt: null, failedAt: null });
    expect(first.lastError).toBe("PosthogAdminError: POST persons/bulk_delete answered 502");
    expect(first.runAt.getTime()).toBe(t.clock.now() + 60_000);

    t.clock.advance(60_000);
    expect(await runDueJobs(t.deps, "cron:test")).toEqual({ ran: 1, abandoned: 0 });
    expect((await stored(t, job!.id)).attempts).toBe(2);
    // The wait doubles.
    t.clock.advance(120_000);
    expect(await runDueJobs(t.deps, "cron:test")).toEqual({ ran: 1, abandoned: 0 });
    const done = await stored(t, job!.id);
    expect(done).toMatchObject({ attempts: 3 });
    expect(done.completedAt).toBeInstanceOf(Date);
    expect(t.posthogAdmin.forgotten.at(-1)).toBe("usr_forget_4");
  });

  test("WorkOS failing is tried again before PostHog is asked", async () => {
    const user = t.workos.addUser({ email: "tom@example.com" });
    const path = `/user_management/users/${user.id}`;
    t.workos.failNext(path, 500);
    const before = t.posthogAdmin.requests.length;
    const job = await runNow(
      t.deps,
      accountForgetJob({ userId: "usr_forget_5", workosUserId: user.id }),
    );
    await t.backgroundDone();
    expect((await stored(t, job!.id)).attempts).toBe(1);
    expect(t.workos.hasUser(user.id)).toBe(true);
    expect(t.posthogAdmin.requests.length).toBe(before);

    t.clock.advance(60_000);
    await runDueJobs(t.deps, "cron:test");
    expect(t.workos.hasUser(user.id)).toBe(false);
    expect((await stored(t, job!.id)).completedAt).toBeInstanceOf(Date);
  });

  test("a WorkOS user someone signed in with again since is kept, and PostHog is still asked", async () => {
    // The retry comes after the same person signed in again, on the same WorkOS user, as a
    // new account: that account keeps its WorkOS user.
    const again = await t.signInAs({ login: "vic" });
    const job = await runNow(
      t.deps,
      accountForgetJob({ userId: "usr_forget_6", workosUserId: again.workos.id }),
    );
    await t.backgroundDone();
    expect(t.workos.hasUser(again.workos.id)).toBe(true);
    expect((await call(t, again.headers, "GET", "/v1/me")).status).toBe(200);
    expect((await stored(t, job!.id)).completedAt).toBeInstanceOf(Date);
    expect(t.posthogAdmin.forgotten.at(-1)).toBe("usr_forget_6");
    expect(lines(t, "workos_forget_skipped").at(-1)).toMatchObject({
      userId: "usr_forget_6",
      reason: "signed_in_again",
    });
  });

  test("never logs or records an email or a key", async () => {
    const everything = JSON.stringify([t.logs, await t.db.select().from(jobs)]);
    for (const secret of [
      t.posthogAdmin.config.personalApiKey,
      t.workos.apiKey,
      "rae@example.com",
      "sol@example.com",
      "tom@example.com",
    ]) {
      expect(everything).not.toContain(secret);
    }
  });
});

describe("without PostHog's personal key", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  test("WorkOS is still forgotten, PostHog is skipped and logged, and the job completes", async () => {
    expect(t.deps.posthogAdmin).toBeNull();
    const user = t.workos.addUser({ email: "una@example.com" });
    const job = await runNow(
      t.deps,
      accountForgetJob({ userId: "usr_skip_1", workosUserId: user.id }),
    );
    await t.backgroundDone();
    expect(t.workos.hasUser(user.id)).toBe(false);
    expect((await stored(t, job!.id)).completedAt).toBeInstanceOf(Date);
    expect(lines(t, "analytics_forget_skipped")).toEqual([
      expect.objectContaining({ userId: "usr_skip_1" }),
    ]);
    expect(t.posthogAdmin.requests).toEqual([]);
  });
});
