import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  devices,
  insertNotifications,
  listDevices,
  MAX_DEVICES_PER_USER,
  markNotificationsRead,
  type NewNotification,
  notifications,
} from "@ponzu/db";
import { call } from "../testing/canvases.ts";
import { createTestApp, type SignedInPerson, type TestApp } from "../testing/index.ts";

let t: TestApp;
let maya: SignedInPerson;
let ines: SignedInPerson;

beforeAll(async () => {
  t = await createTestApp();
  maya = await t.signInAs({ login: "maya" });
  ines = await t.signInAs({ login: "ines" });
});
afterAll(() => t.close());

/** An Expo push token, as the phone gets one from `getExpoPushTokenAsync`. */
const token = (n: number) => `ExponentPushToken[${n.toString().padStart(22, "x")}]`;
/** The install of the app a phone runs: one per token unless a test says otherwise. */
const install = (n: number) => `install-${n.toString().padStart(12, "0")}`;
const phone = (n: number, extra: Record<string, unknown> = {}) => ({
  platform: "ios",
  pushToken: token(n),
  pushEnvironment: "production",
  installId: install(n),
  name: "iPhone 16 Pro",
  appVersion: "0.13.0",
  ...extra,
});

describe("ping preferences", () => {
  test("start as the Notifications board draws them", async () => {
    const got = await call(t, maya.headers, "GET", "/v1/me/notifications");
    expect(got.status).toBe(200);
    expect(got.body).toEqual({
      prefs: {
        needsYou: true,
        replies: true,
        prReady: true,
        teammateComments: false,
        emailDigest: false,
      },
      devices: [],
      badge: 0,
      // No mailer in this deployment: the Email row is not shown.
      email: { address: "maya@example.com", available: false },
      timeZone: null,
    });
  });

  test("change one at a time, and stay changed for every device", async () => {
    const patched = await call(t, maya.headers, "PATCH", "/v1/me/notifications", {
      teammateComments: true,
    });
    expect(patched.status).toBe(200);
    expect(patched.body.prefs.teammateComments).toBe(true);
    expect(patched.body.prefs.needsYou).toBe(true);

    const again = await call(t, maya.headers, "PATCH", "/v1/me/notifications", {
      needsYou: false,
      emailDigest: true,
    });
    expect(again.body.prefs).toEqual({
      needsYou: false,
      replies: true,
      prReady: true,
      teammateComments: true,
      emailDigest: true,
    });
    const read = await call(t, maya.headers, "GET", "/v1/me/notifications");
    expect(read.body.prefs).toEqual(again.body.prefs);
    // Nobody else's change.
    const theirs = await call(t, ines.headers, "GET", "/v1/me/notifications");
    expect(theirs.body.prefs.needsYou).toBe(true);
  });

  test("keep the time zone the app reports, without touching a toggle", async () => {
    const sam = await t.signInAs({ login: "sam" });
    const zone = (timeZone: unknown) =>
      call(t, sam.headers, "PATCH", "/v1/me/notifications", { timeZone });

    const lisbon = await zone("Europe/Lisbon");
    expect(lisbon.status).toBe(200);
    expect(lisbon.body.timeZone).toBe("Europe/Lisbon");
    expect(lisbon.body.prefs).toEqual({
      needsYou: true,
      replies: true,
      prReady: true,
      teammateComments: false,
      emailDigest: false,
    });
    // UTC and the older names some browsers report are time zones too.
    expect((await zone("UTC")).body.timeZone).toBe("UTC");
    expect((await zone("Asia/Calcutta")).body.timeZone).toBe("Asia/Calcutta");
    // A toggle alone leaves the zone where it was.
    const toggled = await call(t, sam.headers, "PATCH", "/v1/me/notifications", { replies: false });
    expect(toggled.body).toMatchObject({ timeZone: "Asia/Calcutta", prefs: { replies: false } });
    expect((await call(t, sam.headers, "GET", "/v1/me/notifications")).body.timeZone).toBe(
      "Asia/Calcutta",
    );
    expect((await call(t, ines.headers, "GET", "/v1/me/notifications")).body.timeZone).toBeNull();

    // A bare offset is refused: Postgres reads "+05" as five hours west.
    const badZones = [
      "Mars/Olympus_Mons",
      "../../etc/passwd",
      "",
      "x".repeat(65),
      7,
      "+05",
      "-0330",
    ];
    for (const bad of badZones) {
      const refused = await zone(bad);
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe("invalid_request");
    }
    expect((await call(t, sam.headers, "GET", "/v1/me/notifications")).body.timeZone).toBe(
      "Asia/Calcutta",
    );
  });

  test("say whether the daily email can be sent at all, and where it would go", async () => {
    const before = t.deps.features.email;
    t.deps.features.email = true;
    try {
      const got = await call(t, ines.headers, "GET", "/v1/me/notifications");
      // With email on, also whether people-joined could reach her (an organisation's admin).
      expect(got.body.email).toEqual({
        address: "ines@example.com",
        available: true,
        teamAvailable: expect.any(Boolean),
      });
    } finally {
      t.deps.features.email = before;
    }
  });

  test("refuse what is not a toggle", async () => {
    const bad = await call(t, maya.headers, "PATCH", "/v1/me/notifications", { needsYou: "yes" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid_request");
  });

  test("need a signed-in person", async () => {
    const anon = await call(t, {}, "GET", "/v1/me/notifications");
    expect(anon.status).toBe(401);
  });
});

describe("devices", () => {
  test("register with a push token, and say so again without a second row", async () => {
    const first = await call(t, maya.headers, "POST", "/v1/me/devices", phone(1));
    expect(first.status).toBe(201);
    expect(first.body.device).toMatchObject({
      platform: "ios",
      name: "iPhone 16 Pro",
      appVersion: "0.13.0",
      pings: true,
      blocked: false,
    });
    // The token is what sending needs, and never comes back.
    expect(JSON.stringify(first.body)).not.toContain(token(1));

    const again = await call(t, maya.headers, "POST", "/v1/me/devices", {
      ...phone(1),
      appVersion: "0.14.0",
    });
    expect(again.status).toBe(200);
    expect(again.body.device.id).toBe(first.body.device.id);
    expect(again.body.device.appVersion).toBe("0.14.0");

    const listed = await call(t, maya.headers, "GET", "/v1/me/notifications");
    expect(listed.body.devices.map((d: { id: string }) => d.id)).toEqual([first.body.device.id]);
  });

  test("turn pings off for one device, and say iOS blocked them", async () => {
    const { body } = await call(t, maya.headers, "POST", "/v1/me/devices", phone(2));
    const off = await call(t, maya.headers, "PATCH", `/v1/me/devices/${body.device.id}`, {
      pings: false,
    });
    expect(off.status).toBe(200);
    expect(off.body.device).toMatchObject({ pings: false, blocked: false });
    const blocked = await call(t, maya.headers, "PATCH", `/v1/me/devices/${body.device.id}`, {
      blocked: true,
      name: "Maya's iPhone",
    });
    expect(blocked.body.device).toMatchObject({
      pings: false,
      blocked: true,
      name: "Maya's iPhone",
    });
  });

  test("take a new token from Expo, but not one another device holds", async () => {
    const { body: a } = await call(t, maya.headers, "POST", "/v1/me/devices", phone(3));
    await call(t, maya.headers, "POST", "/v1/me/devices", phone(4));
    const rotated = await call(t, maya.headers, "PATCH", `/v1/me/devices/${a.device.id}`, {
      pushToken: token(5),
    });
    expect(rotated.status).toBe(200);
    const taken = await call(t, maya.headers, "PATCH", `/v1/me/devices/${a.device.id}`, {
      pushToken: token(4),
    });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe("push_token_taken");
  });

  test("a phone signed in as someone else moves to them, pings on", async () => {
    const { body: mine } = await call(t, maya.headers, "POST", "/v1/me/devices", phone(6));
    await call(t, maya.headers, "PATCH", `/v1/me/devices/${mine.device.id}`, { pings: false });
    const theirs = await call(t, ines.headers, "POST", "/v1/me/devices", phone(6));
    expect(theirs.status).toBe(201);
    expect(theirs.body.device.pings).toBe(true);
    const listed = await call(t, maya.headers, "GET", "/v1/me/notifications");
    expect(listed.body.devices.some((d: { id: string }) => d.id === mine.device.id)).toBe(false);
    expect(t.logs).toContainEqual(
      expect.objectContaining({ event: "device_token_moved", from: maya.userId, to: ines.userId }),
    );
  });

  test("another install's token stays with whoever holds it", async () => {
    const { body: mine } = await call(t, maya.headers, "POST", "/v1/me/devices", phone(10));
    const stolen = await call(t, ines.headers, "POST", "/v1/me/devices", {
      ...phone(10),
      installId: install(999),
    });
    expect(stolen.status).toBe(409);
    expect(stolen.body.error.code).toBe("push_token_taken");
    // Maya still has it, unchanged, and Ines has nothing to change or delete.
    const listed = await call(t, maya.headers, "GET", "/v1/me/notifications");
    expect(listed.body.devices.find((d: { id: string }) => d.id === mine.device.id)).toMatchObject({
      name: "iPhone 16 Pro",
      pings: true,
    });
    const hers = await call(t, ines.headers, "GET", "/v1/me/notifications");
    expect(hers.body.devices.some((d: { id: string }) => d.id === mine.device.id)).toBe(false);
    expect(t.logs).toContainEqual(
      expect.objectContaining({
        event: "device_token_conflict",
        userId: ines.userId,
        holderId: maya.userId,
      }),
    );
    expect(JSON.stringify(t.logs)).not.toContain(token(10));
  });

  test("refuse a registration that does not say which install it is", async () => {
    for (const installId of [undefined, "short", "has spaces in it, sixteen+"]) {
      const bad = await call(t, maya.headers, "POST", "/v1/me/devices", {
        ...phone(11),
        installId,
      });
      expect(bad.status).toBe(400);
    }
  });

  test("are each person's own: another's device is not found", async () => {
    const { body } = await call(t, maya.headers, "POST", "/v1/me/devices", phone(7));
    const id = body.device.id;
    const patched = await call(t, ines.headers, "PATCH", `/v1/me/devices/${id}`, { pings: false });
    expect(patched.status).toBe(404);
    const deleted = await call(t, ines.headers, "DELETE", `/v1/me/devices/${id}`);
    expect(deleted.status).toBe(404);
  });

  test("are forgotten on sign-out from the phone", async () => {
    const { body } = await call(t, maya.headers, "POST", "/v1/me/devices", phone(8));
    const deleted = await call(t, maya.headers, "DELETE", `/v1/me/devices/${body.device.id}`);
    expect(deleted.status).toBe(204);
    const again = await call(t, maya.headers, "DELETE", `/v1/me/devices/${body.device.id}`);
    expect(again.status).toBe(404);
  });

  test("refuse what is not an Expo push token, an APNs token in hex included", async () => {
    for (const pushToken of [
      "ExponentPushToken[abc]",
      "ExponentPushToken[has spaces in it]",
      "exponentpushtoken[aaaaaaaaaaaa]",
      "abc",
      "a".repeat(64),
    ]) {
      const bad = await call(t, maya.headers, "POST", "/v1/me/devices", { ...phone(9), pushToken });
      expect(bad.status).toBe(400);
      expect(JSON.stringify(bad.body)).not.toContain(pushToken);
    }
    // An iPhone without a token, or without which APNs it is for, is not a registration.
    const { pushToken: _token, ...tokenless } = phone(9);
    expect((await call(t, maya.headers, "POST", "/v1/me/devices", tokenless)).status).toBe(400);
    const { pushEnvironment: _env, ...nowhere } = phone(9);
    expect((await call(t, maya.headers, "POST", "/v1/me/devices", nowhere)).status).toBe(400);
  });

  test("take both of Expo's token shapes, exactly as given", async () => {
    const expo = "ExpoPushToken[Ab_9-cdEFghIJkl]";
    const { status, body } = await call(t, maya.headers, "POST", "/v1/me/devices", {
      ...phone(12),
      pushToken: expo,
    });
    expect(status).toBe(201);
    const kept = (await listDevices(t.db, maya.userId)).find((d) => d.id === body.device.id);
    expect(kept?.pushToken).toBe(expo);
  });

  test("a Mac registers its install with no token, and again in place", async () => {
    const mac = { platform: "macos", installId: install(500), name: "Studio", appVersion: "2.0.0" };
    const first = await call(t, maya.headers, "POST", "/v1/me/devices", mac);
    expect(first.status).toBe(201);
    expect(first.body.device).toMatchObject({ platform: "macos", name: "Studio", pings: true });
    const again = await call(t, maya.headers, "POST", "/v1/me/devices", {
      ...mac,
      appVersion: "2.1.0",
    });
    expect(again.status).toBe(200);
    expect(again.body.device).toMatchObject({ id: first.body.device.id, appVersion: "2.1.0" });
    // A Mac carries no token, on registering or after.
    for (const extra of [{ pushToken: token(501) }, { pushEnvironment: "production" }]) {
      const bad = await call(t, maya.headers, "POST", "/v1/me/devices", { ...mac, ...extra });
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe("invalid_request");
    }
    const patched = await call(t, maya.headers, "PATCH", `/v1/me/devices/${first.body.device.id}`, {
      pushToken: token(502),
    });
    expect(patched.status).toBe(400);
    expect(patched.body.error.code).toBe("invalid_request");
  });

  test("keep at most twenty a person, forgetting the one unseen longest", async () => {
    const omar = await t.signInAs({ login: "omar" });
    const ids: string[] = [];
    for (let n = 0; n < MAX_DEVICES_PER_USER + 2; n++) {
      t.clock.advance(1_000);
      const { body } = await call(t, omar.headers, "POST", "/v1/me/devices", phone(100 + n));
      ids.push(body.device.id);
    }
    const listed = await call(t, omar.headers, "GET", "/v1/me/notifications");
    expect(listed.body.devices).toHaveLength(MAX_DEVICES_PER_USER);
    const kept = listed.body.devices.map((d: { id: string }) => d.id);
    expect(kept).toContain(ids.at(-1));
    expect(kept).not.toContain(ids[0]);
    expect(kept).not.toContain(ids[1]);
  });
});

describe("being at a device", () => {
  const activeAt = async (id: string) =>
    (await t.db.select().from(devices)).find((row) => row.id === id)?.activeAt ?? null;

  test("a heartbeat marks the device active and seen, and skips a write 30 seconds on", async () => {
    const mac = { platform: "macos", installId: install(600), name: "Studio" };
    const { body } = await call(t, maya.headers, "POST", "/v1/me/devices", mac);
    const id = body.device.id;
    const beat = () => call(t, maya.headers, "PUT", `/v1/me/devices/${id}/active`);
    expect(await activeAt(id)).toBeNull();

    t.clock.advance(5_000);
    const first = new Date(t.clock.now());
    expect((await beat()).status).toBe(204);
    expect(await activeAt(id)).toEqual(first);
    const listed = await call(t, maya.headers, "GET", "/v1/me/notifications");
    expect(listed.body.devices.find((d: { id: string }) => d.id === id).lastSeenAt).toBe(
      first.toISOString(),
    );

    // Under 30 seconds after the last write, nothing is written, and it is still a 204.
    t.clock.advance(29_000);
    expect((await beat()).status).toBe(204);
    expect(await activeAt(id)).toEqual(first);
    t.clock.advance(1_000);
    expect((await beat()).status).toBe(204);
    expect(await activeAt(id)).toEqual(new Date(t.clock.now()));
  });

  test("another person's device, or none, is not found", async () => {
    const { body } = await call(t, maya.headers, "POST", "/v1/me/devices", phone(601));
    const theirs = await call(t, ines.headers, "PUT", `/v1/me/devices/${body.device.id}/active`);
    expect(theirs.status).toBe(404);
    expect(theirs.body.error.code).toBe("not_found");
    expect(await activeAt(body.device.id)).toBeNull();
    expect((await call(t, maya.headers, "PUT", "/v1/me/devices/dev_none/active")).status).toBe(404);
    expect((await call(t, {}, "PUT", `/v1/me/devices/${body.device.id}/active`)).status).toBe(401);
  });
});

describe("the inbox", () => {
  const note = (userId: string, n: string, extra: Partial<NewNotification> = {}) =>
    ({
      id: `ntf_route_${n}`,
      userId,
      workspaceId: null,
      canvasId: null,
      kind: "needs_you",
      dedupeKey: `needs_you:route:${n}`,
      title: "Lisbon",
      body: "Ponzu has a question for you.",
      link: { open: "thread", questionId: `q_${n}` },
      sourceId: `q_${n}`,
      muted: false,
      ...extra,
    }) satisfies NewNotification;
  const readOf = async (id: string) => {
    const row = (await t.db.select().from(notifications)).find((one) => one.id === id);
    return { readAt: row!.readAt, readVia: row!.readVia };
  };

  test("the badge counts open needs-you questions, read or muted, and not answered ones", async () => {
    const lee = await t.signInAs({ login: "lee" });
    const now = new Date(t.clock.now());
    await insertNotifications(t.db, {
      now,
      rows: [
        note(lee.userId, "b1"),
        note(lee.userId, "b2", { muted: true }),
        note(lee.userId, "b3"),
        note(lee.userId, "b4", {
          kind: "reply",
          dedupeKey: "reply:route:b4",
          body: "Ponzu replied to your comment.",
        }),
        note(ines.userId, "b5"),
      ],
    });
    await markNotificationsRead(t.db, {
      userId: lee.userId,
      ids: ["ntf_route_b1"],
      now,
      via: "mac",
    });
    // Its question was answered.
    await t.db.execute(`update notifications set resolved_at = now() where id = 'ntf_route_b3'`);

    const got = await call(t, lee.headers, "GET", "/v1/me/notifications");
    expect(got.body.badge).toBe(2);
    // Pings off still count what waits.
    const patched = await call(t, lee.headers, "PATCH", "/v1/me/notifications", {
      needsYou: false,
    });
    expect(patched.body.badge).toBe(2);
  });

  test("reading one on the device that showed it, once or again, and only one's own", async () => {
    const now = new Date(t.clock.now());
    await insertNotifications(t.db, {
      now,
      rows: [note(maya.userId, "r1"), note(maya.userId, "r2"), note(ines.userId, "r3")],
    });
    const read = (who: SignedInPerson, id: string, body: unknown = { via: "mac" }) =>
      call(t, who.headers, "POST", `/v1/me/notifications/${id}/read`, body);

    t.clock.advance(1_000);
    expect((await read(maya, "ntf_route_r1")).status).toBe(204);
    const readAt = new Date(t.clock.now());
    expect(await readOf("ntf_route_r1")).toEqual({ readAt, readVia: "mac" });

    // Again, from the phone: safe, and the first reading stands.
    t.clock.advance(1_000);
    expect((await read(maya, "ntf_route_r1", { via: "ios" })).status).toBe(204);
    expect(await readOf("ntf_route_r1")).toEqual({ readAt, readVia: "mac" });

    // Someone else's, or one that does not exist: the same 204, and nothing changes.
    expect((await read(maya, "ntf_route_r3")).status).toBe(204);
    expect(await readOf("ntf_route_r3")).toEqual({ readAt: null, readVia: null });
    expect((await read(maya, "ntf_none")).status).toBe(204);
    expect(await readOf("ntf_route_r2")).toEqual({ readAt: null, readVia: null });

    // Only the apps read this way: `seen`, `looking` and `expired` are the API's own.
    for (const body of [{ via: "seen" }, { via: "looking" }, { via: "expired" }, {}]) {
      expect((await read(maya, "ntf_route_r2", body)).status).toBe(400);
    }
    expect(await readOf("ntf_route_r2")).toEqual({ readAt: null, readVia: null });
    const anon = await call(t, {}, "POST", "/v1/me/notifications/ntf_route_r2/read", {
      via: "mac",
    });
    expect(anon.status).toBe(401);
  });
});
