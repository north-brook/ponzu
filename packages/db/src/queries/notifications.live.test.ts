// The notification statements on a real Postgres, through every driver that reaches one: the
// dedupe race, which PGlite runs in turns, and each statement once, since they build their
// answers in json. Runs only when PONZU_TEST_DATABASE_URL is set (see ../live.ts).
import { afterAll, expect, test } from "bun:test";
import { seedCanvas, seedUser } from "../fixtures.ts";
import { describeLive } from "../live.ts";
import {
  badgeCount,
  collapseCommentNotification,
  dueDeliveries,
  insertDeliveries,
  insertNotifications,
  markDeliveries,
  markNotificationsRead,
  type NewNotification,
  pruneNotifications,
  receiptsDue,
  registerDevice,
  resolveClosedQuestions,
  resolveNeedsYou,
  touchDeviceActive,
} from "./notifications.ts";
import { focusedPresence, touchPresence } from "./presence.ts";

describeLive("notifications on a real Postgres", ({ db, close }) => {
  afterAll(close);

  const now = new Date();
  const stamp = Date.now().toString(36);

  const row = (userId: string, canvasId: string, key: string): NewNotification => ({
    userId,
    workspaceId: null,
    canvasId,
    kind: "needs_you",
    dedupeKey: key,
    title: "Lisbon",
    body: "Ponzu has a question for you.",
    link: { open: "thread", questionId: "q_live" },
    sourceId: "q_live",
    muted: false,
  });

  test("two writes of one notification at once make one row", async () => {
    const { canvas, user } = await seedCanvas(db);
    const key = `needs_you:${canvas.id}:race-${stamp}`;
    const written = await Promise.all(
      Array.from({ length: 8 }, () =>
        insertNotifications(db, { rows: [row(user.id, canvas.id, key)], now }),
      ),
    );
    expect(written.flat()).toHaveLength(1);
  });

  test("two registrations of one phone at once make one device", async () => {
    const user = await seedUser(db, `racing-${stamp}`);
    const phone = {
      userId: user.id,
      platform: "ios" as const,
      pushToken: `ExponentPushToken[race-${stamp}]`,
      pushEnvironment: "production" as const,
      installId: `install-race-${stamp}`,
      name: null,
      appVersion: null,
      pingsBlocked: false,
    };
    const answers = await Promise.all(Array.from({ length: 4 }, () => registerDevice(db, phone)));
    const ids = new Set(answers.map((a) => (a.status === "registered" ? a.device.id : null)));
    expect([...ids]).toHaveLength(1);
    expect(ids.has(null)).toBe(false);
  });

  test("each statement once", async () => {
    const { canvas, user } = await seedCanvas(db);
    const mac = await registerDevice(db, {
      userId: user.id,
      platform: "macos",
      installId: `mac-${stamp}`,
      name: "Studio",
      appVersion: null,
    });
    if (mac.status !== "registered") throw new Error("not registered");
    expect(await touchDeviceActive(db, { userId: user.id, id: mac.device.id, now })).toBe(
      "touched",
    );
    const phone = await registerDevice(db, {
      userId: user.id,
      platform: "ios",
      pushToken: `ExponentPushToken[once-${stamp}]`,
      pushEnvironment: "production",
      installId: `phone-${stamp}`,
      name: null,
      appVersion: null,
      pingsBlocked: false,
    });
    if (phone.status !== "registered") throw new Error("not registered");

    const [notification] = await insertNotifications(db, {
      rows: [
        {
          ...row(user.id, canvas.id, `comment:${canvas.id}:m1`),
          kind: "teammate_comment",
          link: { open: "comment" },
        },
      ],
      now,
    });
    expect(
      await collapseCommentNotification(db, {
        userId: user.id,
        canvasId: canvas.id,
        dedupeKey: `comment:${canvas.id}:m2`,
        person: "Maya",
        since: new Date(now.getTime() - 600_000),
        now,
        bodyFor: (_people, count) => `Maya left ${count} comments.`,
      }),
    ).toMatchObject({ status: "collapsed", notification: { count: 2 } });

    const [delivery] = await insertDeliveries(db, {
      rows: [{ notificationId: notification!.id, deviceId: phone.device.id, sendAt: now }],
      now,
    });
    const due = await dueDeliveries(db, { notificationId: notification!.id, now });
    expect(due.due.map((d) => d.id)).toEqual([delivery!.id]);
    expect(await markDeliveries(db, [{ id: delivery!.id, state: "sending", sentAt: now }])).toEqual(
      [delivery!.id],
    );
    expect(
      await markDeliveries(db, [{ id: delivery!.id, state: "sent", sentAt: now, ticketId: "t1" }]),
    ).toEqual([delivery!.id]);
    expect((await receiptsDue(db, { before: now })).some((r) => r.id === delivery!.id)).toBe(true);

    await insertNotifications(db, { rows: [row(user.id, canvas.id, `needs:${stamp}`)], now });
    expect(await badgeCount(db, user.id)).toBe(1);
    expect(
      await resolveNeedsYou(db, { canvasId: canvas.id, questionIds: ["q_live"], now }),
    ).toEqual([user.id]);
    await resolveClosedQuestions(db, { now, limit: 10 });
    expect(
      await markNotificationsRead(db, { userId: user.id, canvasId: canvas.id, now, via: "seen" }),
    ).toHaveLength(2);
    expect(
      await pruneNotifications(db, { now, expireBefore: new Date(0), deleteBefore: new Date(0) }),
    ).toEqual({ expired: 0, deleted: 0 });

    await touchPresence(db, { canvasId: canvas.id, userId: user.id, focused: true, now });
    expect(await focusedPresence(db, { canvasId: canvas.id, userIds: [user.id], now })).toEqual(
      new Map([[user.id, now]]),
    );
  });
});
