import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { seedCanvas, seedUser } from "../fixtures.ts";
import { devices, notificationDeliveries, notifications, users } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { deleteUser } from "./account-deletion.ts";
import {
  badgeCount,
  collapseCommentNotification,
  type DeviceRegistration,
  dueDeliveries,
  forgetDeadTokens,
  forgetDevices,
  forgetDevicesUnseenSince,
  insertDeliveries,
  insertNotifications,
  lastNotifiedAt,
  listDevices,
  listRecentForDigest,
  MAX_DEVICES_PER_USER,
  markDeliveries,
  markNotificationsRead,
  type NewNotification,
  pruneDevices,
  pruneNotifications,
  receiptsDue,
  recentPushes,
  registerDevice,
  repushDeliveries,
  resolveClosedQuestions,
  resolveNeedsYou,
  setTimeZone,
  settleLostSends,
  touchDeviceActive,
  updateDevice,
} from "./notifications.ts";
import { focusedPresence, touchPresence } from "./presence.ts";
import { answerQuestion, cancelQuestions, createQuestion } from "./questions.ts";
import { run as runQuery } from "./run.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

/** Through the package's own `run`, so a refusal says which constraint, as Postgres does. */
const run = <T>(query: PromiseLike<T>) => runQuery(query);

// The time is the caller's: these move it by hand.
const start = new Date("2026-11-12T12:00:00Z");
const after = (ms: number) => new Date(start.getTime() + ms);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

let serial = 0;
const token = () => `ExponentPushToken[tok-${(serial++).toString().padStart(6, "0")}]`;
const install = () => `install-${(serial++).toString().padStart(12, "0")}`;

function phone(
  userId: string,
  extra: Partial<Extract<DeviceRegistration, { platform: "ios" }>> = {},
): Extract<DeviceRegistration, { platform: "ios" }> {
  return {
    userId,
    platform: "ios",
    pushToken: token(),
    pushEnvironment: "production",
    installId: install(),
    name: "iPhone 16 Pro",
    appVersion: "0.13.0",
    pingsBlocked: false,
    ...extra,
  };
}

async function registered(device: DeviceRegistration) {
  const answer = await registerDevice(db, device);
  if (answer.status !== "registered") throw new Error("not registered");
  return answer;
}

function needsYou(
  userId: string,
  canvasId: string,
  questionId: string,
  extra: Partial<NewNotification> = {},
): NewNotification {
  return {
    userId,
    workspaceId: null,
    canvasId,
    kind: "needs_you",
    dedupeKey: `needs_you:${canvasId}:${questionId}`,
    title: "Lisbon",
    body: "Ponzu has a question for you.",
    link: { open: "thread", questionId },
    sourceId: questionId,
    muted: false,
    ...extra,
  };
}

describe("devices", () => {
  test("an iPhone has a token and a Mac has none, by the database's own check", async () => {
    const user = await seedUser(db, "checked");
    const row = { userId: user.id, installId: install(), pushEnvironment: null };
    await expect(
      run(
        db.insert(devices).values({ ...row, id: "dev_a", platform: "macos", pushToken: token() }),
      ),
    ).rejects.toThrow("devices_push_token_check");
    await expect(
      run(db.insert(devices).values({ ...row, id: "dev_b", platform: "ios", pushToken: null })),
    ).rejects.toThrow("devices_push_token_check");
  });

  test("an iPhone registers, and registering again is the same row", async () => {
    const user = await seedUser(db, "phone");
    const device = phone(user.id);
    const first = await registered(device);
    expect(first.created).toBe(true);
    expect(first.device).toMatchObject({
      platform: "ios",
      pushToken: device.pushToken,
      installId: device.installId,
      activeAt: null,
    });
    const again = await registered({ ...device, appVersion: "0.14.0", pingsBlocked: true });
    expect(again.created).toBe(false);
    expect(again.device).toMatchObject({
      id: first.device.id,
      appVersion: "0.14.0",
      pingsBlocked: true,
    });
  });

  test("a new token from the same install replaces the old one in place", async () => {
    const user = await seedUser(db, "rotated");
    const device = phone(user.id);
    const first = await registered(device);
    await updateDevice(db, {
      userId: user.id,
      id: first.device.id,
      changes: { pingsEnabled: false },
    });
    const fresh = token();
    const rotated = await registered({ ...device, pushToken: fresh });
    expect(rotated.created).toBe(false);
    expect(rotated.device).toMatchObject({ id: first.device.id, pushToken: fresh });
    // The person's choice stays with the device.
    expect(rotated.device.pingsEnabled).toBe(false);
    expect((await listDevices(db, user.id)).map((d) => d.id)).toEqual([first.device.id]);
  });

  test("a phone signed in as someone else moves to them, pings on, and keeps one row per install", async () => {
    const maya = await seedUser(db, "maya-moves");
    const ines = await seedUser(db, "ines-moves");
    const device = phone(maya.id);
    const mine = await registered(device);
    await updateDevice(db, {
      userId: maya.id,
      id: mine.device.id,
      changes: { pingsEnabled: false },
    });
    // Ines had already used this phone once, under another token.
    const hers = await registered({ ...device, userId: ines.id, pushToken: token() });
    const moved = await registered({ ...device, userId: ines.id });
    expect(moved).toMatchObject({
      created: true,
      movedFrom: maya.id,
      device: { id: mine.device.id, userId: ines.id, pingsEnabled: true },
    });
    expect(await listDevices(db, maya.id)).toEqual([]);
    const left = await listDevices(db, ines.id);
    expect(left.map((d) => d.id)).toEqual([mine.device.id]);
    expect(left.map((d) => d.id)).not.toContain(hers.device.id);
  });

  test("another install's token stays with whoever holds it", async () => {
    const maya = await seedUser(db, "maya-holds");
    const ines = await seedUser(db, "ines-tries");
    const device = phone(maya.id);
    const mine = await registered(device);
    const before = await listDevices(db, ines.id);
    expect(await registerDevice(db, { ...device, userId: ines.id, installId: install() })).toEqual({
      status: "taken",
      holderId: maya.id,
    });
    expect((await listDevices(db, maya.id)).map((d) => d.id)).toEqual([mine.device.id]);
    expect(await listDevices(db, ines.id)).toEqual(before);
  });

  test("a Mac registers by its install, with no token, and again in place", async () => {
    const user = await seedUser(db, "mac");
    const mac = {
      userId: user.id,
      platform: "macos" as const,
      installId: install(),
      name: "Studio",
      appVersion: "2.0.0",
    };
    const first = await registered(mac);
    expect(first.created).toBe(true);
    expect(first.device).toMatchObject({
      platform: "macos",
      pushToken: null,
      pushEnvironment: null,
    });
    const again = await registered({ ...mac, name: null, appVersion: "2.1.0" });
    expect(again.created).toBe(false);
    expect(again.device).toMatchObject({
      id: first.device.id,
      name: "Studio",
      appVersion: "2.1.0",
    });
    // The same install for another person is their own row.
    const other = await seedUser(db, "mac-other");
    const theirs = await registered({ ...mac, userId: other.id });
    expect(theirs.device.id).not.toBe(first.device.id);
    // A Mac takes no token.
    await expect(
      updateDevice(db, { userId: user.id, id: first.device.id, changes: { pushToken: token() } }),
    ).rejects.toThrow("devices_push_token_check");
  });

  test("a Mac whose install is one of the person's iPhones' changes nothing", async () => {
    const user = await seedUser(db, "mac-clash");
    const device = phone(user.id);
    await registered(device);
    expect(
      await registerDevice(db, {
        userId: user.id,
        platform: "macos",
        installId: device.installId,
        name: null,
        appVersion: null,
      }),
    ).toEqual({ status: "taken", holderId: user.id });
    expect((await listDevices(db, user.id)).map((d) => d.platform)).toEqual(["ios"]);
  });

  test("an iPhone whose install is the person's Mac's changes nothing", async () => {
    const user = await seedUser(db, "phone-clash");
    const mac = await registered({
      userId: user.id,
      platform: "macos",
      installId: install(),
      name: "Studio",
      appVersion: null,
    });
    // A new token, and a token the person already has on another install: neither takes the Mac.
    const other = await registered(phone(user.id));
    for (const pushToken of [token(), other.device.pushToken!]) {
      expect(
        await registerDevice(db, {
          ...phone(user.id),
          installId: mac.device.installId!,
          pushToken,
        }),
      ).toEqual({ status: "taken", holderId: user.id });
    }
    const left = await listDevices(db, user.id);
    expect(left.map((d) => [d.id, d.platform, d.installId]).sort()).toEqual(
      [
        [mac.device.id, "macos", mac.device.installId],
        [other.device.id, "ios", other.device.installId],
      ].sort(),
    );
  });

  test("a person keeps at most twenty, Macs and iPhones alike", async () => {
    const user = await seedUser(db, "many");
    for (let n = 0; n < MAX_DEVICES_PER_USER + 1; n++) {
      if (n % 2) await registered(phone(user.id));
      else
        await registered({
          userId: user.id,
          platform: "macos",
          installId: install(),
          name: null,
          appVersion: null,
        });
    }
    expect(await listDevices(db, user.id)).toHaveLength(MAX_DEVICES_PER_USER);
  });

  test("a heartbeat marks the person at a device, at most every 30 seconds", async () => {
    const user = await seedUser(db, "beat");
    const other = await seedUser(db, "beat-other");
    const { device } = await registered(phone(user.id));
    expect(await touchDeviceActive(db, { userId: user.id, id: device.id, now: start })).toBe(
      "touched",
    );
    expect(
      await touchDeviceActive(db, { userId: user.id, id: device.id, now: after(29 * SECOND) }),
    ).toBe("fresh");
    expect(
      await touchDeviceActive(db, { userId: user.id, id: device.id, now: after(30 * SECOND) }),
    ).toBe("touched");
    const [row] = await listDevices(db, user.id);
    expect(row!.activeAt).toEqual(after(30 * SECOND));
    expect(row!.lastSeenAt).toEqual(after(30 * SECOND));
    expect(await touchDeviceActive(db, { userId: other.id, id: device.id, now: start })).toBe(
      "missing",
    );
  });

  test("the sweep forgets an iPhone unseen 90 days and a Mac unseen 30", async () => {
    const user = await seedUser(db, "pruned");
    const old = await registered(phone(user.id));
    const kept = await registered(phone(user.id));
    const mac = await registered({
      userId: user.id,
      platform: "macos",
      installId: install(),
      name: null,
      appVersion: null,
    });
    const seen = (id: string, at: Date) =>
      run(db.update(devices).set({ lastSeenAt: at }).where(eq(devices.id, id)));
    await seen(old.device.id, after(-91 * DAY));
    await seen(kept.device.id, after(-89 * DAY));
    await seen(mac.device.id, after(-31 * DAY));
    await pruneDevices(db, {
      iosUnseenBefore: after(-90 * DAY),
      macUnseenBefore: after(-30 * DAY),
    });
    expect((await listDevices(db, user.id)).map((d) => d.id)).toEqual([kept.device.id]);
    expect(await forgetDevices(db, [kept.device.id])).toBe(1);
    expect(await listDevices(db, user.id)).toEqual([]);
  });

  test("a dead token forgets its phone only while the phone still holds it", async () => {
    const user = await seedUser(db, "dead-token");
    const dead = await registered(phone(user.id));
    const rotated = await registered(phone(user.id));
    const oldToken = rotated.device.pushToken!;
    await updateDevice(db, {
      userId: user.id,
      id: rotated.device.id,
      changes: { pushToken: token() },
    });
    expect(
      await forgetDeadTokens(db, [
        { id: dead.device.id, pushToken: dead.device.pushToken! },
        { id: rotated.device.id, pushToken: oldToken },
      ]),
    ).toBe(1);
    expect((await listDevices(db, user.id)).map((d) => d.id)).toEqual([rotated.device.id]);
  });

  test("a receipt's dead token forgets a phone only if it was not seen after the send", async () => {
    const user = await seedUser(db, "dead-receipt");
    const idle = await registered(phone(user.id));
    const back = await registered(phone(user.id));
    const seen = (id: string, at: Date) =>
      run(db.update(devices).set({ lastSeenAt: at }).where(eq(devices.id, id)));
    await seen(idle.device.id, start);
    await seen(back.device.id, after(MINUTE));
    expect(
      await forgetDevicesUnseenSince(db, [
        { id: idle.device.id, sentAt: start },
        { id: back.device.id, sentAt: start },
      ]),
    ).toBe(1);
    expect((await listDevices(db, user.id)).map((d) => d.id)).toEqual([back.device.id]);
  });
});

describe("notifications", () => {
  test("one per person and dedupe key, even written at the same moment", async () => {
    const { canvas, user } = await seedCanvas(db);
    const row = needsYou(user.id, canvas.id, "q_race");
    const [a, b] = await Promise.all([
      insertNotifications(db, { rows: [row], now: start }),
      insertNotifications(db, { rows: [row], now: start }),
    ]);
    expect(a.length + b.length).toBe(1);
    expect(await insertNotifications(db, { rows: [row], now: after(MINUTE) })).toEqual([]);
    const teammate = await seedUser(db, "teammate-dedupe");
    const theirs = await insertNotifications(db, {
      rows: [needsYou(teammate.id, canvas.id, "q_race")],
      now: start,
    });
    expect(theirs).toHaveLength(1);
    expect(theirs[0]).toMatchObject({
      kind: "needs_you",
      count: 1,
      people: [],
      createdAt: start,
      readAt: null,
      resolvedAt: null,
    });
    expect(theirs[0]!.id).toMatch(/^ntf_/);
  });

  test("one made while the person looks is read as it is made", async () => {
    const { canvas, user } = await seedCanvas(db);
    const [row] = await insertNotifications(db, {
      rows: [needsYou(user.id, canvas.id, "q_look", { readVia: "looking" })],
      now: start,
    });
    expect(row).toMatchObject({ readAt: start, readVia: "looking" });
  });

  test("the database refuses what a ping must never hold", async () => {
    const { canvas, user } = await seedCanvas(db);
    const bad = (extra: Partial<NewNotification>) =>
      insertNotifications(db, { rows: [needsYou(user.id, canvas.id, "q_bad", extra)], now: start });
    await expect(bad({ title: "x".repeat(201) })).rejects.toThrow("notifications_text_check");
    await expect(bad({ link: { open: "inbox" } as never })).rejects.toThrow(
      "notifications_link_check",
    );
    await expect(bad({ link: { open: "thread", questionId: "q".repeat(1100) } })).rejects.toThrow(
      "notifications_link_check",
    );
    await expect(bad({ kind: "mention" as never })).rejects.toThrow("notifications_kind_check");
  });

  test("a teammate's comments fold into one unread row for ten minutes", async () => {
    const { canvas, user } = await seedCanvas(db);
    const bodyFor = (people: readonly string[], count: number) =>
      `${people.join(" and ")} left ${count} comments.`;
    const fold = (messageId: string, person: string, now: Date) =>
      collapseCommentNotification(db, {
        userId: user.id,
        canvasId: canvas.id,
        dedupeKey: `comment:${canvas.id}:${messageId}`,
        person,
        since: new Date(now.getTime() - 10 * MINUTE),
        now,
        bodyFor,
      });
    expect(await fold("m1", "Maya", start)).toBeNull();
    const [first] = await insertNotifications(db, {
      rows: [
        {
          userId: user.id,
          workspaceId: null,
          canvasId: canvas.id,
          kind: "teammate_comment",
          dedupeKey: `comment:${canvas.id}:m1`,
          title: "Lisbon",
          body: "Maya commented.",
          link: { open: "comment", commentThreadId: "m1" },
          sourceId: "m1",
          people: ["Maya"],
          muted: false,
        },
      ],
      now: start,
    });
    const second = await fold("m2", "Maya", after(MINUTE));
    expect(second).toMatchObject({
      status: "collapsed",
      notification: { id: first!.id, count: 2, people: ["Maya"], body: "Maya left 2 comments." },
    });
    const third = await fold("m3", "Sam", after(2 * MINUTE));
    expect(third?.notification).toMatchObject({
      count: 3,
      people: ["Maya", "Sam"],
      body: "Maya and Sam left 3 comments.",
      updatedAt: after(2 * MINUTE),
    });
    // The same comment twice folds in once, whether it made the row or joined it.
    expect(await fold("m2", "Maya", after(3 * MINUTE))).toMatchObject({ status: "already" });
    expect(await fold("m1", "Maya", after(3 * MINUTE))).toMatchObject({ status: "already" });
    // Past ten minutes, or once read, a comment makes its own row.
    expect(await fold("m4", "Sam", after(11 * MINUTE))).toBeNull();
    await markNotificationsRead(db, {
      userId: user.id,
      ids: [first!.id],
      now: after(MINUTE),
      via: "mac",
    });
    expect(await fold("m5", "Sam", after(5 * MINUTE))).toBeNull();
  });

  test("read by id, by canvas, or all, only up to now, and safe to read again", async () => {
    const { canvas, user } = await seedCanvas(db);
    const other = await seedCanvas(db);
    const rows = await insertNotifications(db, {
      rows: [
        needsYou(user.id, canvas.id, "q_r1"),
        needsYou(user.id, canvas.id, "q_r2"),
        needsYou(user.id, other.canvas.id, "q_r3"),
      ],
      now: start,
    });
    const [later] = await insertNotifications(db, {
      rows: [needsYou(user.id, canvas.id, "q_r4")],
      now: after(MINUTE),
    });
    expect(
      await markNotificationsRead(db, {
        userId: user.id,
        ids: [rows[0]!.id],
        now: start,
        via: "ios",
      }),
    ).toEqual([rows[0]!.id]);
    expect(
      await markNotificationsRead(db, {
        userId: user.id,
        ids: [rows[0]!.id],
        now: start,
        via: "mac",
      }),
    ).toEqual([]);
    // Opening the canvas reads what it had by then, not what came a moment later.
    expect(
      await markNotificationsRead(db, {
        userId: user.id,
        canvasId: canvas.id,
        now: start,
        via: "seen",
      }),
    ).toEqual([rows[1]!.id]);
    const [row] = await run(
      db.select().from(notifications).where(eq(notifications.id, rows[1]!.id)),
    );
    expect(row).toMatchObject({ readAt: start, readVia: "seen" });
    // Someone else's ids read nothing.
    const stranger = await seedUser(db, "stranger-read");
    expect(
      await markNotificationsRead(db, {
        userId: stranger.id,
        ids: [later!.id],
        now: after(MINUTE),
        via: "mac",
      }),
    ).toEqual([]);
    expect(
      (await markNotificationsRead(db, { userId: user.id, now: after(MINUTE), via: "mac" })).sort(),
    ).toEqual([rows[2]!.id, later!.id].sort());
  });

  test("the badge counts open questions, and goes down as they close", async () => {
    const { canvas, user } = await seedCanvas(db);
    const teammate = await seedUser(db, "teammate-badge");
    const one = await createQuestion(db, { canvasId: canvas.id, kind: "question", payload: {} });
    const two = await createQuestion(db, { canvasId: canvas.id, kind: "plan", payload: {} });
    await insertNotifications(db, {
      rows: [
        needsYou(user.id, canvas.id, one.id),
        // Muted and read still count: the badge is waiting work.
        needsYou(user.id, canvas.id, two.id, { muted: true, readVia: "looking" }),
        needsYou(teammate.id, canvas.id, one.id),
        { ...needsYou(user.id, canvas.id, "q_other"), kind: "reply", dedupeKey: "reply:x" },
      ],
      now: start,
    });
    expect(await badgeCount(db, user.id)).toBe(2);
    expect(
      (
        await resolveNeedsYou(db, { canvasId: canvas.id, questionIds: [one.id], now: start })
      ).sort(),
    ).toEqual([user.id, teammate.id].sort());
    expect(
      await resolveNeedsYou(db, { canvasId: canvas.id, questionIds: [one.id], now: start }),
    ).toEqual([]);
    expect(await badgeCount(db, user.id)).toBe(1);
    expect(await badgeCount(db, teammate.id)).toBe(0);

    // The sweep finds a question closed without a resolve.
    await cancelQuestions(db, { canvasId: canvas.id, ids: [two.id] });
    expect(await resolveClosedQuestions(db, { now: start })).toContain(user.id);
    expect(await badgeCount(db, user.id)).toBe(0);
  });

  test("the sweep resolves only questions that are no longer open", async () => {
    const { canvas, user } = await seedCanvas(db);
    const open = await createQuestion(db, { canvasId: canvas.id, kind: "question", payload: {} });
    const answered = await createQuestion(db, {
      canvasId: canvas.id,
      kind: "question",
      payload: {},
    });
    await answerQuestion(db, {
      canvasId: canvas.id,
      id: answered.id,
      answer: { text: "yes" },
      userId: user.id,
    });
    await insertNotifications(db, {
      rows: [
        needsYou(user.id, canvas.id, open.id),
        needsYou(user.id, canvas.id, answered.id),
        // A question that is gone altogether.
        needsYou(user.id, canvas.id, "q_vanished"),
      ],
      now: start,
    });
    await resolveClosedQuestions(db, { now: start });
    const rows = await run(
      db
        .select({ sourceId: notifications.sourceId, resolvedAt: notifications.resolvedAt })
        .from(notifications)
        .where(eq(notifications.userId, user.id)),
    );
    expect(
      Object.fromEntries(
        (rows as { sourceId: string; resolvedAt: Date | null }[]).map((r) => [
          r.sourceId,
          r.resolvedAt,
        ]),
      ),
    ).toEqual({
      [open.id]: null,
      [answered.id]: start,
      q_vanished: start,
    });
  });

  test("the daily email reads the last day's unread and muted rows, by canvas", async () => {
    const { canvas, user } = await seedCanvas(db);
    const other = await seedCanvas(db);
    const [old, unread, muted, read, elsewhere] = await insertNotifications(db, {
      rows: [
        needsYou(user.id, canvas.id, "q_d0"),
        needsYou(user.id, other.canvas.id, "q_d1"),
        needsYou(user.id, canvas.id, "q_d2", { muted: true, readVia: "looking" }),
        needsYou(user.id, canvas.id, "q_d3", { readVia: "looking" }),
        needsYou(user.id, canvas.id, "q_d4"),
      ],
      now: start,
    });
    await run(
      db
        .update(notifications)
        .set({ createdAt: after(-25 * 60 * MINUTE) })
        .where(eq(notifications.id, old!.id)),
    );
    const listed = await listRecentForDigest(db, { userId: user.id, since: after(-DAY) });
    const ids = listed.map((n) => n.id);
    expect(ids).not.toContain(old!.id);
    expect(ids).not.toContain(read!.id);
    expect(new Set(ids)).toEqual(new Set([unread!.id, muted!.id, elsewhere!.id]));
    // Grouped: each canvas's rows together.
    const canvases = listed.map((n) => n.canvasId);
    const runs = canvases.filter((id, i) => id !== canvases[i - 1]);
    expect(runs).toHaveLength(new Set(canvases).size);
  });

  test("the sweep expires unread rows after three days and deletes them after thirty", async () => {
    const { canvas, user } = await seedCanvas(db);
    const q = await createQuestion(db, { canvasId: canvas.id, kind: "question", payload: {} });
    const rows = await insertNotifications(db, {
      rows: [
        needsYou(user.id, canvas.id, "q_p1"),
        needsYou(user.id, canvas.id, "q_p2"),
        needsYou(user.id, canvas.id, q.id),
        needsYou(user.id, canvas.id, "q_p4"),
      ],
      now: start,
    });
    const made = (id: string, ms: number) =>
      run(
        db
          .update(notifications)
          .set({ createdAt: after(ms) })
          .where(eq(notifications.id, id)),
      );
    await made(rows[0]!.id, -4 * DAY); // expires
    await made(rows[1]!.id, -31 * DAY); // deleted, its question long closed
    await resolveNeedsYou(db, { canvasId: canvas.id, questionIds: ["q_p2"], now: start });
    await made(rows[2]!.id, -31 * DAY); // an open question: kept
    const pruned = await pruneNotifications(db, {
      now: start,
      expireBefore: after(-3 * DAY),
      deleteBefore: after(-30 * DAY),
    });
    expect(pruned.deleted).toBe(1);
    const left = await run(
      db
        .select({ id: notifications.id, readVia: notifications.readVia })
        .from(notifications)
        .where(eq(notifications.userId, user.id)),
    );
    const byId = Object.fromEntries(
      (left as { id: string; readVia: string | null }[]).map((r) => [r.id, r.readVia]),
    );
    expect(byId).toEqual({
      [rows[0]!.id]: "expired",
      [rows[2]!.id]: "expired",
      [rows[3]!.id]: null,
    });
  });

  test("deleting a person takes their devices and notifications", async () => {
    const { canvas, user } = await seedCanvas(db);
    const leaving = await seedUser(db, "leaving");
    const { device } = await registered(phone(leaving.id));
    const [row] = await insertNotifications(db, {
      rows: [needsYou(leaving.id, canvas.id, "q_leave")],
      now: start,
    });
    await insertDeliveries(db, {
      rows: [{ notificationId: row!.id, deviceId: device.id, sendAt: start }],
      now: start,
    });
    expect(await deleteUser(db, leaving.id)).toMatchObject({ status: "deleted" });
    const where = await run(
      db
        .select({ id: notifications.id })
        .from(notifications)
        .where(eq(notifications.userId, leaving.id)),
    );
    expect(where).toEqual([]);
    expect(await listDevices(db, leaving.id)).toEqual([]);
    const deliveries = await run(
      db
        .select({ id: notificationDeliveries.id })
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.notificationId, row!.id)),
    );
    expect(deliveries).toEqual([]);
    // Others' rows about the same canvas stay.
    expect(await badgeCount(db, user.id)).toBe(0);
  });
});

describe("deliveries", () => {
  async function planned(sendAts: Date[]) {
    const { canvas, user } = await seedCanvas(db);
    const phones = await Promise.all(sendAts.map(() => registered(phone(user.id))));
    const [notification] = await insertNotifications(db, {
      rows: [needsYou(user.id, canvas.id, `q_${serial++}`)],
      now: start,
    });
    const rows = await insertDeliveries(db, {
      rows: phones.map(({ device }, i) => ({
        notificationId: notification!.id,
        deviceId: device.id,
        sendAt: sendAts[i]!,
      })),
      now: start,
    });
    return { user, notification: notification!, phones, rows };
  }

  test("one per notification and iPhone", async () => {
    const { notification, phones, rows } = await planned([start]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "waiting", attempts: 0, sendAt: start });
    expect(rows[0]!.id).toMatch(/^ndl_/);
    expect(
      await insertDeliveries(db, {
        rows: [{ notificationId: notification.id, deviceId: phones[0]!.device.id, sendAt: start }],
        now: start,
      }),
    ).toEqual([]);
  });

  test("a push planned again waits again once settled, and is left alone while it goes", async () => {
    const { notification, phones, rows } = await planned([start, start, start]);
    const [sent, waiting, sending] = rows.map((r) => r.id) as [string, string, string];
    await markDeliveries(db, [
      { id: sent, state: "sending", sentAt: start },
      { id: sending, state: "sending", sentAt: start },
    ]);
    await markDeliveries(db, [{ id: sent, state: "sent", sentAt: start, ticketId: "tk_1" }]);
    const extra = await registered(phone(phones[0]!.device.userId));
    const again = after(MINUTE);

    const waits = await repushDeliveries(db, {
      rows: [...phones.map(({ device }) => device), extra.device].map((device) => ({
        notificationId: notification.id,
        deviceId: device.id,
        sendAt: again,
      })),
      now: again,
    });

    const all = (await run(db.select().from(notificationDeliveries))).filter(
      (row) => row.notificationId === notification.id,
    );
    const byId = new Map(all.map((row) => [row.id, row]));
    // The sent one waits again with its earlier send forgotten; the one waiting keeps its time,
    // the one going is left to go; a phone added since gets its own.
    expect(byId.get(sent)).toMatchObject({
      state: "waiting",
      sendAt: again,
      sentAt: null,
      ticketId: null,
      outcome: null,
    });
    expect(byId.get(waiting)).toMatchObject({ state: "waiting", sendAt: start });
    expect(byId.get(sending)).toMatchObject({ state: "sending" });
    const added = all.find((row) => row.deviceId === extra.device.id)!;
    expect(added).toMatchObject({ state: "waiting", sendAt: again });
    expect(waits.sort()).toEqual([sent, added.id].sort());
    // The database is shared by the tests below: settle the one left going.
    await markDeliveries(db, [{ id: sending, state: "failed", outcome: "test" }]);
  });

  test("when each person was last told a kind about a canvas, one key aside", async () => {
    const { canvas, user } = await seedCanvas(db);
    const other = await seedUser(db);
    const ready = (userId: string, sha: string, now: Date) =>
      insertNotifications(db, {
        rows: [
          {
            userId,
            workspaceId: null,
            canvasId: canvas.id,
            kind: "pr_ready",
            dedupeKey: `pr_ready:${canvas.id}:1:${sha}`,
            title: "Lisbon",
            body: "Pull request #1 is ready to merge.",
            link: { open: "pull-request" },
            muted: false,
          },
        ],
        now,
      });
    await ready(user.id, "a", start);
    await ready(user.id, "b", after(MINUTE));
    const last = await lastNotifiedAt(db, {
      canvasId: canvas.id,
      kind: "pr_ready",
      userIds: [user.id, other.id],
    });
    expect([...last]).toEqual([[user.id, after(MINUTE)]]);
    const without = await lastNotifiedAt(db, {
      canvasId: canvas.id,
      kind: "pr_ready",
      userIds: [user.id],
      exceptDedupeKey: `pr_ready:${canvas.id}:1:b`,
    });
    expect(without.get(user.id)).toEqual(start);
    expect(
      await lastNotifiedAt(db, { canvasId: canvas.id, kind: "pr_approved", userIds: [user.id] }),
    ).toEqual(new Map());
  });

  test("due ones come with their device, and the next one says when", async () => {
    const { phones, notification, rows } = await planned([start, after(2 * MINUTE)]);
    const due = await dueDeliveries(db, { notificationId: notification.id, now: start });
    expect(due).toEqual({
      due: [
        {
          id: rows[0]!.id,
          sendAt: start,
          attempts: 0,
          device: {
            id: phones[0]!.device.id,
            userId: phones[0]!.device.userId,
            platform: "ios",
            pushToken: phones[0]!.device.pushToken,
            pingsEnabled: true,
            pingsBlocked: false,
            lastSeenAt: phones[0]!.device.lastSeenAt,
            activeAt: null,
          },
        },
      ],
      nextSendAt: after(2 * MINUTE),
    });
    // A forgotten iPhone leaves the delivery with no device.
    await forgetDevices(db, [phones[0]!.device.id]);
    const later = await dueDeliveries(db, {
      notificationId: notification.id,
      now: after(2 * MINUTE),
    });
    expect(later.due.map((d) => d.device === null)).toEqual([true, false]);
    expect(later.nextSendAt).toBeNull();
  });

  test("move only forward: one handed to Expo is never handed again", async () => {
    const { notification, rows } = await planned([start, start, start]);
    const [a, b, c] = rows.map((r) => r.id) as [string, string, string];
    expect(
      await markDeliveries(db, [
        { id: a, state: "sending", sentAt: start },
        { id: b, state: "sending", sentAt: start },
        { id: c, state: "cancelled", outcome: "read" },
      ]),
    ).toEqual(expect.arrayContaining([a, b, c]));
    // A retry that would send them again moves nothing, and nothing is due.
    expect(await markDeliveries(db, [{ id: a, state: "sending", sentAt: after(SECOND) }])).toEqual(
      [],
    );
    expect(
      (await dueDeliveries(db, { notificationId: notification.id, now: after(MINUTE) })).due,
    ).toEqual([]);
    expect(
      await markDeliveries(db, [{ id: a, state: "sent", sentAt: start, ticketId: "ticket-a" }]),
    ).toEqual([a]);
    // Settled never moves again; a cancelled one is not sent.
    expect(
      await markDeliveries(db, [{ id: c, state: "sent", sentAt: start, ticketId: "t" }]),
    ).toEqual([]);
    expect(await markDeliveries(db, [{ id: a, state: "cancelled", outcome: "read" }])).toEqual([]);

    const [row] = await run(
      db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, a)),
    );
    expect(row).toMatchObject({ state: "sent", attempts: 1, ticketId: "ticket-a", sentAt: start });

    // `b`'s answer was lost: the sweep settles it as unknown, never sending it twice.
    expect(await settleLostSends(db, { before: after(-MINUTE), now: start })).toBe(0);
    expect(await settleLostSends(db, { before: after(10 * MINUTE), now: after(10 * MINUTE) })).toBe(
      1,
    );
    const [lost] = await run(
      db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, b)),
    );
    expect(lost).toMatchObject({ state: "unknown", outcome: "no_answer" });
  });

  test("a phone that moved to another person since is not sent to", async () => {
    const { notification, phones } = await planned([start]);
    const ines = await seedUser(db, `ines-took-${serial++}`);
    // The phone signed in as Ines: the same install registers the same token for her.
    const { device } = phones[0]!;
    const moved = await registered({
      ...phone(ines.id),
      pushToken: device.pushToken!,
      installId: device.installId!,
    });
    expect(moved).toMatchObject({ device: { id: device.id, userId: ines.id } });
    const { due } = await dueDeliveries(db, { notificationId: notification.id, now: start });
    expect(due.map((d) => d.device)).toEqual([null]);
  });

  test("one Expo plainly did not take waits again, out of the hourly count", async () => {
    const { notification, rows, user } = await planned([start]);
    const id = rows[0]!.id;
    expect(await markDeliveries(db, [{ id, state: "sending", sentAt: start }])).toEqual([id]);
    expect(await recentPushes(db, { userIds: [user.id], since: after(-1) })).toHaveLength(1);
    // A 429: back to wait for 30 seconds.
    expect(
      await markDeliveries(db, [{ id, state: "waiting", sendAt: after(30 * SECOND) }]),
    ).toEqual([id]);
    expect(await recentPushes(db, { userIds: [user.id], since: after(-1) })).toEqual([]);
    expect(await dueDeliveries(db, { notificationId: notification.id, now: start })).toEqual({
      due: [],
      nextSendAt: after(30 * SECOND),
    });
    const later = await dueDeliveries(db, {
      notificationId: notification.id,
      now: after(30 * SECOND),
    });
    expect(later.due).toEqual([expect.objectContaining({ id, attempts: 1 })]);
    // Only from sending: one waiting, sent or settled does not move back.
    expect(await markDeliveries(db, [{ id, state: "waiting", sendAt: start }])).toEqual([]);
    await markDeliveries(db, [{ id, state: "sent", sentAt: after(30 * SECOND), ticketId: "t-1" }]);
    expect(await markDeliveries(db, [{ id, state: "waiting", sendAt: start }])).toEqual([]);
  });

  test("receipts are read from 15 minutes on, oldest first, and settle once", async () => {
    const { rows, user } = await planned([start, start]);
    const [a, b] = rows.map((r) => r.id) as [string, string];
    await markDeliveries(db, [
      { id: a, state: "sent", sentAt: start, ticketId: "ticket-1" },
      { id: b, state: "sent", sentAt: after(MINUTE), ticketId: "ticket-2" },
    ]);
    const mine = async (before: Date) =>
      (await receiptsDue(db, { before })).filter((r) => r.id === a || r.id === b);
    expect(await mine(after(-SECOND))).toEqual([]);
    expect(await mine(start)).toEqual([
      expect.objectContaining({ id: a, ticketId: "ticket-1", sentAt: start, kind: "needs_you" }),
    ]);
    expect((await mine(after(MINUTE))).map((r) => r.id)).toEqual([a, b]);
    expect(
      await markDeliveries(db, [
        { id: a, state: "delivered", receiptCheckedAt: after(15 * MINUTE) },
        {
          id: b,
          state: "failed",
          outcome: "DeviceNotRegistered",
          receiptCheckedAt: after(15 * MINUTE),
        },
      ]),
    ).toEqual(expect.arrayContaining([a, b]));
    expect(await mine(after(DAY))).toEqual([]);
    // They counted towards the hourly limit when they went.
    const pushes = await recentPushes(db, { userIds: [user.id], since: after(-1) });
    expect(pushes).toEqual([
      { userId: user.id, kind: "needs_you", at: start },
      { userId: user.id, kind: "needs_you", at: after(MINUTE) },
    ]);
    expect(await recentPushes(db, { userIds: [user.id], since: start })).toHaveLength(1);
  });

  test("a sent delivery needs its ticket, by the database's own check", async () => {
    const { rows } = await planned([start]);
    await expect(
      run(
        db
          .update(notificationDeliveries)
          .set({ state: "sent" })
          .where(eq(notificationDeliveries.id, rows[0]!.id)),
      ),
    ).rejects.toThrow("notification_deliveries_sent_check");
  });
});

describe("focused presence", () => {
  test("is set, kept, cleared, and gone with the row", async () => {
    const { canvas, user } = await seedCanvas(db);
    const teammate = await seedUser(db, "focus-teammate");
    const userIds = [user.id, teammate.id];
    await touchPresence(db, { canvasId: canvas.id, userId: user.id, focused: true, now: start });
    await touchPresence(db, { canvasId: canvas.id, userId: teammate.id, now: start });
    expect(await focusedPresence(db, { canvasId: canvas.id, userIds, now: start })).toEqual(
      new Map([[user.id, start]]),
    );
    // A beat that says nothing of focus keeps it as it was.
    await touchPresence(db, { canvasId: canvas.id, userId: user.id, now: after(30 * SECOND) });
    expect(
      await focusedPresence(db, { canvasId: canvas.id, userIds, now: after(30 * SECOND) }),
    ).toEqual(new Map([[user.id, start]]));
    await touchPresence(db, {
      canvasId: canvas.id,
      userId: user.id,
      focused: false,
      now: after(31 * SECOND),
    });
    expect(
      await focusedPresence(db, { canvasId: canvas.id, userIds, now: after(31 * SECOND) }),
    ).toEqual(new Map());
    await touchPresence(db, {
      canvasId: canvas.id,
      userId: teammate.id,
      focused: true,
      now: after(40 * SECOND),
    });
    // A row past the presence TTL is nobody looking.
    expect(
      await focusedPresence(db, { canvasId: canvas.id, userIds, now: after(116 * SECOND) }),
    ).toEqual(new Map());
  });
});

describe("time zone", () => {
  test("keeps the zone a person's app reports, and only theirs", async () => {
    const [maya, sam] = [await seedUser(db, "zoned"), await seedUser(db, "unzoned")];
    const zoneOf = async (id: string) =>
      (await run(db.select({ zone: users.timeZone }).from(users).where(eq(users.id, id))))[0]!.zone;

    expect(await zoneOf(maya.id)).toBeNull();
    expect(await setTimeZone(db, { userId: maya.id, timeZone: "Europe/Lisbon" })).toBe(
      "Europe/Lisbon",
    );
    expect(await setTimeZone(db, { userId: maya.id, timeZone: "America/Chicago" })).toBe(
      "America/Chicago",
    );
    expect(await zoneOf(maya.id)).toBe("America/Chicago");
    expect(await zoneOf(sam.id)).toBeNull();
    await expect(setTimeZone(db, { userId: "usr_gone", timeZone: "UTC" })).rejects.toThrow(
      "There is no user usr_gone.",
    );
  });
});
