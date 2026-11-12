import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// The real API, in process, to hold the typed client to the routes it is typed from.
import { type Workspace, workspaceWithRepo } from "../../../apps/api/src/testing/canvases.ts";
import { createTestApp, type TestApp } from "../../../apps/api/src/testing/index.ts";
import { type Api, createApi } from "./api.ts";
import { systemClock } from "./clock.ts";
import { ApiError } from "./errors.ts";
import type { NotificationRow } from "./live/rows.ts";
import { createSession, type KeyValueStorage, SESSION_KEY } from "./session.ts";
import { createFakeBackend } from "./testing/backend.ts";
import { FakeClock } from "./testing/clock.ts";

/*
 * The Settings methods: against the API's own routes, and the in-memory backend's, which
 * screens and stories run on. Each is called the same way on both.
 */

let t: TestApp;
let ws: Workspace;

beforeAll(async () => {
  t = await createTestApp();
  ws = await workspaceWithRepo(t, { maya: "admin", ines: "read" });
});
afterAll(() => t.close());

function clientFor(login: string): Api {
  const person = ws.people[login]!;
  const saved = JSON.stringify({
    accessToken: person.accessToken,
    refreshToken: person.refreshToken,
    user: { id: person.userId, githubLogin: login, name: null, email: null, avatarUrl: null },
  });
  const storage: KeyValueStorage = {
    get: async (key) => (key === SESSION_KEY ? saved : null),
    set: async () => {},
    delete: async () => {},
  };
  const session = createSession({
    apiUrl: "http://api.test",
    workosClientId: "client_test",
    storage,
    clock: { now: () => t.clock.now(), schedule: systemClock.schedule },
    fetch: async (input, init) => t.app.request(String(input), init),
    client: { platform: "ios", version: "0.13.0" },
  });
  return createApi(session);
}

/** The same steps, on the real routes and on the fake. */
async function settingsSteps(maya: Api, ines: Api, workspaceId: string, repoId: string) {
  const { prefs } = await maya.notifications.set({ teammateComments: true });
  expect(prefs.teammateComments).toBe(true);

  const { device } = await maya.devices.register({
    platform: "ios",
    pushToken: "ExponentPushToken[maya-phone-token-01]",
    pushEnvironment: "development",
    installId: "maya-phone-install-01",
    name: "iPhone 16 Pro",
  });
  const { device: off } = await maya.devices.update(device.id, { pings: false });
  expect(off.pings).toBe(false);
  expect((await maya.notifications.get()).devices.map((d) => d.id)).toEqual([device.id]);
  await maya.devices.remove(device.id);
  expect((await maya.notifications.get()).devices).toEqual([]);

  // The Mac: its install, a heartbeat while she is at it, and her time zone.
  const { device: mac } = await maya.devices.register({
    platform: "macos",
    installId: "maya-mac-install-0001",
    name: "Studio",
  });
  await maya.devices.active(mac.id);
  const elsewhere = await ines.devices.active(mac.id).catch((error: unknown) => error);
  expect((elsewhere as ApiError).code).toBe("not_found");
  const zoned = await maya.notifications.set({ timeZone: "Europe/Lisbon" });
  expect(zoned).toMatchObject({
    timeZone: "Europe/Lisbon",
    badge: 0,
    email: { available: false },
    prefs: { teammateComments: true },
  });
  const badZone = await maya.notifications
    .set({ timeZone: "Mars/Olympus_Mons" })
    .catch((error: unknown) => error);
  expect((badZone as ApiError).code).toBe("invalid_request");
  // Reading what is not hers changes nothing and says nothing.
  await maya.notifications.read("ntf_nothing_here", "mac");
  await maya.devices.remove(mac.id);

  const added = await maya.environments.addSecret(repoId, { name: "DATABASE_URL", value: "pg" });
  expect(added.environment.secrets.map((s) => s.name)).toEqual(["DATABASE_URL"]);
  const listed = await ines.environments.list(workspaceId);
  expect(listed.canManageSecrets).toBe(false);
  expect(listed.repos.map((r) => r.repo.id)).toEqual([repoId]);
  const refused = await ines.environments
    .replaceSecret(repoId, "DATABASE_URL", "other")
    .catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(ApiError);
  expect((refused as ApiError).code).toBe("forbidden");
  await maya.environments.replaceSecret(repoId, "DATABASE_URL", "pg2");
  const removed = await maya.environments.removeSecret(repoId, "DATABASE_URL");
  expect(removed.environment.secrets).toEqual([]);

  const usage = await maya.usage.get(workspaceId);
  expect(usage).toMatchObject({ usedCredits: 0, freeCredits: 200, creditCents: 10 });
  expect((await maya.usage.setCap(workspaceId, 250)).cap).toMatchObject({
    usd: 250,
    isDefault: false,
  });
  expect((await ines.usage.get(workspaceId)).byPerson).toBeNull();

  const wrong = await ines.account.delete("maya").catch((error: unknown) => error);
  expect((wrong as ApiError).code).toBe("confirmation_mismatch");
}

describe("the Settings methods", () => {
  test("against the API's own routes", async () => {
    await settingsSteps(clientFor("maya"), clientFor("ines"), ws.id, ws.repo.id);
    await clientFor("ines").account.delete("ines");
    const gone = await clientFor("ines")
      .me()
      .catch((error: unknown) => error);
    expect(gone).toBeInstanceOf(ApiError);
  });

  test("against the in-memory backend", async () => {
    const backend = createFakeBackend();
    const maya = backend.addPerson({ login: "maya" });
    const ines = backend.addPerson({ login: "ines" });
    const workspace = backend.addWorkspace({
      login: "north-brook",
      members: { [maya.id]: "admin", [ines.id]: "member" },
      repos: [{ name: "fernwood", access: { [ines.id]: "read" } }],
    });
    const repo = workspace.repos[0]!;
    await settingsSteps(
      backend.connect(maya).api,
      backend.connect(ines).api,
      workspace.id,
      repo.id,
    );

    backend.settings.use(workspace.id, maya.id, 320);
    backend.settings.setBase(repo.id, {
      status: "ready",
      builtAt: "2026-11-09T00:00:00.000Z",
      stack: [{ slug: "nodedotjs", label: "Node 22" }],
    });
    const api = backend.connect(maya).api;
    expect(await api.usage.get(workspace.id)).toMatchObject({
      usedCredits: 320,
      billedCredits: 120,
      billedCents: 1200,
    });
    expect((await api.environments.list(workspace.id)).repos[0]?.base.stack).toHaveLength(1);
    const sole = await api.account.delete("maya").catch((error: unknown) => error);
    expect((sole as ApiError).code).toBe("sole_admin");
  });

  test("the inbox on the in-memory backend: live rows, the badge, reading and seeing", async () => {
    const clock = new FakeClock();
    const backend = createFakeBackend({ clock });
    const maya = backend.addPerson({ login: "maya" });
    const workspace = backend.addWorkspace({
      login: "north-brook",
      members: { [maya.id]: "admin" },
      repos: [{ name: "fernwood" }],
    });
    const { api, live } = backend.connect(maya);
    const canvas = await api.canvases.create({
      workspaceId: workspace.id,
      repoId: workspace.repos[0]!.id,
      name: "Kettle",
    });
    let inbox: readonly NotificationRow[] = [];
    live.subscribe("me.notifications", {}, ({ rows }) => {
      inbox = rows ?? [];
    });

    const question = backend.notify(maya.id, {
      kind: "needs_you",
      canvasId: canvas.id,
      workspaceId: workspace.id,
      title: "Kettle",
      body: "Ponzu has a question for you.",
      link: { open: "thread", questionId: "q_1" },
    });
    const reply = backend.notify(maya.id, {
      kind: "reply",
      canvasId: canvas.id,
      workspaceId: workspace.id,
      title: "Kettle",
      body: "Ponzu replied to your comment.",
      link: { open: "thread" },
    });
    await clock.advance(0);
    expect(inbox.map((row) => row.id)).toEqual([question.id, reply.id]);
    expect((await api.notifications.get()).badge).toBe(1);

    // Read on the Mac: the reply leaves; the open question stays, read, on the badge.
    await api.notifications.read(reply.id, "mac");
    await api.notifications.read(question.id, "mac");
    await clock.advance(0);
    expect(inbox.map((row) => [row.id, row.readAt !== null])).toEqual([[question.id, true]]);
    expect((await api.notifications.get()).badge).toBe(1);

    // Opening the canvas reads what came since; its question answered, the row goes.
    const later = backend.notify(maya.id, {
      kind: "finished",
      canvasId: canvas.id,
      title: "Kettle",
      body: "Ponzu finished what you asked.",
      link: { open: "thread" },
    });
    await clock.advance(0);
    expect(inbox.map((row) => row.id)).toContain(later.id);
    await api.canvases.seen(canvas.id);
    backend.settings.resolve(canvas.id, "q_1");
    await api.canvases.seen(canvas.id);
    await clock.advance(0);
    expect(inbox).toEqual([]);
    expect((await api.notifications.get()).badge).toBe(0);
  });
});
