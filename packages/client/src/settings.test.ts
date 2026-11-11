import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// The real API, in process, to hold the typed client to the routes it is typed from.
import { type Workspace, workspaceWithRepo } from "../../../apps/api/src/testing/designs.ts";
import { createTestApp, type TestApp } from "../../../apps/api/src/testing/index.ts";
import { type Api, createApi } from "./api.ts";
import { systemClock } from "./clock.ts";
import { ApiError } from "./errors.ts";
import { createSession, type KeyValueStorage, SESSION_KEY } from "./session.ts";
import { createFakeBackend } from "./testing/backend.ts";

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
    pushToken: "c".repeat(64),
    pushEnvironment: "development",
    name: "iPhone 16 Pro",
  });
  const { device: off } = await maya.devices.update(device.id, { pings: false });
  expect(off.pings).toBe(false);
  expect((await maya.notifications.get()).devices.map((d) => d.id)).toEqual([device.id]);
  await maya.devices.remove(device.id);
  expect((await maya.notifications.get()).devices).toEqual([]);

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
});
