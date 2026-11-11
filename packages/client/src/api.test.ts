import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { newOpId } from "@ponzu/core";
// The real API, in process, to hold the typed client to the routes it is typed from. A test
// may run the API's code; the package itself only ever imports its types.
import { type Workspace, workspaceWithRepo } from "../../../apps/api/src/testing/designs.ts";
import { createTestApp, type TestApp } from "../../../apps/api/src/testing/index.ts";
import { type Api, createApi } from "./api.ts";
import { systemClock } from "./clock.ts";
import { ApiError } from "./errors.ts";
import { createSession, type KeyValueStorage, SESSION_KEY } from "./session.ts";

let t: TestApp;
let ws: Workspace;

beforeAll(async () => {
  t = await createTestApp();
  ws = await workspaceWithRepo(t, { maya: "admin", ines: "read" });
});
afterAll(() => t.close());

/** The client as an app would hold it, signed in as someone `workspaceWithRepo` made. */
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
    // The API's clock, which its tokens' expiry follows.
    clock: { now: () => t.clock.now(), schedule: systemClock.schedule },
    fetch: async (input, init) => t.app.request(String(input), init),
    client: { platform: "macos", version: "2.0.0" },
  });
  return createApi(session);
}

describe("against the API's own routes", () => {
  test("me, the workspace and its repos", async () => {
    const maya = clientFor("maya");
    const me = await maya.me();
    expect(me.user.githubLogin).toBe("maya");
    expect(me.workspaces.map((w) => [w.id, w.role])).toEqual([[ws.id, "admin"]]);

    const { workspaces } = await maya.workspaces.list();
    expect(workspaces.map((w) => w.id)).toEqual([ws.id]);
    const profile = await maya.workspaces.get(ws.id);
    expect(profile.repos.map((r) => [r.fullName, r.canPush])).toEqual([[ws.repo.fullName, true]]);
    const mine = profile.members.find((m) => m.userId === ws.people.maya!.userId);
    expect(mine?.role).toBe("admin");
  });

  test("a repo's ideas: generating at first, ready once made", async () => {
    const ines = clientFor("ines");
    expect(await ines.repos.ideas(ws.repo.id)).toEqual({ status: "generating", ideas: [] });
    await t.backgroundDone();
    // The test repo has nothing in it to ground ideas in.
    const answer = await ines.repos.ideas(ws.repo.id);
    const status: "ready" | "generating" | "none" = answer.status;
    expect(status).toBe("none");
    await expect(ines.repos.ideas("repo_nosuchrepo00000")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  test("a member's role, and the API's refusal to leave a workspace without an admin", async () => {
    const maya = clientFor("maya");
    const ines = ws.people.ines!.userId;
    expect((await maya.workspaces.setRole(ws.id, ines, "admin")).member.role).toBe("admin");
    expect((await maya.workspaces.setRole(ws.id, ines, "member")).member.role).toBe("member");
    const refused = await maya.workspaces
      .setRole(ws.id, ws.people.maya!.userId, "member")
      .catch((error) => error);
    expect(refused).toBeInstanceOf(ApiError);
    expect([refused.status, refused.code]).toEqual([409, "last_admin"]);
  });

  test("a design from creation to deletion", async () => {
    const maya = clientFor("maya");
    const created = await maya.designs.create({
      workspaceId: ws.id,
      repoId: ws.repo.id,
      name: "Kettle",
    });
    expect([created.name, created.access, created.seq]).toEqual(["Kettle", "write", 0]);
    expect(created.assetsUrl).toEndWith("/");
    expect((await maya.workspaces.designs(ws.id)).designs.map((d) => d.id)).toContain(created.id);

    const { doc, seq } = await maya.designs.doc(created.id);
    expect([doc.name, seq, doc.pages.length]).toEqual(["Kettle", 0, 1]);
    const page = doc.pages[0]!.id;
    const committed = await maya.designs.commit(created.id, [
      { id: newOpId(), op: { op: "page.update", id: page, name: "Brand" } },
      { id: newOpId(), op: { op: "page.update", id: "pg_nothere", name: "Nope" } },
    ]);
    expect([committed.committed.length, committed.rejected.length, committed.seq]).toEqual([
      1, 1, 1,
    ]);
    expect(committed.committed[0]!.actor).toMatchObject({
      kind: "user",
      id: ws.people.maya!.userId,
    });
    expect((await maya.designs.ops(created.id, 0)).ops.map((op) => op.seq)).toEqual([1]);

    const undone = await maya.designs.undo(created.id);
    expect(undone.seq).toBe(2);
    expect((await maya.designs.redo(created.id)).seq).toBe(3);

    const renamed = await maya.designs.rename(created.id, { name: "Kettle 2", icon: "code" });
    expect([renamed.name, renamed.icon]).toEqual(["Kettle 2", "code"]);
    expect((await maya.designs.settle(created.id, true)).status).toBe("settled");

    const { present } = await maya.designs.presence(created.id, page);
    expect(present.map((p) => [p.githubLogin, p.pageId])).toEqual([["maya", page]]);
    await maya.designs.leave(created.id);
    await maya.designs.seen(created.id, { seq: 1 });

    await maya.designs.delete(created.id);
    const gone = await maya.designs.get(created.id).catch((error) => error);
    expect([gone.status, gone.code]).toEqual([404, "not_found"]);
  });

  test("someone who may only read is told so by code", async () => {
    const maya = clientFor("maya");
    const ines = clientFor("ines");
    const created = await maya.designs.create({ workspaceId: ws.id, repoId: ws.repo.id });
    expect((await ines.designs.get(created.id)).access).toBe("read");
    const refused = await ines.designs
      .commit(created.id, [{ id: newOpId(), op: { op: "file.rename", name: "Mine" } }])
      .catch((error) => error);
    expect([refused.status, refused.code]).toEqual([403, "forbidden"]);
    const nothing = await maya.designs.undo(created.id).catch((error) => error);
    expect([nothing.status, nothing.code]).toEqual([409, "nothing_to_undo"]);
  });

  test("guided setup's steps, the person's Claude by key, and their defaults", async () => {
    const maya = clientFor("maya");
    expect((await maya.onboarding("where")).whereConfirmedAt).not.toBeNull();
    expect((await maya.me()).onboarding.iphoneStepSeenAt).toBeNull();

    const key = "sk-ant-api03-client-test-key-0000";
    const rejected = await maya.claude.connectApiKey(key).catch((error) => error);
    expect([rejected.status, rejected.code]).toEqual([400, "claude_key_invalid"]);
    t.anthropic.keys.add(key);
    const { account } = await maya.claude.connectApiKey(key);
    expect([account?.kind, account?.status, account?.label]).toEqual([
      "api_key",
      "connected",
      "Anthropic API key · sk-ant-…0000",
    ]);
    expect((await maya.claude.get()).account?.kind).toBe("api_key");

    const defaults = await maya.claude.defaults();
    expect(defaults.models.map((m) => m.id)).toContain(defaults.model);
    expect((await maya.claude.setDefaults({ effort: "max" })).effort).toBe("max");

    await maya.claude.disconnect();
    expect((await maya.claude.get()).account).toBeNull();
  });

  test("a design made with its first message, once however often it is sent, and its thread", async () => {
    const maya = clientFor("maya");
    const body = {
      workspaceId: ws.id,
      name: "Checkout",
      message: { text: "Make checkout one page" },
      effort: "low" as const,
      createKey: "create-key-client-1",
    };
    const [first, again] = await Promise.all([
      maya.designs.create(body),
      maya.designs.create(body),
    ]);
    expect(again.id).toBe(first.id);

    const said = await maya.designs.sendMessage(first.id, { text: "And a summary" });
    expect(said.kind).toBe("message");
    const { items } = await maya.designs.thread(first.id);
    expect(items.map((item) => (item.kind === "message" ? item.payload.text : item.kind))).toEqual([
      "Make checkout one page",
      "And a summary",
    ]);
    await maya.designs.stop(first.id);
  });

  test("live queries are sealed in one call, each answered on its own", async () => {
    const maya = clientFor("maya");
    const created = await maya.designs.create({ workspaceId: ws.id, name: "Scratch" });
    const { url, results } = await maya.live([
      { name: "design.head", args: { designId: created.id } },
      { name: "workspace.designs", args: { workspaceId: ws.id } },
      { name: "design.head", args: { designId: "dsn_unknown" } },
    ]);
    expect(url).toBe(t.realtime.url);
    expect(results.map((r) => ("sealed" in r ? "sealed" : r.error.code))).toEqual([
      "sealed",
      "sealed",
      "not_found",
    ]);
  });
});
