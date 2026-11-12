import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// The real API, in process, to hold the in-memory backend to what it answers.
import { call, type Workspace, workspaceWithRepo } from "../../../apps/api/src/testing/canvases.ts";
import { createTestApp, type TestApp } from "../../../apps/api/src/testing/index.ts";
import { getClaudeAccount, recordClaudeModels } from "../../db/src/index.ts";
import { type Api, createApi } from "./api.ts";
import { systemClock } from "./clock.ts";
import { ApiError } from "./errors.ts";
import { createSession, type KeyValueStorage, SESSION_KEY } from "./session.ts";
import { createFakeBackend } from "./testing/backend.ts";

/*
 * What the picker's query answers once a person's Claude account offers something other than
 * the hand-kept list (docs/cloud.md, "Models"), and the choices it then takes: on the API's own
 * routes and on the in-memory backend that screens and stories run on, the same steps on both.
 */

let t: TestApp;
let ws: Workspace;
beforeAll(async () => {
  t = await createTestApp();
  ws = await workspaceWithRepo(t, { maya: "admin" });
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
  return createApi(
    createSession({
      apiUrl: "http://api.test",
      workosClientId: "client_test",
      storage,
      clock: { now: () => t.clock.now(), schedule: systemClock.schedule },
      fetch: async (input, init) => t.app.request(String(input), init),
      client: { platform: "ios", version: "0.13.0" },
    }),
  );
}

const ALL = ["low", "medium", "high", "xhigh", "max"] as const;
/** As the API answers for the report below: what the fake is told the account offers. */
const OFFERED = [
  { id: "claude-opus-5-5", label: "Opus 5.5", efforts: [...ALL] },
  { id: "claude-haiku-5-5", label: "Haiku 5.5", efforts: ["low" as const, "medium" as const] },
  { id: "claude-opus-6", label: "Opus 6", efforts: [...ALL] },
];

async function steps(api: Api, workspaceId: string) {
  const defaults = await api.claude.defaults();
  expect(defaults).toEqual({
    model: "claude-opus-5-5",
    effort: "medium",
    models: OFFERED,
    efforts: [...ALL],
  });
  const refused = async (work: Promise<unknown>) => {
    const error = await work.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("model_not_offered");
  };
  await refused(api.claude.setDefaults({ model: "claude-fable-5-2" }));
  await refused(api.claude.setDefaults({ model: "claude-haiku-5-5", effort: "max" }));
  await refused(api.canvases.create({ workspaceId, model: "claude-fable-5-2" }));
  expect(await api.claude.setDefaults({ model: "claude-haiku-5-5", effort: "low" })).toMatchObject({
    model: "claude-haiku-5-5",
    effort: "low",
  });
  expect((await api.canvases.create({ workspaceId, model: "claude-opus-6" })).id).toBeString();
}

describe("models an account reported", () => {
  test("on the API's own routes", async () => {
    const key = "sk-ant-api03-maya-models-key-00000000";
    t.anthropic.keys.add(key);
    const headers = (await t.signInAs({ login: "maya" })).headers;
    expect((await call(t, headers, "POST", "/v1/claude/api-key", { key })).status).toBe(200);
    const account = (await getClaudeAccount(t.db, ws.people.maya!.userId))!;
    await recordClaudeModels(t.db, {
      claudeAccountId: account.id,
      connectedAt: account.connectedAt,
      claudeCode: "2.1.400",
      now: new Date(t.clock.now()),
      models: [
        {
          value: "default",
          resolvedModel: "claude-opus-5-5",
          displayName: "Default (recommended)",
          description: "Use the default model (currently Opus 5.5)",
          efforts: [...ALL],
        },
        {
          value: "opus",
          resolvedModel: "claude-opus-6",
          displayName: "Opus",
          description: "Opus 6 · The newest Opus",
          efforts: [...ALL],
        },
        {
          value: "haiku",
          resolvedModel: "claude-haiku-5-5",
          displayName: "Haiku",
          description: "Haiku 5.5 · Fastest",
          efforts: ["low", "medium"],
        },
      ],
    });
    await steps(clientFor("maya"), ws.id);
  });

  test("on the in-memory backend", async () => {
    const backend = createFakeBackend();
    const maya = backend.addPerson({ login: "maya" });
    const workspace = backend.addWorkspace({
      login: "north-brook",
      members: { [maya.id]: "admin" },
      repos: [{ name: "fernwood" }],
    });
    backend.claude.connect(maya.id, "api_key");
    backend.claude.offer(maya.id, OFFERED);
    await steps(backend.connect(maya).api, workspace.id);
  });
});
