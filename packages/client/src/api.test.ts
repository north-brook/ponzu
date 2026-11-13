import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ClientOp, emptyDoc, newOpId } from "@ponzu/core";
import { el } from "@ponzu/core/fixtures";
// The real API, in process, to hold the typed client to the routes it is typed from. A test
// may run the API's code; the package itself only ever imports its types.
import {
  call,
  canvasIn,
  startRunner,
  type Workspace,
  workspaceWithRepo,
} from "../../../apps/api/src/testing/canvases.ts";
import { createTestApp, type TestApp } from "../../../apps/api/src/testing/index.ts";
import { authStates } from "../../db/src/index.ts";
import { type Api, createApi } from "./api.ts";
import { systemClock } from "./clock.ts";
import { ApiError } from "./errors.ts";
import { createSession, type KeyValueStorage, SESSION_KEY } from "./session.ts";
import { createFakeBackend } from "./testing/backend.ts";

let t: TestApp;
let ws: Workspace;

beforeAll(async () => {
  t = await createTestApp();
  ws = await workspaceWithRepo(t, { maya: "admin", ines: "read" });
});
afterAll(() => t.close());

/** The client as an app would hold it, signed in as someone `workspaceWithRepo` made. */
function clientFor(login: string, opts: Parameters<typeof createApi>[1] = {}): Api {
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
  return createApi(session, opts);
}

describe("against the API's own routes", () => {
  test("an install link remembers which app asked, by its links' scheme", async () => {
    const link = await clientFor("maya", { linkScheme: "ponzu-dev" }).github.installLink({
      client: "mac",
    });
    const none = await clientFor("maya", { linkScheme: "none" }).github.installLink({
      client: "mac",
    });
    const plain = await clientFor("maya").github.installLink({ client: "mac" });
    const rows = await t.db.select().from(authStates);
    const schemes = rows
      .filter((row) => row.userId === ws.people.maya!.userId)
      .map((row) => (row.payload as { scheme?: string | null }).scheme);
    // An app that says nothing is not known, so the page won't guess Ponzu for it.
    expect(schemes).toEqual(["ponzu-dev", "none", null]);
    expect(link.url).not.toContain("ponzu-dev");
    expect(plain.url).toStartWith("https://github.com/");

    // Each comes back with the app's handle on it, to ask how it went.
    expect(await clientFor("maya").github.install(none.id)).toMatchObject({ status: "waiting" });
  });

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
    // The test repo has next to nothing in it, and gets four all the same: where to begin.
    const answer = await ines.repos.ideas(ws.repo.id);
    const status: "ready" | "generating" | "none" = answer.status;
    expect(status).toBe("ready");
    expect(answer.ideas).toHaveLength(4);
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

  test("a canvas from creation to deletion", async () => {
    const maya = clientFor("maya");
    const created = await maya.canvases.create({
      workspaceId: ws.id,
      repoId: ws.repo.id,
      name: "Kettle",
    });
    expect([created.name, created.access, created.seq]).toEqual(["Kettle", "write", 0]);
    expect(created.assetsUrl).toEndWith("/");
    expect((await maya.workspaces.canvases(ws.id)).canvases.map((d) => d.id)).toContain(created.id);

    const { doc, seq } = await maya.canvases.doc(created.id);
    expect([doc.name, seq, doc.pages.length]).toEqual(["Kettle", 0, 1]);
    const page = doc.pages[0]!.id;
    const committed = await maya.canvases.commit(created.id, [
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
    expect((await maya.canvases.ops(created.id, 0)).ops.map((op) => op.seq)).toEqual([1]);

    const undone = await maya.canvases.undo(created.id);
    expect(undone.seq).toBe(2);
    expect((await maya.canvases.redo(created.id)).seq).toBe(3);

    const renamed = await maya.canvases.rename(created.id, { name: "Kettle 2", icon: "code" });
    expect([renamed.name, renamed.icon]).toEqual(["Kettle 2", "code"]);
    expect((await maya.canvases.settle(created.id, true)).status).toBe("settled");

    const { present } = await maya.canvases.presence(created.id, page);
    expect(present.map((p) => [p.githubLogin, p.pageId])).toEqual([["maya", page]]);
    await maya.canvases.leave(created.id);
    await maya.canvases.seen(created.id, { seq: 1 });

    await maya.canvases.delete(created.id);
    const gone = await maya.canvases.get(created.id).catch((error) => error);
    expect([gone.status, gone.code]).toEqual([404, "not_found"]);
  });

  test("someone who may only read is told so by code", async () => {
    const maya = clientFor("maya");
    const ines = clientFor("ines");
    const created = await maya.canvases.create({ workspaceId: ws.id, repoId: ws.repo.id });
    expect((await ines.canvases.get(created.id)).access).toBe("read");
    const refused = await ines.canvases
      .commit(created.id, [{ id: newOpId(), op: { op: "file.rename", name: "Mine" } }])
      .catch((error) => error);
    expect([refused.status, refused.code]).toEqual([403, "forbidden"]);
    const nothing = await maya.canvases.undo(created.id).catch((error) => error);
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

  test("a canvas made with its first message, once however often it is sent, and its thread", async () => {
    const maya = clientFor("maya");
    const body = {
      workspaceId: ws.id,
      name: "Checkout",
      message: { text: "Make checkout one page" },
      effort: "low" as const,
      createKey: "create-key-client-1",
    };
    const [first, again] = await Promise.all([
      maya.canvases.create(body),
      maya.canvases.create(body),
    ]);
    expect(again.id).toBe(first.id);

    const said = await maya.canvases.sendMessage(first.id, { text: "And a summary" });
    expect(said.kind).toBe("message");
    const { items } = await maya.canvases.thread(first.id);
    expect(items.map((item) => (item.kind === "message" ? item.payload.text : item.kind))).toEqual([
      "Make checkout one page",
      "And a summary",
    ]);
    await maya.canvases.stop(first.id);
  });

  test("live queries are sealed in one call, each answered on its own", async () => {
    const maya = clientFor("maya");
    const created = await maya.canvases.create({ workspaceId: ws.id, name: "Scratch" });
    const { url, results } = await maya.live([
      { name: "canvas.head", args: { canvasId: created.id } },
      { name: "workspace.canvases", args: { workspaceId: ws.id } },
      { name: "canvas.head", args: { canvasId: "cnv_unknown" } },
    ]);
    expect(url).toBe(t.realtime.url);
    expect(results.map((r) => ("sealed" in r ? "sealed" : r.error.code))).toEqual([
      "sealed",
      "sealed",
      "not_found",
    ]);
  });

  test("the thread: a message, its page, an answer that wins once, and a stop", async () => {
    const maya = clientFor("maya");
    const canvas = await canvasIn(t, ws, "maya", emptyDoc("Thread"));
    const sent = await maya.canvases.sendMessage(canvas.id, { text: "Make it calmer" });
    expect(sent).toMatchObject({ kind: "message", streaming: false });
    expect(sent.kind === "message" && sent.payload.text).toBe("Make it calmer");
    const page = await maya.canvases.thread(canvas.id, { limit: 10 });
    expect(page.items.map((item) => item.id)).toEqual([sent.id]);
    expect((await maya.canvases.thread(canvas.id, { before: sent.seq })).items).toEqual([]);

    const runner = await startRunner(t, canvas.id);
    const questionId = "q_abcdefghjkmnpqrs";
    const asked = {
      header: "Headline",
      question: "Which way?",
      options: [
        { label: "Shorten it", description: "Two lines." },
        { label: "Let it wrap", description: "Three lines." },
      ],
      multiSelect: false,
    };
    const raised = await call(t, runner.headers, "POST", "/v1/runner/questions", {
      id: questionId,
      kind: "question",
      payload: { questions: [asked] },
    });
    expect(raised.status).toBe(200);
    const answer = { answers: { "Which way?": "Shorten it" } };
    expect(await maya.canvases.answer(canvas.id, questionId, answer)).toEqual({
      id: questionId,
      status: "answered",
    });
    const again = await maya.canvases.answer(canvas.id, questionId, answer).catch((e) => e);
    expect([again.status, again.code]).toEqual([409, "question_closed"]);

    expect(await maya.canvases.stop(canvas.id)).toBeUndefined();
    const ines = await clientFor("ines")
      .canvases.stop(canvas.id)
      .catch((e) => e);
    expect([ines.status, ines.code]).toEqual([403, "forbidden"]);
  });

  test("a comment's picture: WebP from the Mac, PNG from the iPhone, each kept as sent", async () => {
    // Storage's signed PUTs reach the test's storage; nothing else goes through this fetch.
    const maya = clientFor("maya", {
      fetch: async (input, init) => t.storage.fetch(String(input), init as RequestInit),
    });
    const canvas = await maya.canvases.create({
      workspaceId: ws.id,
      repoId: ws.repo.id,
      name: "Pictures",
    });
    const { doc } = await maya.canvases.doc(canvas.id);
    const pageId = doc.pages[0]!.id;
    const comment = (messageId: string): ClientOp => ({
      id: newOpId(),
      op: {
        op: "thread.create",
        thread: {
          id: `th_${messageId}`,
          pageId,
          x: 10,
          y: 10,
          status: "open",
          createdAt: 0,
          updatedAt: 0,
          messages: [
            { id: messageId, author: { kind: "user", name: "Maya" }, text: "Here", createdAt: 0 },
          ],
        },
      } as ClientOp["op"],
    });
    await maya.canvases.commit(canvas.id, [comment("m_mac"), comment("m_phone")]);
    const bytes = (s: string) => new TextEncoder().encode(s);

    const mac = await maya.canvases.uploadCommentPicture(canvas.id, "m_mac", {
      light: bytes("light"),
      dark: bytes("dark"),
    });
    const phone = await maya.canvases.uploadCommentPicture(
      canvas.id,
      "m_phone",
      { light: bytes("light"), dark: bytes("dark") },
      "png",
    );
    const fromMac = await maya.canvases.attachCommentPicture(canvas.id, "m_mac", mac);
    const fromPhone = await maya.canvases.attachCommentPicture(canvas.id, "m_phone", phone);
    expect(fromMac.picture.light).toMatch(/^comments\/m_mac-light-[0-9a-z]{6}\.webp$/);
    expect(fromMac.picture.dark).toMatch(/^comments\/m_mac-dark-[0-9a-z]{6}\.webp$/);
    expect(fromPhone.picture.light).toMatch(/^comments\/m_phone-light-[0-9a-z]{6}\.png$/);
    expect(fromPhone.picture.dark).toMatch(/^comments\/m_phone-dark-[0-9a-z]{6}\.png$/);
  });

  test("search answers what the fake backend answers for the same canvas", async () => {
    // The same steps, through the client, on the real API and on the fake. Only the agent may
    // make a board, so each world makes it as its own agent.
    type AgentCommit = (canvasId: string, ops: ClientOp[]) => Promise<unknown[]>;
    const steps = async (
      api: Api,
      workspaceId: string,
      repoId: string,
      agentCommit: AgentCommit,
    ) => {
      const created = await api.canvases.create({ workspaceId, repoId, name: "Okapi launch" });
      const { doc } = await api.canvases.doc(created.id);
      const pageId = doc.pages[0]!.id;
      const board = {
        id: newOpId(),
        op: {
          op: "artboard.create",
          page: pageId,
          index: 0,
          artboard: {
            id: "ab_okapi",
            name: "Okapi board",
            x: 0,
            y: 0,
            root: el("ab_okapi", "section"),
          },
        },
      } satisfies ClientOp;
      expect(await agentCommit(created.id, [board])).toEqual([]);
      const committed = await api.canvases.commit(created.id, [
        { id: newOpId(), op: { op: "page.update", id: pageId, name: "okapi page" } },
        {
          id: newOpId(),
          op: {
            op: "thread.create",
            thread: {
              id: "th_okapi",
              artboardId: "ab_okapi",
              x: 1,
              y: 2,
              status: "open",
              createdAt: 0,
              updatedAt: 0,
              messages: [
                {
                  id: "m_okapi",
                  author: { kind: "user", name: "" },
                  text: "Is the okapi\ntoo big here?",
                  createdAt: 0,
                },
              ],
            },
          },
        },
      ]);
      expect(committed.rejected).toEqual([]);
      const said = await api.canvases.sendMessage(created.id, { text: "Draw the okapi pricing" });
      const found = [
        await api.workspaces.search(workspaceId, { q: "  okapi " }),
        // workspaceWithRepo makes no GitHub organization, so the API knows no people to find
        // here; people are compared in search.test.ts and apps/api/src/search/search.test.ts.
        await api.workspaces.search(workspaceId, {
          q: "okapi big",
          groups: ["comments", "people"],
        }),
        await api.workspaces.search(workspaceId, { q: "?!" }),
      ];
      // The ids and times each world makes its own, and the avatars only the API's people have.
      const own = new Map<string, string>([
        [created.id, "<canvas>"],
        [pageId, "<page>"],
        [said.id, "<item>"],
      ]);
      return JSON.parse(
        JSON.stringify(found, (key, value) => {
          if (key === "at") return value === null ? null : "<at>";
          // Where the message sits depends on what each world wrote to the thread before it.
          if (key === "itemSeq") return value === said.seq ? "<seq>" : value;
          if (key === "avatarUrl") return "<avatar>";
          if (typeof value === "string" && own.has(value)) return own.get(value);
          if (typeof value === "string" && value.startsWith("usr_")) return "<user>";
          return value;
        }),
      );
    };

    const real = await steps(clientFor("maya"), ws.id, ws.repo.id, async (canvasId, ops) => {
      const runner = await startRunner(t, canvasId);
      const sent = await call(t, runner.headers, "POST", `/v1/canvases/${canvasId}/ops`, { ops });
      expect(sent.status).toBe(200);
      return sent.body.rejected;
    });
    const backend = createFakeBackend();
    const maya = backend.addPerson({ login: "maya", name: "Maya" });
    const ines = backend.addPerson({ login: "ines", name: "Ines" });
    const fakeWs = backend.addWorkspace({
      login: "acme",
      members: { [maya.id]: "admin", [ines.id]: "member" },
      repos: [{ name: "fernwood", access: { [ines.id]: "read" } }],
    });
    const fake = await steps(
      backend.connect(maya).api,
      fakeWs.id,
      fakeWs.repos[0]!.id,
      async (canvasId, ops) => {
        backend.agent(canvasId).commit(ops.map(({ op }) => op));
        return [];
      },
    );

    expect(fake).toEqual(real);
    // And it is a real answer, not two empty ones.
    expect(real[0].comments[0]).toMatchObject({
      snippet: "Is the okapi too big here?",
      author: { kind: "user", id: "<user>", name: "Maya", login: "maya" },
    });
    expect(
      ["canvases", "boards", "comments", "messages"].map((group) => real[0][group].length),
    ).toEqual([1, 2, 1, 1]);
    // Only the groups asked for, and every word must be found.
    expect([real[1].comments.length, real[1].canvases, real[1].boards]).toEqual([1, [], []]);
  });

  test("the pull request: the tab, opening it, a file's diff, and a refusal by code", async () => {
    const maya = clientFor("maya");
    const canvas = await canvasIn(t, ws, "maya", emptyDoc("Shorter checkout"));
    await t.db.execute(`update canvases set branch = 'pz/checkout' where id = '${canvas.id}'`);
    const before = await maya.canvases.pullRequest.get(canvas.id);
    expect([before.branch.exists, before.pullRequest, before.nextAction]).toEqual([
      false,
      null,
      "none",
    ]);

    t.github.pulls.push(t.github.repo(ws.repo.fullName)!, "pz/checkout");
    expect((await maya.canvases.pullRequest.get(canvas.id)).nextAction).toBe("create_pr");
    const opened = await maya.canvases.pullRequest.open(canvas.id);
    expect(opened.pullRequest).toMatchObject({ state: "draft", title: "Shorter checkout" });
    const [file] = opened.pullRequest!.files.items;
    const diff = await maya.canvases.pullRequest.file(canvas.id, file!.path);
    expect(diff.path).toBe(file!.path);
    expect(["text", "binary", "too_large"]).toContain(diff.diff.kind);

    const sha = opened.pullRequest!.head.sha;
    const draft = await maya.canvases.pullRequest
      .merge(canvas.id, { headSha: sha })
      .catch((e) => e);
    expect([draft.status, draft.code]).toEqual([409, "pull_request_draft"]);
    expect((await maya.canvases.pullRequest.ready(canvas.id)).pullRequest!.state).toBe("open");
  });
});
