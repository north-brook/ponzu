import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sampleDoc } from "@ponzu/core/fixtures";
import {
  appendEvent,
  cancelQuestions,
  claudeAccounts,
  createQuestion,
  devices,
  jobs,
  markCanvasSeen,
  newId,
  notificationDeliveries,
  notifications,
  recordRepoAccess,
} from "@ponzu/db";
import { runCronSteps } from "../cron/steps.ts";
import { runDueJobs } from "../jobs/run.ts";
import {
  call,
  canvasWithRunner,
  type StartedRunner,
  type Workspace,
  workspaceWithRepo,
} from "../testing/canvases.ts";
import { createTestApp, type TestApp } from "../testing/index.ts";
import { BADGE_FOLD_MS } from "./badge.ts";
import { RATE_LIMITED_WAIT_MS } from "./deliver.ts";
import { QUESTION_ESCALATE_MS } from "./kinds.ts";
import { NOTIFY_JOB, notify, runNotifyJob } from "./notify.ts";
import { MAC_DEFER_MS } from "./plan.ts";
import { LOST_SEND_MS, RECEIPT_AFTER_MS, RECEIPT_GIVE_UP_MS } from "./receipts.ts";

/*
 * The sending pipeline end to end, on the real app with a fake Expo and a clock that moves only
 * when a test moves it: a question raised by the runner, a turn reported, an answer given, and
 * what reaches each person's phone. Jobs left for later are run by moving the clock and running
 * what is due, as the minute's cron would.
 */

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

/** A question's words, which must never leave in a ping, a row or a log. */
const SECRET_WORDS = "Ship the launch plan for Project Nightjar";

let people = 0;

/** A canvas owned by a new person with an iPhone, a teammate who can steer, and a reader. */
async function scene(app: TestApp = t) {
  const n = ++people;
  const owner = `maya${n}`;
  const mate = `sam${n}`;
  const reader = `ines${n}`;
  const ws = await workspaceWithRepo(app, { [owner]: "admin", [mate]: "write", [reader]: "read" });
  const { canvas, runner } = await canvasWithRunner(app, ws, owner, sampleDoc());
  const now = new Date(app.clock.now());
  await recordRepoAccess(app.db, [
    { userId: ws.people[owner]!.userId, repoId: ws.repo.id, permission: "admin", checkedAt: now },
    { userId: ws.people[mate]!.userId, repoId: ws.repo.id, permission: "write", checkedAt: now },
    { userId: ws.people[reader]!.userId, repoId: ws.repo.id, permission: "read", checkedAt: now },
  ]);
  const phone = await registerPhone(app, ws, owner);
  return { ws, canvas, runner, owner, mate, reader, phone };
}

const tokenOf = (login: string) => `ExponentPushToken[${login}-phone-0000]`;

async function registerPhone(app: TestApp, ws: Workspace, login: string) {
  const answer = await call(app, ws.people[login]!.headers, "POST", "/v1/me/devices", {
    platform: "ios",
    pushToken: tokenOf(login),
    pushEnvironment: "production",
    installId: `install-${login}-phone`,
    name: "iPhone",
  });
  expect(answer.status).toBe(201);
  return { id: answer.body.device.id as string, token: tokenOf(login) };
}

async function registerMac(app: TestApp, ws: Workspace, login: string) {
  const answer = await call(app, ws.people[login]!.headers, "POST", "/v1/me/devices", {
    platform: "macos",
    installId: `install-${login}-mac0`,
    name: "Studio",
  });
  expect(answer.status).toBe(201);
  return answer.body.device.id as string;
}

async function raise(runner: StartedRunner, kind = "question", app: TestApp = t) {
  const id = newId("q");
  const payload =
    kind === "plan"
      ? { plan: SECRET_WORDS }
      : {
          questions: [{ header: "Plan", question: SECRET_WORDS, options: [], multiSelect: false }],
        };
  const answer = await call(app, runner.headers, "POST", "/v1/runner/questions", {
    id,
    kind,
    payload,
  });
  expect(answer.status).toBe(200);
  await app.backgroundDone();
  return id;
}

/** Every push sent to this token, oldest first. */
const pushesTo = (token: string, app: TestApp = t) =>
  app.push.sent.filter((message) => message.to === token);

/** Move the clock, then run every job that is due, as the cron would, until none is left. */
async function later(ms: number, app: TestApp = t) {
  app.clock.advance(ms);
  for (let round = 0; round < 20; round++) {
    const { ran } = await runDueJobs(app.deps, `test:${crypto.randomUUID()}`);
    await app.backgroundDone();
    if (ran === 0) return;
  }
}

const rowsOf = async (canvasId: string, app: TestApp = t) =>
  (await app.db.select().from(notifications))
    .filter((row) => row.canvasId === canvasId)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));

const deliveriesOf = async (notificationId: string, app: TestApp = t) =>
  (await app.db.select().from(notificationDeliveries)).filter(
    (row) => row.notificationId === notificationId,
  );

const deviceRows = async (id: string) =>
  (await t.db.select().from(devices)).filter((row) => row.id === id);

describe("a question", () => {
  test("pings the owner's phone once, in Ponzu's words, and a repeat raises nothing new", async () => {
    const { canvas, runner, phone, ws, owner } = await scene();
    const id = await raise(runner);

    const sent = pushesTo(phone.token);
    expect(sent).toHaveLength(1);
    const [row] = await rowsOf(canvas.id);
    expect(sent[0]).toEqual({
      to: phone.token,
      title: canvas.name,
      body: "Ponzu has a question for you.",
      sound: "default",
      badge: 1,
      threadId: canvas.id,
      collapseId: row!.id,
      priority: "high",
      interruptionLevel: "active",
      ttl: 3600,
      data: { v: 1, n: row!.id, k: "needs_you", c: canvas.id, w: ws.id, o: "thread", q: id },
    });
    expect(row).toMatchObject({
      userId: ws.people[owner]!.userId,
      kind: "needs_you",
      dedupeKey: `needs_you:${canvas.id}:${id}`,
      sourceId: id,
      muted: false,
      readAt: null,
      link: { open: "thread", questionId: id },
    });
    expect((await deliveriesOf(row!.id))[0]).toMatchObject({ state: "sent", attempts: 1 });

    // The runner raising it again after a lost answer is not a new question.
    await call(t, runner.headers, "POST", "/v1/runner/questions", {
      id,
      kind: "question",
      payload: { questions: [] },
    });
    await t.backgroundDone();
    expect(pushesTo(phone.token)).toHaveLength(1);
    expect(await rowsOf(canvas.id)).toHaveLength(1);

    // Nothing the agent wrote went anywhere.
    const everything = JSON.stringify([t.push.sent, await rowsOf(canvas.id), t.logs]);
    expect(everything).not.toContain("Nightjar");
    expect(t.analytics.of("notification created").at(-1)!.properties).toMatchObject({
      kind: "needs_you",
      muted: false,
      suppressed: null,
      pushes: 1,
      deferred: false,
    });
  });

  test("each kind of question has its own sentence", async () => {
    const { runner, phone } = await scene();
    await raise(runner, "plan");
    expect(pushesTo(phone.token).map((message) => message.body)).toEqual([
      "Ponzu has a plan for you to look at.",
    ]);
  });

  test("reaches the other steerers who opened the canvas five minutes on, only if still open", async () => {
    const { ws, canvas, runner, mate, reader } = await scene();
    const matePhone = await registerPhone(t, ws, mate);
    const readerPhone = await registerPhone(t, ws, reader);
    await markCanvasSeen(t.db, { userId: ws.people[mate]!.userId, canvasId: canvas.id });
    await markCanvasSeen(t.db, { userId: ws.people[reader]!.userId, canvasId: canvas.id });

    const open = await raise(runner);
    expect(pushesTo(matePhone.token)).toHaveLength(0);
    const answered = await raise(runner);
    const answer = await call(
      t,
      ws.people[mate]!.headers,
      "POST",
      `/v1/canvases/${canvas.id}/questions/${answered}/answer`,
      { answers: { [SECRET_WORDS]: "Yes" } },
    );
    expect(answer.status).toBe(200);

    await later(QUESTION_ESCALATE_MS - 1000);
    expect(pushesTo(matePhone.token)).toHaveLength(0);
    await later(1000);
    // The one still open reaches the teammate who can steer; the reader can't answer it.
    expect(pushesTo(matePhone.token).map((message) => message.data?.q)).toEqual([open]);
    expect(pushesTo(readerPhone.token)).toHaveLength(0);
  });

  test("answering resolves it, reads it for whoever answered, and pushes the lower badge", async () => {
    const { ws, canvas, runner, owner, phone } = await scene();
    const id = await raise(runner);
    const answer = await call(
      t,
      ws.people[owner]!.headers,
      "POST",
      `/v1/canvases/${canvas.id}/questions/${id}/answer`,
      { answers: { [SECRET_WORDS]: "Yes" } },
    );
    expect(answer.status).toBe(200);
    const [row] = await rowsOf(canvas.id);
    expect(row).toMatchObject({ readVia: "seen" });
    expect(row!.resolvedAt).not.toBeNull();

    await later(BADGE_FOLD_MS);
    expect(pushesTo(phone.token).at(-1)).toEqual({
      to: phone.token,
      badge: 0,
      priority: "high",
      interruptionLevel: "active",
      ttl: 3600,
    });
  });

  test("a withdrawal resolves it and pushes the badge", async () => {
    const { canvas, runner, phone } = await scene();
    const id = await raise(runner);
    await call(t, runner.headers, "POST", "/v1/runner/questions/withdraw", { ids: [id] });
    expect((await rowsOf(canvas.id))[0]!.resolvedAt).not.toBeNull();
    await later(BADGE_FOLD_MS);
    expect(pushesTo(phone.token).map((message) => message.badge)).toEqual([1, 0]);
  });
});

describe("the quiet rules", () => {
  test("nothing is pushed about a canvas the person is looking at, and it is read at once", async () => {
    const { ws, canvas, runner, owner, phone } = await scene();
    const presence = await call(
      t,
      ws.people[owner]!.headers,
      "PUT",
      `/v1/canvases/${canvas.id}/presence`,
      { focused: true },
    );
    expect(presence.status).toBe(200);
    await raise(runner);
    expect(pushesTo(phone.token)).toHaveLength(0);
    expect((await rowsOf(canvas.id))[0]).toMatchObject({ readVia: "looking" });
    // The badge still counts it, so the phone hears the new number without a ping.
    await later(BADGE_FOLD_MS);
    expect(pushesTo(phone.token)).toEqual([expect.objectContaining({ badge: 1 })]);
    expect(pushesTo(phone.token)[0]!.body).toBeUndefined();
  });

  test("at a Mac, the phone waits two minutes, and is not pinged once it is read there", async () => {
    const { ws, canvas, runner, owner, phone } = await scene();
    const mac = await registerMac(t, ws, owner);
    expect(
      (await call(t, ws.people[owner]!.headers, "PUT", `/v1/me/devices/${mac}/active`)).status,
    ).toBe(204);
    await raise(runner);
    expect(pushesTo(phone.token)).toHaveLength(0);
    const [row] = await rowsOf(canvas.id);
    expect((await deliveriesOf(row!.id))[0]).toMatchObject({ state: "waiting" });

    // Clicked on the Mac.
    const read = await call(
      t,
      ws.people[owner]!.headers,
      "POST",
      `/v1/me/notifications/${row!.id}/read`,
      { via: "mac" },
    );
    expect(read.status).toBe(204);
    await later(MAC_DEFER_MS);
    expect(pushesTo(phone.token)).toHaveLength(0);
    expect((await deliveriesOf(row!.id))[0]).toMatchObject({
      state: "cancelled",
      outcome: "read",
    });
  });

  test("at a Mac and not read there, the phone is pinged two minutes on", async () => {
    const { ws, runner, owner, phone } = await scene();
    const mac = await registerMac(t, ws, owner);
    await call(t, ws.people[owner]!.headers, "PUT", `/v1/me/devices/${mac}/active`);
    await raise(runner);
    await later(MAC_DEFER_MS - 1000);
    expect(pushesTo(phone.token)).toHaveLength(0);
    await later(1000);
    expect(pushesTo(phone.token)).toHaveLength(1);
  });

  test("answering on the Mac within the two minutes cancels the phone's ping", async () => {
    const { ws, canvas, runner, owner, phone } = await scene();
    const mac = await registerMac(t, ws, owner);
    await call(t, ws.people[owner]!.headers, "PUT", `/v1/me/devices/${mac}/active`);
    const id = await raise(runner);
    await call(
      t,
      ws.people[owner]!.headers,
      "POST",
      `/v1/canvases/${canvas.id}/questions/${id}/answer`,
      { answers: { [SECRET_WORDS]: "Yes" } },
    );
    await later(MAC_DEFER_MS);
    const [row] = await rowsOf(canvas.id);
    expect((await deliveriesOf(row!.id))[0]).toMatchObject({
      state: "cancelled",
      outcome: "read",
    });
    expect(pushesTo(phone.token).filter((message) => message.body)).toHaveLength(0);
  });

  test("a question that closed without its route saying so is not pinged, and is resolved", async () => {
    const { ws, canvas, runner, owner, phone } = await scene();
    const mac = await registerMac(t, ws, owner);
    await call(t, ws.people[owner]!.headers, "PUT", `/v1/me/devices/${mac}/active`);
    const id = await raise(runner);
    // Closed straight in the database, as a sandbox lost or a request that died would leave it:
    // nothing resolved the row, and the cron's sweep has not run yet.
    await cancelQuestions(t.db, { canvasId: canvas.id, ids: [id] });
    await later(MAC_DEFER_MS);
    const [row] = await rowsOf(canvas.id);
    expect(row!.resolvedAt).not.toBeNull();
    expect((await deliveriesOf(row!.id))[0]).toMatchObject({
      state: "cancelled",
      outcome: "resolved",
    });
    expect(pushesTo(phone.token).filter((message) => message.body)).toHaveLength(0);
    await later(BADGE_FOLD_MS);
    expect(pushesTo(phone.token).at(-1)).toMatchObject({ badge: 0 });
  });

  test("a toggle that is off keeps the row, muted, and pushes nothing", async () => {
    const { ws, canvas, runner, owner, phone } = await scene();
    await call(t, ws.people[owner]!.headers, "PATCH", "/v1/me/notifications", {
      needsYou: false,
    });
    await raise(runner);
    expect((await rowsOf(canvas.id))[0]).toMatchObject({ muted: true, readAt: null });
    expect(pushesTo(phone.token).filter((message) => message.body)).toHaveLength(0);
  });

  test("losing access between the ping and its send cancels it as access", async () => {
    const { ws, canvas, runner, owner, phone } = await scene();
    const mac = await registerMac(t, ws, owner);
    await call(t, ws.people[owner]!.headers, "PUT", `/v1/me/devices/${mac}/active`);
    await raise(runner);
    await recordRepoAccess(t.db, [
      {
        userId: ws.people[owner]!.userId,
        repoId: ws.repo.id,
        permission: "none",
        checkedAt: new Date(t.clock.now()),
      },
    ]);
    await later(MAC_DEFER_MS);
    expect(pushesTo(phone.token)).toHaveLength(0);
    const [row] = await rowsOf(canvas.id);
    expect((await deliveriesOf(row!.id))[0]).toMatchObject({
      state: "cancelled",
      outcome: "access",
    });
  });
});

describe("Expo's answers", () => {
  test("DeviceNotRegistered forgets the phone and fails the delivery", async () => {
    const { canvas, runner, phone } = await scene();
    t.push.answerNext({ ok: false, error: "DeviceNotRegistered" });
    await raise(runner);
    const [row] = await rowsOf(canvas.id);
    expect((await deliveriesOf(row!.id))[0]).toMatchObject({
      state: "failed",
      outcome: "DeviceNotRegistered",
    });
    expect(await deviceRows(phone.id)).toEqual([]);
    expect(t.logs.some((line) => line.event === "device_unregistered")).toBe(true);
  });

  test("a 429 waits and tries again, sending once", async () => {
    const { canvas, runner, phone } = await scene();
    t.push.failNext("rate_limited");
    await raise(runner);
    const [row] = await rowsOf(canvas.id);
    expect((await deliveriesOf(row!.id))[0]).toMatchObject({ state: "waiting", attempts: 1 });
    expect(pushesTo(phone.token)).toHaveLength(0);
    const deliver = (await t.db.select().from(jobs)).find((job) => job.key === row!.id)!;
    expect(deliver.lastError).toContain("RetryLater");

    await later(RATE_LIMITED_WAIT_MS);
    expect(pushesTo(phone.token)).toHaveLength(1);
    expect((await deliveriesOf(row!.id))[0]).toMatchObject({ state: "sent", attempts: 2 });
  });

  test("a 429 on every attempt fails the push in the end rather than leaving it waiting", async () => {
    const { canvas, runner, phone } = await scene();
    t.push.failNext("rate_limited", "rate_limited", "rate_limited", "rate_limited", "rate_limited");
    await raise(runner);
    const [row] = await rowsOf(canvas.id);
    for (let attempt = 2; attempt <= 5; attempt++) await later(RATE_LIMITED_WAIT_MS);
    expect(pushesTo(phone.token)).toHaveLength(0);
    expect((await deliveriesOf(row!.id))[0]).toMatchObject({
      state: "failed",
      outcome: "rate_limited",
      attempts: 5,
    });
    const deliver = (await t.db.select().from(jobs)).find((job) => job.key === row!.id)!;
    expect(deliver.completedAt).not.toBeNull();
  });

  test("a 5xx may have been taken, so it is never sent again, and is unknown in the end", async () => {
    const { canvas, runner, phone } = await scene();
    t.push.failNext("unavailable");
    await raise(runner);
    const [row] = await rowsOf(canvas.id);
    expect((await deliveriesOf(row!.id))[0]).toMatchObject({ state: "sending" });
    await later(RATE_LIMITED_WAIT_MS);
    await later(LOST_SEND_MS);
    await runCronSteps(t.deps, new Date(t.clock.now()));
    expect(pushesTo(phone.token)).toHaveLength(0);
    expect((await deliveriesOf(row!.id))[0]).toMatchObject({
      state: "unknown",
      outcome: "no_answer",
    });
  });

  test("receipts settle at fifteen minutes, and a missing one is unknown after a day", async () => {
    const { canvas, runner } = await scene();
    await raise(runner);
    await raise(runner);
    const rows = await rowsOf(canvas.id);
    const [first, second] = await Promise.all(rows.map((row) => deliveriesOf(row.id)));
    t.push.settle(first![0]!.ticketId!, { ok: true });

    const cron = () => runCronSteps(t.deps, new Date(t.clock.now()));
    t.clock.advance(RECEIPT_AFTER_MS - 1000);
    await cron();
    expect((await deliveriesOf(rows[0]!.id))[0]!.state).toBe("sent");
    t.clock.advance(1000);
    await cron();
    expect((await deliveriesOf(rows[0]!.id))[0]!.state).toBe("delivered");
    expect((await deliveriesOf(rows[1]!.id))[0]!.state).toBe("sent");

    t.clock.advance(RECEIPT_GIVE_UP_MS);
    await cron();
    expect((await deliveriesOf(rows[1]!.id))[0]).toMatchObject({
      state: "unknown",
      outcome: "no_receipt",
    });
    void second;
  });

  test("a receipt's DeviceNotRegistered forgets a phone unseen since, and keeps one that registered again", async () => {
    const { ws, canvas, runner, owner, phone } = await scene();
    await raise(runner);
    const [row] = await rowsOf(canvas.id);
    const [delivery] = await deliveriesOf(row!.id);
    t.push.settle(delivery!.ticketId!, { ok: false, error: "DeviceNotRegistered" });
    // The phone registers again, with a new token on the same row, before the receipt is read.
    t.clock.advance(1000);
    await call(t, ws.people[owner]!.headers, "PATCH", `/v1/me/devices/${phone.id}`, {
      pushToken: `ExponentPushToken[${owner}-phone-0001]`,
    });
    t.clock.advance(RECEIPT_AFTER_MS);
    await runCronSteps(t.deps, new Date(t.clock.now()));
    expect((await deliveriesOf(row!.id))[0]).toMatchObject({
      state: "failed",
      outcome: "DeviceNotRegistered",
    });
    expect(await deviceRows(phone.id)).toHaveLength(1);
    // The failure is the person's, so their usage switch can drop it.
    expect(t.analytics.of("push failed").at(-1)).toMatchObject({
      distinctId: ws.people[owner]!.userId,
      properties: { kind: "needs_you", error: "DeviceNotRegistered" },
    });
  });
});

describe("turns", () => {
  async function report(
    runner: StartedRunner,
    turn: { eventId: string | null; outcome?: string; errorCode?: string | null; ms?: number },
  ) {
    const answer = await call(t, runner.headers, "POST", "/v1/runner/usage", {
      turns: [
        {
          id: crypto.randomUUID(),
          claudeSessionId: "sess-1",
          at: new Date(t.clock.now()).toISOString(),
          models: [],
          turn: {
            startedAt: new Date(t.clock.now()).toISOString(),
            outcome: turn.outcome ?? "completed",
            errorCode: turn.errorCode ?? null,
            durationMs: turn.ms ?? 90_000,
            toolCalls: 3,
            eventId: turn.eventId,
          },
        },
      ],
    });
    expect(answer.status).toBe(200);
    await t.backgroundDone();
  }

  test("a turn a comment began replies to its commenter", async () => {
    const { ws, canvas, runner, mate } = await scene();
    const matePhone = await registerPhone(t, ws, mate);
    const event = await appendEvent(t.db, {
      canvasId: canvas.id,
      kind: "comment",
      priority: "next",
      payload: {},
      userId: ws.people[mate]!.userId,
    });
    await report(runner, { eventId: event.id, ms: 5000 });
    expect(pushesTo(matePhone.token).map((message) => message.body)).toEqual([
      "Ponzu replied to your comment.",
    ]);
  });

  test("a message's turn is finished only after a minute's work, and failed in its own words", async () => {
    const { ws, canvas, runner, owner, phone } = await scene();
    const message = () =>
      appendEvent(t.db, {
        canvasId: canvas.id,
        kind: "message",
        priority: "now",
        payload: { text: SECRET_WORDS },
        userId: ws.people[owner]!.userId,
      });
    await report(runner, { eventId: (await message()).id, ms: 60_000 });
    expect(pushesTo(phone.token)).toHaveLength(0);
    await report(runner, { eventId: (await message()).id, ms: 60_001 });
    await report(runner, {
      eventId: (await message()).id,
      outcome: "failed",
      errorCode: "turn_failed",
      ms: 1000,
    });
    await report(runner, {
      eventId: (await message()).id,
      outcome: "failed",
      errorCode: "claude_auth",
      ms: 1000,
    });
    // A stop pings nobody.
    await report(runner, { eventId: (await message()).id, outcome: "stopped" });
    expect(pushesTo(phone.token).map((m) => m.body)).toEqual([
      "Ponzu finished what you asked.",
      "Ponzu stopped before it finished. Open the thread to see why.",
      "Ponzu can't reach your Claude account. Connect it again to go on.",
    ]);
    expect(JSON.stringify(t.push.sent)).not.toContain("Nightjar");
  });

  test("a Claude plan limit goes to whoever's account the canvas runs on, once a day", async () => {
    const { ws, canvas, runner, owner, mate } = await scene();
    const matePhone = await registerPhone(t, ws, mate);
    const accountId = newId("cla");
    await t.db.insert(claudeAccounts).values({
      id: accountId,
      userId: ws.people[mate]!.userId,
      kind: "subscription",
      // A sealed credential is not what this is about.
      encryptedCredential: "sealed",
    });
    await t.db.execute(
      `update canvases set claude_account_id = '${accountId}' where id = '${canvas.id}'`,
    );
    const event = () =>
      appendEvent(t.db, {
        canvasId: canvas.id,
        kind: "message",
        priority: "now",
        payload: { text: "go" },
        userId: ws.people[owner]!.userId,
      });
    const limit = { outcome: "failed", errorCode: "claude_limit", ms: 1000 };
    await report(runner, { eventId: (await event()).id, ...limit });
    await report(runner, { eventId: (await event()).id, ...limit });
    expect(pushesTo(matePhone.token).map((message) => message.body)).toEqual([
      "Your Claude plan hit a limit. Canvases wait until it resets.",
    ]);
    const [row] = (await rowsOf(canvas.id)).filter((r) => r.kind === "claude_limit");
    expect(row!.dedupeKey).toBe(
      `limit:${accountId}:${new Date(t.clock.now()).toISOString().slice(0, 10)}`,
    );
  });

  test("the same report twice is one ping", async () => {
    const { ws, canvas, runner, owner, phone } = await scene();
    const event = await appendEvent(t.db, {
      canvasId: canvas.id,
      kind: "message",
      priority: "now",
      payload: { text: "go" },
      userId: ws.people[owner]!.userId,
    });
    const turn = {
      id: crypto.randomUUID(),
      claudeSessionId: "sess-1",
      at: new Date(t.clock.now()).toISOString(),
      models: [],
      turn: {
        startedAt: new Date(t.clock.now()).toISOString(),
        outcome: "completed",
        errorCode: null,
        durationMs: 120_000,
        toolCalls: 1,
        eventId: event.id,
      },
    };
    await call(t, runner.headers, "POST", "/v1/runner/usage", { turns: [turn] });
    await t.backgroundDone();
    await call(t, runner.headers, "POST", "/v1/runner/usage", { turns: [turn] });
    await t.backgroundDone();
    expect(pushesTo(phone.token)).toHaveLength(1);
  });
});

describe("the job", () => {
  test("run again after it wrote its rows, it plans their pushes once; another job's rows are not its own", async () => {
    const { canvas, runner, phone } = await scene();
    const id = newId("q");
    await createQuestion(t.db, { canvasId: canvas.id, id, kind: "question", payload: {} });
    const trigger = {
      kind: "question_raised",
      canvasId: canvas.id,
      questionId: id,
      questionKind: "question",
    };
    const job = {
      id: "job_retried",
      kind: NOTIFY_JOB,
      payload: trigger,
      attempts: 1,
      maxAttempts: 5,
    };
    await runNotifyJob(t.deps, trigger, job);
    await runNotifyJob(t.deps, trigger, { ...job, attempts: 2 });
    await runNotifyJob(t.deps, trigger, { ...job, id: "job_another" });
    expect(await rowsOf(canvas.id)).toHaveLength(1);
    expect(pushesTo(phone.token)).toHaveLength(1);
    void runner;
  });

  test("notify never throws: a trigger that is not well formed is logged and dropped", async () => {
    await notify(t.deps, {
      kind: "question_raised",
      canvasId: "not an id!",
      questionId: "q_1",
      questionKind: "question",
    });
    expect(t.logs.at(-1)).toMatchObject({ event: "notify_failed", reason: "invalid_trigger" });
  });
});

describe("push off", () => {
  test("without EXPO_ACCESS_TOKEN the inbox row is made and every push is cancelled as push_off", async () => {
    const off = await createTestApp({ push: false });
    try {
      const { canvas, runner } = await scene(off);
      await raise(runner, "question", off);
      const rows = await rowsOf(canvas.id, off);
      expect(rows).toHaveLength(1);
      expect((await deliveriesOf(rows[0]!.id, off))[0]).toMatchObject({
        state: "cancelled",
        outcome: "push_off",
      });
      expect(off.push.sent).toEqual([]);
      // No badge job either: nothing could send it.
      expect(
        (await off.db.select().from(jobs)).some((job) => job.kind === "notification.badge"),
      ).toBe(false);
    } finally {
      await off.close();
    }
  });
});
