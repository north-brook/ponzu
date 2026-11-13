import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sampleDoc } from "@ponzu/core/fixtures";
import {
  appendEvent,
  notificationDeliveries,
  notifications,
  recordRepoAccess,
  repushDeliveries,
} from "@ponzu/db";
import { runDueJobs } from "../jobs/run.ts";
import { call, canvasIn, type Workspace, workspaceWithRepo } from "../testing/canvases.ts";
import { createTestApp, type TestApp } from "../testing/index.ts";
import { notify } from "./notify.ts";
import { COMMENT_COLLAPSE_MS, MAC_DEFER_MS } from "./plan.ts";

/*
 * The triggers past questions and turns (docs/cloud.md, "Notifications"): a teammate's comment
 * and how comments fold together, a message that lapsed twice, a wake that gave up, and the
 * billing pings, on the real app with a fake Expo and a clock that moves only when a test moves
 * it. The pull request pings are in routes/github-webhook.test.ts, beside the webhooks that
 * cause them.
 */

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

/** A comment's words, which must never leave in a ping, a row or a log. */
const SECRET_WORDS = "Move the Nightjar launch to Thursday";

let scenes = 0;

/** A canvas owned by a new person with an iPhone, two teammates who can write, and a reader. */
async function scene() {
  const n = ++scenes;
  const owner = `maya${n}`;
  const mate = `sam${n}`;
  const other = `lee${n}`;
  const reader = `ines${n}`;
  const ws = await workspaceWithRepo(t, {
    [owner]: "admin",
    [mate]: "write",
    [other]: "write",
    [reader]: "read",
  });
  const canvas = await canvasIn(t, ws, owner, sampleDoc());
  const now = new Date(t.clock.now());
  await recordRepoAccess(
    t.db,
    [
      [owner, "admin"],
      [mate, "write"],
      [other, "write"],
      [reader, "read"],
    ].map(([login, permission]) => ({
      userId: ws.people[login!]!.userId,
      repoId: ws.repo.id,
      permission: permission as "admin" | "write" | "read",
      checkedAt: now,
    })),
  );
  const phone = await registerPhone(ws, owner);
  // A teammate's comments start off (as the board draws the toggles): the owner turns them on.
  await call(t, ws.people[owner]!.headers, "PATCH", "/v1/me/notifications", {
    teammateComments: true,
  });
  return { ws, canvas, owner, mate, other, reader, phone };
}

const tokenOf = (login: string) => `ExponentPushToken[${login}-phone-0000]`;

async function registerPhone(ws: Workspace, login: string) {
  const answer = await call(t, ws.people[login]!.headers, "POST", "/v1/me/devices", {
    platform: "ios",
    pushToken: tokenOf(login),
    pushEnvironment: "production",
    installId: `install-${login}-phone`,
    name: "iPhone",
  });
  expect(answer.status).toBe(201);
  return { id: answer.body.device.id as string, token: tokenOf(login) };
}

async function registerMac(ws: Workspace, login: string) {
  const answer = await call(t, ws.people[login]!.headers, "POST", "/v1/me/devices", {
    platform: "macos",
    installId: `install-${login}-mac0`,
    name: "Studio",
  });
  expect(answer.status).toBe(201);
  const id = answer.body.device.id as string;
  expect(
    (await call(t, ws.people[login]!.headers, "PUT", `/v1/me/devices/${id}/active`)).status,
  ).toBe(204);
  return id;
}

const pushesTo = (token: string) =>
  t.push.sent.filter((message) => message.to === token && message.body !== undefined);

/** Move the clock, then run every job that is due, as the cron would, until none is left. */
async function later(ms: number) {
  t.clock.advance(ms);
  for (let round = 0; round < 20; round++) {
    const { ran } = await runDueJobs(t.deps, `test:${crypto.randomUUID()}`);
    await t.backgroundDone();
    if (ran === 0) return;
  }
}

const rowsOf = async (where: { canvasId?: string; workspaceId?: string }) =>
  (await t.db.select().from(notifications))
    .filter((row) =>
      where.canvasId ? row.canvasId === where.canvasId : row.workspaceId === where.workspaceId,
    )
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));

const deliveriesOf = async (notificationId: string) =>
  (await t.db.select().from(notificationDeliveries)).filter(
    (row) => row.notificationId === notificationId,
  );

/** Post ops to a canvas as a person, and wait for what they set going. */
async function post(login: string, canvasId: string, ops: unknown[]) {
  // Signed in afresh: a test's clock can run past an access token's five minutes.
  const { headers } = await t.signInAs({ login });
  const answer = await call(t, headers, "POST", `/v1/canvases/${canvasId}/ops`, { ops });
  expect(answer.status).toBe(200);
  expect(answer.body.rejected).toEqual([]);
  await t.backgroundDone();
  return answer;
}

let threads = 0;

/** A new comment thread on the second page, by `login`, saying the secret words. */
function newThread(login: string) {
  const id = `th_ping${++threads}`;
  return {
    threadId: id,
    op: {
      id: `op_${id}`,
      op: {
        op: "thread.create",
        thread: {
          id,
          pageId: "pg_2",
          x: 0,
          y: 0,
          status: "open",
          createdAt: 0,
          updatedAt: 0,
          messages: [
            {
              id: `m_${id}`,
              author: { kind: "user", name: login },
              text: SECRET_WORDS,
              createdAt: 0,
            },
          ],
        },
      },
    },
  };
}

/** A reply in a thread, by `login`. */
function reply(threadId: string, login: string) {
  const id = `m_ping${++threads}`;
  return {
    id: `op_${id}`,
    op: {
      op: "thread.message",
      id: threadId,
      message: { id, author: { kind: "user", name: login }, text: SECRET_WORDS, createdAt: 0 },
    },
  };
}

describe("a teammate's comment", () => {
  test("pings the owner with where its pin is and never what it says; the owner's own pings nobody", async () => {
    const { ws, canvas, owner, mate, phone } = await scene();
    const matePhone = await registerPhone(ws, mate);
    const { threadId, op } = newThread(mate);
    await post(mate, canvas.id, [op]);

    const [row] = await rowsOf({ canvasId: canvas.id });
    expect(row).toMatchObject({
      userId: ws.people[owner]!.userId,
      kind: "teammate_comment",
      dedupeKey: `comment:${canvas.id}:m_${threadId}`,
      body: `Sam${scenes} commented.`,
      title: canvas.name,
      count: 1,
      people: [`Sam${scenes}`],
      link: { open: "comment", pageId: "pg_2", commentThreadId: threadId },
    });
    expect(pushesTo(phone.token)).toEqual([
      expect.objectContaining({
        body: `Sam${scenes} commented.`,
        collapseId: `${canvas.id}:comments`,
        data: {
          v: 1,
          n: row!.id,
          k: "teammate_comment",
          c: canvas.id,
          w: ws.id,
          o: "comment",
          p: "pg_2",
          t: threadId,
        },
      }),
    ]);

    // The owner's own comment, and their reply in the thread, ping nobody.
    await post(owner, canvas.id, [newThread(owner).op, reply(threadId, owner)]);
    expect(await rowsOf({ canvasId: canvas.id })).toHaveLength(1);
    expect(pushesTo(phone.token)).toHaveLength(1);
    expect(pushesTo(matePhone.token)).toHaveLength(0);

    const everything = JSON.stringify([t.push.sent, await rowsOf({ canvasId: canvas.id }), t.logs]);
    expect(everything).not.toContain("Nightjar");
  });

  test("comments within ten minutes fold into one row, pushed again under the same collapse id", async () => {
    const { ws, canvas, owner, mate, other, phone } = await scene();
    const sam = `Sam${scenes}`;
    const lee = `Lee${scenes}`;
    const first = newThread(mate);
    await post(mate, canvas.id, [first.op]);
    t.clock.advance(60_000);
    await post(mate, canvas.id, [reply(first.threadId, mate)]);
    t.clock.advance(60_000);
    await post(other, canvas.id, [newThread(other).op]);

    const rows = await rowsOf({ canvasId: canvas.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: ws.people[owner]!.userId,
      count: 3,
      people: [sam, lee],
      body: `${lee} and ${sam} left 3 comments.`,
      readAt: null,
    });
    const sent = pushesTo(phone.token);
    expect(sent.map((message) => message.body)).toEqual([
      `${sam} commented.`,
      `${sam} left 2 comments.`,
      `${lee} and ${sam} left 3 comments.`,
    ]);
    // One ping on the phone, its words replaced each time.
    expect(new Set(sent.map((message) => message.collapseId))).toEqual(
      new Set([`${canvas.id}:comments`]),
    );
    expect((await deliveriesOf(rows[0]!.id))[0]).toMatchObject({ state: "sent" });

    // Ten minutes after the row was made, a comment starts a new one.
    t.clock.advance(COMMENT_COLLAPSE_MS);
    await post(mate, canvas.id, [newThread(mate).op]);
    const after = await rowsOf({ canvasId: canvas.id });
    expect(after.map((row) => row.body)).toEqual([
      `${lee} and ${sam} left 3 comments.`,
      `${sam} commented.`,
    ]);
    expect(JSON.stringify([t.push.sent, after])).not.toContain("Nightjar");
  });

  test("a comment told twice folds in once, and one read already is not folded into", async () => {
    const { ws, canvas, owner, mate, phone } = await scene();
    const first = newThread(mate);
    await post(mate, canvas.id, [first.op]);
    const [row] = await rowsOf({ canvasId: canvas.id });
    const second = reply(first.threadId, mate);
    await post(mate, canvas.id, [second]);
    // The same comment's trigger again (its first job is over, so this is a new one).
    await notify(t.deps, {
      kind: "comment_posted",
      canvasId: canvas.id,
      messageId: second.op.message.id,
      authorId: ws.people[mate]!.userId,
      threadId: first.threadId,
      pageId: "pg_2",
      artboardId: null,
    });
    await t.backgroundDone();
    expect((await rowsOf({ canvasId: canvas.id }))[0]).toMatchObject({ id: row!.id, count: 2 });
    expect(pushesTo(phone.token)).toHaveLength(2);

    // Read on the Mac: the next comment is a ping of its own.
    await call(t, ws.people[owner]!.headers, "POST", `/v1/me/notifications/${row!.id}/read`, {
      via: "mac",
    });
    t.clock.advance(1000);
    await post(mate, canvas.id, [newThread(mate).op]);
    const rows = await rowsOf({ canvasId: canvas.id });
    expect(rows.map((r) => [r.count, r.body])).toEqual([
      [2, `Sam${scenes} left 2 comments.`],
      [1, `Sam${scenes} commented.`],
    ]);
  });

  test("at a Mac, a folded comment still waits its two minutes for the phone", async () => {
    const { ws, canvas, owner, mate, phone } = await scene();
    await registerMac(ws, owner);
    const first = newThread(mate);
    await post(mate, canvas.id, [first.op]);
    await post(mate, canvas.id, [reply(first.threadId, mate)]);
    expect(pushesTo(phone.token)).toHaveLength(0);
    await later(MAC_DEFER_MS);
    // One push, with the words as they stand when it goes.
    expect(pushesTo(phone.token).map((message) => message.body)).toEqual([
      `Sam${scenes} left 2 comments.`,
    ]);
  });

  test("a push set waiting again while its deliver job runs is still sent", async () => {
    const { ws, canvas, owner, mate, phone } = await scene();
    const secondToken = tokenOf(`${owner}-two`);
    const send = t.push.send.bind(t.push);
    let raced = false;
    // While the first push goes, a phone is added and a comment folds in: its notify job re-plans
    // the row's pushes while this deliver job still holds the job's key, so it can record none.
    t.push.send = async (messages) => {
      const tickets = await send(messages);
      if (!raced) {
        raced = true;
        const second = await call(t, ws.people[owner]!.headers, "POST", "/v1/me/devices", {
          platform: "ios",
          pushToken: secondToken,
          pushEnvironment: "production",
          installId: `install-${owner}-phone-two`,
          name: "iPhone",
        });
        expect(second.status).toBe(201);
        await repushDeliveries(t.db, {
          rows: [
            {
              notificationId: String(messages[0]!.data!.n),
              deviceId: second.body.device.id as string,
              sendAt: new Date(t.clock.now()),
            },
          ],
          now: new Date(t.clock.now()),
        });
      }
      return tickets;
    };
    try {
      await post(mate, canvas.id, [newThread(mate).op]);
      expect(pushesTo(phone.token)).toHaveLength(1);
      expect(pushesTo(secondToken)).toHaveLength(0);
      await later(1000);
      expect(pushesTo(secondToken)).toHaveLength(1);
      expect(pushesTo(phone.token)).toHaveLength(1);
    } finally {
      t.push.send = send;
    }
  });

  test("a toggle that is off keeps the row, muted, and folding into it pushes nothing", async () => {
    const { ws, canvas, owner, mate, phone } = await scene();
    await call(t, ws.people[owner]!.headers, "PATCH", "/v1/me/notifications", {
      teammateComments: false,
    });
    const first = newThread(mate);
    await post(mate, canvas.id, [first.op]);
    await post(mate, canvas.id, [reply(first.threadId, mate)]);
    expect((await rowsOf({ canvasId: canvas.id }))[0]).toMatchObject({ muted: true, count: 2 });
    expect(pushesTo(phone.token)).toHaveLength(0);
  });
});

describe("a turn that cannot go on", () => {
  test("a message that lapsed twice asks its person to send it again, once", async () => {
    const { ws, canvas, mate } = await scene();
    const matePhone = await registerPhone(ws, mate);
    const message = await appendEvent(t.db, {
      canvasId: canvas.id,
      kind: "message",
      priority: "now",
      payload: { text: SECRET_WORDS },
      userId: ws.people[mate]!.userId,
    });
    const trigger = {
      kind: "turn_lapsed_twice",
      canvasId: canvas.id,
      eventId: message.id,
    } as const;
    await notify(t.deps, trigger);
    await t.backgroundDone();
    await notify(t.deps, trigger);
    await t.backgroundDone();
    expect(pushesTo(matePhone.token).map((m) => m.body)).toEqual([
      "Ponzu couldn't get to your message. Send it again.",
    ]);
    expect((await rowsOf({ canvasId: canvas.id }))[0]).toMatchObject({
      kind: "failed",
      dedupeKey: `lapsed:${canvas.id}:${message.id}`,
      link: { open: "thread" },
    });
  });

  test("a wake that gave up tells whoever's message waits, or else the owner", async () => {
    const { ws, canvas, mate, phone } = await scene();
    const matePhone = await registerPhone(ws, mate);
    const failedAt = new Date(t.clock.now()).toISOString();
    await notify(t.deps, { kind: "wake_failed", canvasId: canvas.id, failedAt });
    await t.backgroundDone();
    // Nobody has said anything yet: the owner's canvas would not start.
    expect(pushesTo(phone.token).map((m) => m.body)).toEqual([
      "Ponzu couldn't start. Send a message to try again.",
    ]);

    // A message no runner ever took.
    await appendEvent(t.db, {
      canvasId: canvas.id,
      kind: "message",
      priority: "now",
      payload: { text: SECRET_WORDS },
      userId: ws.people[mate]!.userId,
    });
    t.clock.advance(1000);
    await notify(t.deps, {
      kind: "wake_failed",
      canvasId: canvas.id,
      failedAt: new Date(t.clock.now()).toISOString(),
    });
    await t.backgroundDone();
    expect(pushesTo(matePhone.token).map((m) => m.body)).toEqual([
      "Ponzu couldn't start. Send a message to try again.",
    ]);
    expect(pushesTo(phone.token)).toHaveLength(1);
  });
});

describe("billing", () => {
  const PERIOD = "2026-11-01T00:00:00.000Z";

  async function billed() {
    const s = await scene();
    // A known anchor, so the reset day is known: periods start on the 1st.
    await t.db.execute(
      `update workspaces set billing_period_anchor = '2026-01-01T00:00:00Z' where id = '${s.ws.id}'`,
    );
    return { ...s, name: s.ws.github.installation.account.login };
  }

  test("goes to the workspace's admins only, in billing's words, once a period, whatever their toggles", async () => {
    const { ws, owner, mate, phone, name } = await billed();
    const matePhone = await registerPhone(ws, mate);
    // Every toggle off: billing is always on.
    await call(t, ws.people[owner]!.headers, "PATCH", "/v1/me/notifications", {
      needsYou: false,
      replies: false,
      prReady: false,
      teammateComments: false,
    });
    const warn = {
      kind: "billing",
      workspaceId: ws.id,
      periodStart: PERIOD,
      notice: "cap_warning",
      amountCents: 10_000,
    } as const;
    await notify(t.deps, warn);
    await t.backgroundDone();
    await notify(t.deps, warn);
    await t.backgroundDone();
    // The same period, its start spelled another way, or an instant inside it, is the same once.
    await notify(t.deps, { ...warn, periodStart: "2026-11-01T00:00:00Z" });
    await notify(t.deps, { ...warn, periodStart: "2026-11-14T09:30:00Z" });
    await t.backgroundDone();

    const rows = await rowsOf({ workspaceId: ws.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: ws.people[owner]!.userId,
      canvasId: null,
      kind: "billing_cap_warning",
      dedupeKey: `billing:cap_warning:${ws.id}:${PERIOD}`,
      title: name,
      body: `${name} has used 80% of this month's $100 cap.`,
      link: { open: "usage" },
      muted: false,
    });
    expect(pushesTo(phone.token)).toEqual([
      expect.objectContaining({
        title: name,
        body: `${name} has used 80% of this month's $100 cap.`,
        threadId: ws.id,
        data: { v: 1, n: rows[0]!.id, k: "billing_cap_warning", w: ws.id, o: "usage" },
      }),
    ]);
    expect(pushesTo(matePhone.token)).toHaveLength(0);

    // The next period is another.
    await notify(t.deps, { ...warn, periodStart: "2026-12-01T00:00:00.000Z" });
    await t.backgroundDone();
    expect(await rowsOf({ workspaceId: ws.id })).toHaveLength(2);
  });

  test("each notice has its words", async () => {
    const { ws, phone, name } = await billed();
    const send = async (notice: string, amountCents: number | null) => {
      await notify(t.deps, {
        kind: "billing",
        workspaceId: ws.id,
        periodStart: PERIOD,
        notice: notice as "free_used",
        amountCents: amountCents as null,
      });
      await t.backgroundDone();
    };
    await send("free_used", null);
    await send("cap_reached", 25_000);
    await send("payment_failed", 123_450);
    expect(pushesTo(phone.token).map((message) => message.body)).toEqual([
      `${name} has used this month's free credits.`,
      `${name} reached this month's $250 cap. Canvases wait until it's raised or it resets on December 1.`,
      `${name}'s payment of $1,234.50 didn't go through.`,
    ]);
  });

  test("an amount that does not fit its notice is refused, so no ping says $0", async () => {
    const { ws, phone } = await billed();
    await notify(t.deps, {
      kind: "billing",
      workspaceId: ws.id,
      periodStart: PERIOD,
      notice: "cap_reached",
      amountCents: null,
    });
    await t.backgroundDone();
    expect(t.logs.at(-1)).toMatchObject({ event: "notify_failed", reason: "invalid_trigger" });
    expect(await rowsOf({ workspaceId: ws.id })).toEqual([]);
    expect(pushesTo(phone.token)).toHaveLength(0);
  });

  test("a personal workspace's person hears it as theirs, and its collaborators never do", async () => {
    const { ws, owner, mate, other, reader, phone } = await billed();
    // The workspace is the owner's own GitHub account. Everyone else in it is a collaborator on
    // its repos, one of them made an admin.
    await t.db.execute(
      `update workspaces set kind = 'personal', github_account_id = ${ws.people[owner]!.github.id} where id = '${ws.id}'`,
    );
    await t.db.execute(
      `update memberships set role = 'admin' where workspace_id = '${ws.id}' and user_id = '${ws.people[mate]!.userId}'`,
    );
    const collaborators = [mate, other, reader];
    const phones = await Promise.all(collaborators.map((login) => registerPhone(ws, login)));
    await notify(t.deps, {
      kind: "billing",
      workspaceId: ws.id,
      periodStart: PERIOD,
      notice: "free_used",
      amountCents: null,
    });
    await t.backgroundDone();
    expect(pushesTo(phone.token).map((message) => message.body)).toEqual([
      "You've used this month's free credits.",
    ]);
    // One row, the person's: no collaborator has it in their inbox or on their phone.
    const rows = await rowsOf({ workspaceId: ws.id });
    expect(rows.map((row) => row.userId)).toEqual([ws.people[owner]!.userId]);
    for (const collaborator of phones) expect(pushesTo(collaborator.token)).toHaveLength(0);
  });

  test("an admin who is not one by the time it goes is not pinged", async () => {
    const { ws, owner, phone } = await billed();
    await registerMac(ws, owner);
    await notify(t.deps, {
      kind: "billing",
      workspaceId: ws.id,
      periodStart: PERIOD,
      notice: "free_used",
      amountCents: null,
    });
    await t.backgroundDone();
    const [row] = await rowsOf({ workspaceId: ws.id });
    expect((await deliveriesOf(row!.id))[0]).toMatchObject({ state: "waiting" });
    await t.db.execute(
      `update memberships set role = 'member' where workspace_id = '${ws.id}' and user_id = '${ws.people[owner]!.userId}'`,
    );
    await later(MAC_DEFER_MS);
    expect(pushesTo(phone.token)).toHaveLength(0);
    expect((await deliveriesOf(row!.id))[0]).toMatchObject({
      state: "cancelled",
      outcome: "access",
    });
  });

  test("a collaborator's billing row in a personal workspace is not sent, its person's is", async () => {
    const { ws, owner, mate, phone } = await billed();
    const matePhone = await registerPhone(ws, mate);
    await registerMac(ws, owner);
    await registerMac(ws, mate);
    // Written while the workspace counted both as admins, as an older API would have for a
    // personal workspace's collaborator.
    await t.db.execute(
      `update memberships set role = 'admin' where workspace_id = '${ws.id}' and user_id = '${ws.people[mate]!.userId}'`,
    );
    await notify(t.deps, {
      kind: "billing",
      workspaceId: ws.id,
      periodStart: PERIOD,
      notice: "free_used",
      amountCents: null,
    });
    await t.backgroundDone();
    const rows = await rowsOf({ workspaceId: ws.id });
    const mateRow = rows.find((row) => row.userId === ws.people[mate]!.userId);
    expect(mateRow).toBeDefined();
    expect((await deliveriesOf(mateRow!.id))[0]).toMatchObject({ state: "waiting" });
    // Before it goes, the workspace turns out to be the owner's own account.
    await t.db.execute(
      `update workspaces set kind = 'personal', github_account_id = ${ws.people[owner]!.github.id} where id = '${ws.id}'`,
    );
    await later(MAC_DEFER_MS);
    expect(pushesTo(matePhone.token)).toHaveLength(0);
    expect((await deliveriesOf(mateRow!.id))[0]).toMatchObject({
      state: "cancelled",
      outcome: "access",
    });
    expect(pushesTo(phone.token)).toHaveLength(1);
  });
});
