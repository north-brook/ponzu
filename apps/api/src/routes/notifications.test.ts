import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MAX_DEVICES_PER_USER } from "@ponzu/db";
import { call } from "../testing/designs.ts";
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

const token = (n: number) => n.toString(16).padStart(64, "a");
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
      pushToken: token(1).toUpperCase(),
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

  test("take a new token from APNs, but not one another device holds", async () => {
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

  test("refuse what is not an APNs token", async () => {
    for (const pushToken of ["ExponentPushToken[abc]", "abc", "g".repeat(64)]) {
      const bad = await call(t, maya.headers, "POST", "/v1/me/devices", { ...phone(9), pushToken });
      expect(bad.status).toBe(400);
      expect(JSON.stringify(bad.body)).not.toContain(pushToken);
    }
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
