import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { emptyDoc } from "@ponzu/core";
import { sampleDoc } from "@ponzu/core/fixtures";
import {
  appendEvent,
  createRunnerToken,
  getDesignAssetKey,
  getDesignHead,
  getQuestion,
  listAssets,
  listThreadItems,
  newId,
  revokeRunnerTokens,
} from "@ponzu/db";
import { feedOf } from "@ponzu/db/testing";
import { RUNNER_HEADER } from "@ponzu/runner/protocol";
import { fingerprint } from "../runner/git-credential.ts";
import {
  call,
  designIn,
  designWithRunner,
  type StartedRunner,
  startRunner,
  type Workspace,
  workspaceWithRepo,
} from "../testing/designs.ts";
import {
  createTestApp,
  TEST_ASSETS_URL,
  TEST_BOT_USER_ID,
  type TestApp,
} from "../testing/index.ts";

let t: TestApp;
let ws: Workspace;
beforeAll(async () => {
  t = await createTestApp();
  ws = await workspaceWithRepo(t, { maya: "write", ines: "read" });
});
afterAll(() => t.close());

const as = (login: string) => ws.people[login]!.headers;
const sample = (repo: "repo" | "scratch" = "repo") =>
  designWithRunner(t, ws, "maya", sampleDoc(), repo);
const send = (runner: StartedRunner, method: string, path: string, body?: unknown) =>
  call(t, runner.headers, method, `/v1/runner${path}`, body);
/** A claim's body: a new claim each time unless an id is given. */
const claim = (body: { claimId?: string; limit?: number } = {}) => ({
  claimId: newId("clm"),
  ...body,
});
const say = (designId: string, text: string, userId = ws.people.maya!.userId) =>
  appendEvent(t.db, { designId, kind: "message", priority: "now", payload: { text }, userId });

describe("the session and the lease", () => {
  test("hands a runner everything it starts with, and the lease", async () => {
    const { design, runner } = await sample();
    const assetKey = await getDesignAssetKey(t.db, design.id);
    const maya = ws.people.maya!;
    const [owner, name] = ws.repo.fullName.split("/") as [string, string];

    expect(runner.session).toEqual({
      runnerId: expect.stringMatching(/^rnr_[0-9a-z]{16}$/),
      design: { id: design.id, name: "Sample" },
      repo: { owner, name, defaultBranch: "main" },
      branch: null,
      claudeSessionId: null,
      model: null,
      effort: null,
      author: { name: "Maya", email: `${maya.github.id}+maya@users.noreply.github.com` },
      committer: {
        name: "ponzu-test[bot]",
        email: `${TEST_BOT_USER_ID}+ponzu-test[bot]@users.noreply.github.com`,
      },
      assetBase: `${TEST_ASSETS_URL}/${assetKey}`,
      link: `https://ponzu.design/designs/${design.id}`,
      theme: null,
      openQuestions: [],
      seq: 0,
      saved: null,
    });
  });

  test("a Scratch design has no repository and no branch", async () => {
    const { runner } = await sample("scratch");

    expect(runner.session).toMatchObject({ repo: null, branch: null });
  });

  test("each session is a new lease, and every call of the runner before it is superseded", async () => {
    const { design, runner: older } = await sample();
    const again = await call(
      t,
      { authorization: older.headers.authorization },
      "POST",
      "/v1/runner/session",
      {},
    );
    expect(again.status).toBe(200);
    expect(again.body.runnerId).not.toBe(older.session.runnerId);

    const refused = await Promise.all([
      send(older, "POST", "/events/claim", claim()),
      send(older, "PUT", "/state", {
        state: "idle",
        status: null,
        artboards: [],
        claudeSessionId: null,
      }),
      send(older, "POST", "/usage", { turns: [] }),
      call(t, older.headers, "GET", `/v1/designs/${design.id}/doc`),
      call(t, older.headers, "POST", `/v1/designs/${design.id}/ops`, {
        ops: [{ id: "op_old", op: { op: "note", name: "n", content: "x" } }],
      }),
    ]);
    for (const answer of refused)
      expect([answer.status, answer.body.error.code]).toEqual([409, "superseded"]);
    const newer = { ...older.headers, [RUNNER_HEADER]: again.body.runnerId };
    expect((await call(t, newer, "POST", "/v1/runner/events/claim", claim())).status).toBe(200);
    expect((await getDesignHead(t.db, design.id))!.seq).toBe(0);
  });

  test("a call without the lease is superseded, and a revoked token is refused everywhere", async () => {
    const { design, runner } = await sample();
    const bare = { authorization: runner.headers.authorization };
    expect((await call(t, bare, "POST", "/v1/runner/events/claim", claim())).body.error.code).toBe(
      "superseded",
    );

    await revokeRunnerTokens(t.db, design.id);

    for (const [method, path] of [
      ["POST", "/v1/runner/session"],
      ["POST", "/v1/runner/events/claim"],
      ["GET", `/v1/designs/${design.id}/doc`],
    ] as const) {
      const answer = await call(
        t,
        runner.headers,
        method,
        path,
        method === "POST" ? {} : undefined,
      );
      expect([answer.status, answer.body.error.code]).toEqual([401, "token_invalid"]);
    }
  });

  test("a runner reaches only its own design, and no person reaches a runner route", async () => {
    const { runner } = await sample();
    const other = await designIn(t, ws, "maya", sampleDoc());

    const doc = await call(t, runner.headers, "GET", `/v1/designs/${other.id}/doc`);
    const person = await call(t, as("maya"), "POST", "/v1/runner/events/claim", claim());

    expect([doc.status, doc.body.error.code]).toEqual([404, "not_found"]);
    expect([person.status, person.body.error.code]).toEqual([401, "token_invalid"]);
  });
});

describe("events", () => {
  test("a claim hands out the design's events oldest first, with who and when, and its head", async () => {
    const { design, runner } = await sample();
    const first = await say(design.id, "Make it blue");
    await appendEvent(t.db, {
      designId: design.id,
      kind: "check",
      priority: "next",
      payload: { name: "ci", conclusion: "failure", url: null, summary: null },
    });

    const { body } = await send(runner, "POST", "/events/claim", claim());

    expect(body).toEqual({
      events: [
        {
          id: first.id,
          seq: first.seq,
          at: first.createdAt.toISOString(),
          priority: "now",
          from: { id: ws.people.maya!.userId, name: "Maya", login: "maya" },
          kind: "message",
          payload: { text: "Make it blue" },
        },
        expect.objectContaining({ kind: "check", priority: "next", from: null }),
      ],
      seq: 0,
      // No pull request yet: the agent's next turn says so.
      pullRequest: null,
    });
  });

  test("claiming again hands out only what is new, and a new runner gets what the old one never acked", async () => {
    const { design, runner } = await sample();
    const lost = await say(design.id, "one");
    await send(runner, "POST", "/events/claim", claim());
    const later = await say(design.id, "two");

    const replay = await send(runner, "POST", "/events/claim", claim());
    expect(replay.body.events.map((e: { id: string }) => e.id)).toEqual([later.id]);

    const next = await startRunner(t, design.id);
    const taken = await send(next, "POST", "/events/claim", claim({ limit: 1 }));
    expect(taken.body.events.map((e: { id: string }) => e.id)).toEqual([lost.id]);
  });

  test("a claim sent again after its answer was lost hands out the same events, and nothing new", async () => {
    const { design, runner } = await sample();
    const message = await say(design.id, "Make it blue");
    const lostClaim = claim();
    await send(runner, "POST", "/events/claim", lostClaim);
    const later = await say(design.id, "And the header");

    const again = await send(runner, "POST", "/events/claim", lostClaim);
    expect(again.body.events.map((e: { id: string }) => e.id)).toEqual([message.id]);

    const next = await send(runner, "POST", "/events/claim", claim());
    expect(next.body.events.map((e: { id: string }) => e.id)).toEqual([later.id]);
    // Once they are acknowledged, it has nothing more to hand out.
    await send(runner, "POST", "/events/ack", { ids: [message.id], claudeSessionId: null });
    expect((await send(runner, "POST", "/events/claim", lostClaim)).body.events).toEqual([]);
  });

  test("a claim without its id, or with one not of the protocol's shape, is refused", async () => {
    const { runner } = await sample();

    for (const body of [{}, { claimId: "clm_short" }, { claimId: newId("ti") }]) {
      const { status, body: answer } = await send(runner, "POST", "/events/claim", body);
      expect([status, answer.error.code]).toEqual([400, "invalid_request"]);
    }
  });

  test("an ack marks only what this runner was handed", async () => {
    const { design, runner } = await sample();
    const unclaimed = await say(design.id, "never claimed");

    const ack = await send(runner, "POST", "/events/ack", {
      ids: [unclaimed.id],
      claudeSessionId: null,
    });

    expect(ack.body).toEqual({ acked: 0 });
    const [row] = await feedOf(t.db, design.id);
    expect(row!.deliveredAt).toBeNull();
  });

  test("an ack marks events delivered once, and keeps the session they went into for the next runner", async () => {
    const { design, runner } = await sample();
    const event = await say(design.id, "one");
    await send(runner, "POST", "/events/claim", claim());
    const ack = { ids: [event.id, "evt_not_this_designs"], claudeSessionId: "sess-1" };

    expect((await send(runner, "POST", "/events/ack", ack)).body).toEqual({ acked: 1 });
    expect((await send(runner, "POST", "/events/ack", ack)).body).toEqual({ acked: 0 });
    // A stop acked alone names no session; the one there is stays.
    await send(runner, "POST", "/events/ack", { ids: [], claudeSessionId: null });

    const next = await startRunner(t, design.id);
    expect(next.session.claudeSessionId).toBe("sess-1");
    expect((await send(next, "POST", "/events/claim", claim())).body.events).toEqual([]);
  });

  test("a limit past the protocol's is refused", async () => {
    const { runner } = await sample();

    const { status, body } = await send(runner, "POST", "/events/claim", claim({ limit: 101 }));

    expect([status, body.error.code]).toEqual([400, "invalid_request"]);
  });
});

describe("the thread", () => {
  const assistant = (id: string, text: string, streaming: boolean) => ({
    id,
    kind: "assistant",
    payload: { text },
    streaming,
  });

  test("items are appended by their ids, replaced while they stream, and fixed once finished", async () => {
    const { design, runner } = await sample();
    const id = newId("ti");
    const write = (text: string, streaming: boolean) =>
      send(runner, "POST", "/thread", { items: [assistant(id, text, streaming)] });

    const first = await write("I'll", true);
    expect(first.body.items).toEqual([{ id, seq: expect.any(Number), streaming: true }]);
    await write("I'll make it blue.", false);
    const late = await write("I'll ma", true);

    expect(late.body.items).toEqual([{ id, seq: first.body.items[0].seq, streaming: false }]);
    const [stored] = await listThreadItems(t.db, { designId: design.id });
    expect(stored).toMatchObject({ kind: "assistant", payload: { text: "I'll make it blue." } });
  });

  test("a stopped notice names the person from the stop event, and no stop of the design refuses the write", async () => {
    const { design, runner } = await sample();
    const other = await sample();
    const stop = await appendEvent(t.db, {
      designId: design.id,
      kind: "stop",
      priority: "now",
      payload: {},
      userId: ws.people.maya!.userId,
    });
    const theirs = await appendEvent(t.db, {
      designId: other.design.id,
      kind: "stop",
      priority: "now",
      payload: {},
    });
    const message = await say(design.id, "not a stop");
    const notice = (eventId: string) => ({
      id: newId("ti"),
      kind: "notice",
      streaming: false,
      payload: { type: "stopped", eventId },
    });

    for (const eventId of [theirs.id, message.id, "evt_made_up"]) {
      const refused = await send(runner, "POST", "/thread", {
        items: [assistant(newId("ti"), "kept?", false), notice(eventId)],
      });
      expect([refused.status, refused.body.error.code]).toEqual([400, "invalid_request"]);
    }
    expect(await listThreadItems(t.db, { designId: design.id })).toEqual([]);

    await send(runner, "POST", "/thread", { items: [notice(stop.id)] });
    const [stored] = await listThreadItems(t.db, { designId: design.id });
    expect(stored!.payload).toEqual({
      type: "stopped",
      by: { id: ws.people.maya!.userId, name: "Maya", login: "maya" },
    });
  });

  test("a runner cannot write what only the API knows, nor people's items, nor its own made-up ids", async () => {
    const { design, runner } = await sample();
    const refused = [
      {
        id: newId("ti"),
        kind: "notice",
        streaming: false,
        payload: { type: "pull_request", number: 1, url: "x", title: "x", state: "open" },
      },
      { id: newId("ti"), kind: "notice", streaming: false, payload: { type: "stopped", by: null } },
      {
        id: newId("ti"),
        kind: "message",
        streaming: false,
        payload: { text: "hi", from: { id: "usr_x", name: "X", login: "x" } },
      },
      { id: newId("ti"), kind: "comment", streaming: false, payload: {} },
      assistant("ti_short", "x", false),
      assistant(newId("q"), "x", false),
    ];

    for (const item of refused) {
      const answer = await send(runner, "POST", "/thread", { items: [item] });
      expect([answer.status, answer.body.error.code]).toEqual([400, "invalid_request"]);
    }
    expect(await listThreadItems(t.db, { designId: design.id })).toEqual([]);
  });

  test("agent text is clipped, and a write holds at most 32 items, each once", async () => {
    const { design, runner } = await sample();
    const id = newId("ti");

    await send(runner, "POST", "/thread", { items: [assistant(id, "x".repeat(40_000), false)] });
    const many = Array.from({ length: 33 }, () => assistant(newId("ti"), "x", false));
    const twice = await send(runner, "POST", "/thread", {
      items: [assistant(id, "a", true), assistant(id, "b", true)],
    });

    const [stored] = await listThreadItems(t.db, { designId: design.id });
    expect((stored!.payload as { text: string }).text).toHaveLength(32_000);
    expect((stored!.payload as { text: string }).text.endsWith("…")).toBe(true);
    expect((await send(runner, "POST", "/thread", { items: many })).status).toBe(400);
    expect(twice.status).toBe(400);
  });

  test("the same id in two designs is two items", async () => {
    const one = await sample();
    const two = await sample();
    const id = newId("ti");

    await send(one.runner, "POST", "/thread", { items: [assistant(id, "one", true)] });
    await send(two.runner, "POST", "/thread", { items: [assistant(id, "two", false)] });

    expect((await listThreadItems(t.db, { designId: one.design.id }))[0]).toMatchObject({
      payload: { text: "one" },
      streaming: true,
    });
    expect((await listThreadItems(t.db, { designId: two.design.id }))[0]!.payload).toEqual({
      text: "two",
    });
  });
});

describe("state", () => {
  test("shows on the design's head, answers its seq, and keeps the session", async () => {
    const { design, runner } = await sample();
    const state = {
      state: "working",
      status: 'Drawing "Home"',
      artboards: ["ab_1"],
      claudeSessionId: "sess-7",
    };

    const first = await send(runner, "PUT", "/state", state);
    const again = await send(runner, "PUT", "/state", state);

    expect([first.body, again.body]).toEqual([
      { seq: 0, sleep: null },
      { seq: 0, sleep: null },
    ]);
    expect(await getDesignHead(t.db, design.id)).toMatchObject({
      agentState: "working",
      agentStatus: 'Drawing "Home"',
      agentArtboards: ["ab_1"],
    });
    expect((await startRunner(t, design.id)).session.claudeSessionId).toBe("sess-7");
  });

  test("a state the protocol does not have is refused", async () => {
    const { runner } = await sample();
    const { status } = await send(runner, "PUT", "/state", {
      state: "limited",
      status: null,
      artboards: [],
      claudeSessionId: null,
    });

    expect(status).toBe(400);
  });
});

describe("questions", () => {
  const plan = (id: string) => ({ id, kind: "plan", payload: { plan: "1. Draw\n2. Ship" } });

  test("a question is raised once under its id and counts once, and a withdrawal closes it once", async () => {
    const { design, runner } = await sample();
    const id = newId("q");

    expect((await send(runner, "POST", "/questions", plan(id))).body).toEqual({
      id,
      status: "open",
    });
    expect((await send(runner, "POST", "/questions", plan(id))).body).toEqual({
      id,
      status: "open",
    });
    expect((await getDesignHead(t.db, design.id))!.needsYouCount).toBe(1);
    expect((await startRunner(t, design.id)).session.openQuestions).toEqual([id]);
  });

  test("a withdrawal closes open questions once, and leaves another design's", async () => {
    const one = await sample();
    const two = await sample();
    const id = newId("q");
    await send(one.runner, "POST", "/questions", plan(id));
    await send(two.runner, "POST", "/questions", plan(id));

    const withdrawn = await send(one.runner, "POST", "/questions/withdraw", { ids: [id] });
    const again = await send(one.runner, "POST", "/questions/withdraw", { ids: [id] });

    expect([withdrawn.body, again.body]).toEqual([{ withdrawn: 1 }, { withdrawn: 0 }]);
    expect((await getDesignHead(t.db, one.design.id))!.needsYouCount).toBe(0);
    expect((await getQuestion(t.db, { designId: two.design.id, id }))!.status).toBe("open");
    // Raising it again after it closed changes nothing, and says so.
    expect((await send(one.runner, "POST", "/questions", plan(id))).body.status).toBe("cancelled");
  });

  test("a kind the runner does not raise, or an id it did not make, is refused", async () => {
    const { runner } = await sample();
    for (const body of [
      { id: newId("q"), kind: "secret", payload: { name: "KEY" } },
      { ...plan("q_1"), id: "q_1" },
      { id: newId("q"), kind: "question", payload: { questions: [] } },
    ]) {
      expect((await send(runner, "POST", "/questions", body)).status).toBe(400);
    }
  });
});

describe("uploads", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  const declared = (purpose: string, name: string, contentType: string, body: Uint8Array) => ({
    purpose,
    name,
    contentType,
    size: body.byteLength,
    sha256: createHash("sha256").update(body).digest("hex"),
  });
  const put = (
    file: { put: { url: string; headers: Record<string, string> } },
    body: Uint8Array<ArrayBuffer>,
  ) => t.storage.fetch(file.put.url, { method: "PUT", headers: file.put.headers, body });
  const svg = bytes('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

  test("an asset is presigned, put, completed and served as the design's file", async () => {
    const { design, runner } = await sample();
    const logo = bytes("\x89PNG not really");
    const signed = await send(runner, "POST", "/uploads", {
      files: [declared("asset", "logo.png", "image/png", logo)],
    });
    expect(signed.status).toBe(200);
    const [file] = signed.body.files;
    expect(file.expiresAt).toBe(new Date(t.clock.now() + 600_000).toISOString());

    expect((await put(file, logo)).status).toBe(200);
    const done = await send(runner, "POST", "/uploads/complete", { ids: [file.id] });
    const again = await send(runner, "POST", "/uploads/complete", { ids: [file.id] });

    const assetKey = await getDesignAssetKey(t.db, design.id);
    const served = {
      id: file.id,
      ref: "assets/logo.png",
      url: `${TEST_ASSETS_URL}/${assetKey}/assets/logo.png`,
    };
    expect(done.body).toEqual({ files: [served] });
    expect(again.body).toEqual(done.body);
    expect(t.storage.objects.get(`${assetKey}/assets/logo.png`)!.headers).toMatchObject({
      "content-type": "image/png",
    });
    expect(
      await listAssets(t.db, { designId: design.id, paths: ["assets/logo.png"] }),
    ).toMatchObject([{ contentType: "image/png", size: logo.byteLength, createdByUserId: null }]);
  });

  test("the address takes exactly the declared bytes, and only for ten minutes", async () => {
    const { runner } = await sample();
    const logo = bytes("the real bytes");
    const signed = await send(runner, "POST", "/uploads", {
      files: [
        declared("asset", "a.png", "image/png", logo),
        declared("asset", "b.png", "image/png", logo),
      ],
    });
    const [first, second] = signed.body.files;

    expect((await put(first, bytes("the fake bytes"))).status).toBe(400);
    expect((await put(first, bytes("more than the real bytes"))).status).toBe(403);
    const retyped = {
      put: { ...first.put, headers: { ...first.put.headers, "content-type": "text/html" } },
    };
    expect((await put(retyped, logo)).status).toBe(403);
    t.clock.advance(601_000);
    expect((await put(second, logo)).status).toBe(403);
  });

  test("completing bytes that never arrived, or another design's upload, is not found", async () => {
    const { runner } = await sample();
    const other = await sample();
    const logo = bytes("x");
    const signed = await send(runner, "POST", "/uploads", {
      files: [declared("asset", "x.png", "image/png", logo)],
    });
    const [file] = signed.body.files;

    const early = await send(runner, "POST", "/uploads/complete", { ids: [file.id] });
    await put(file, logo);
    const elsewhere = await send(other.runner, "POST", "/uploads/complete", { ids: [file.id] });

    expect([early.status, early.body.error.code]).toEqual([404, "not_found"]);
    expect([elsewhere.status, elsewhere.body.error.code]).toEqual([404, "not_found"]);
  });

  test("an object of the right size that storage holds without the declared checksum is not the upload", async () => {
    const { design, runner } = await sample();
    const logo = bytes("x");
    const signed = await send(runner, "POST", "/uploads", {
      files: [declared("asset", "x.png", "image/png", logo)],
    });
    const [file] = signed.body.files;
    const key = `${await getDesignAssetKey(t.db, design.id)}/assets/x.png`;
    // As something other than the signed PUT would leave it.
    t.storage.objects.set(key, { body: logo, headers: {}, sha256: null });

    const completed = await send(runner, "POST", "/uploads/complete", { ids: [file.id] });

    expect([completed.status, completed.body.error.code]).toEqual([404, "not_found"]);
  });

  test("what may be uploaded is limited by kind and size, with errors that say so", async () => {
    const { runner } = await sample();
    const ask = async (file: unknown) => {
      const { status, body } = await send(runner, "POST", "/uploads", { files: [file] });
      return [status, body.error?.code];
    };
    const one = bytes("x");

    expect(await ask(declared("asset", "page.html", "text/html", one))).toEqual([
      415,
      "unsupported_file_type",
    ]);
    expect(await ask(declared("asset", "logo.png", "image/svg+xml", one))).toEqual([
      415,
      "unsupported_file_type",
    ]);
    expect(await ask(declared("export", "font.woff2", "font/woff2", one))).toEqual([
      415,
      "unsupported_file_type",
    ]);
    expect(await ask(declared("preview", "other.png", "image/png", one))).toEqual([
      400,
      "invalid_request",
    ]);
    expect(await ask(declared("asset", "../up.png", "image/png", one))).toEqual([
      400,
      "invalid_request",
    ]);
    expect(
      await ask({ ...declared("asset", "big.mp4", "video/mp4", one), size: 21 * 1024 * 1024 }),
    ).toEqual([413, "file_too_large"]);
  });

  test("an SVG is stored to be saved, not shown, when opened by itself", async () => {
    const { design, runner } = await sample();
    const signed = await send(runner, "POST", "/uploads", {
      files: [declared("asset", "icon.svg", "image/svg+xml", svg)],
    });
    const [file] = signed.body.files;

    expect(file.put.headers["content-disposition"]).toBe("attachment");
    expect((await put(file, svg)).status).toBe(200);
    const assetKey = await getDesignAssetKey(t.db, design.id);
    expect(t.storage.objects.get(`${assetKey}/assets/icon.svg`)!.headers).toMatchObject({
      "content-type": "image/svg+xml",
      "content-disposition": "attachment",
    });
  });

  test("previews are completed with the seq they show, and replace the ones before", async () => {
    const { design, runner } = await sample();
    await call(t, runner.headers, "POST", `/v1/designs/${design.id}/ops`, {
      ops: [
        { id: "op_1", op: { op: "note", name: "a", content: "1" } },
        { id: "op_2", op: { op: "note", name: "a", content: "2" } },
      ],
    });
    const assetKey = await getDesignAssetKey(t.db, design.id);
    const upload = async (seq: number | undefined) => {
      const light = bytes(`light ${seq}`);
      const dark = bytes(`dark ${seq}`);
      const signed = await send(runner, "POST", "/uploads", {
        files: [
          declared("preview", "light.png", "image/png", light),
          declared("preview", "dark.png", "image/png", dark),
        ],
      });
      await put(signed.body.files[0], light);
      await put(signed.body.files[1], dark);
      const ids = signed.body.files.map((f: { id: string }) => f.id);
      return send(runner, "POST", "/uploads/complete", {
        ids,
        ...(seq === undefined ? {} : { seq }),
      });
    };

    expect((await upload(undefined)).status).toBe(400);
    expect((await upload(3)).status).toBe(400);
    const first = await upload(1);
    expect(first.body.files.map((f: { url: string }) => f.url)).toEqual([
      `${TEST_ASSETS_URL}/${assetKey}/previews/1-light.png`,
      `${TEST_ASSETS_URL}/${assetKey}/previews/1-dark.png`,
    ]);
    expect((await getDesignHead(t.db, design.id))!.previewSeq).toBe(1);

    await upload(2);
    await t.backgroundDone();
    expect((await getDesignHead(t.db, design.id))!.previewSeq).toBe(2);
    expect(
      [...t.storage.objects.keys()].filter((key) => key.startsWith(`${assetKey}/`)).sort(),
    ).toEqual([`${assetKey}/previews/2-dark.png`, `${assetKey}/previews/2-light.png`]);
  });
});

describe("git credentials", () => {
  const github = (path: string) => ({ protocol: "https", host: "github.com", path });

  test("a one-hour token for the design's repository only, reused while it has ten minutes left", async () => {
    const { runner } = await sample();
    const asked = t.github.installationTokenRequests.length;

    const first = await send(runner, "POST", "/git-credential", github(`${ws.repo.fullName}.git`));
    const again = await send(
      runner,
      "POST",
      "/git-credential",
      github(ws.repo.fullName.toUpperCase()),
    );

    expect(first.body).toEqual({
      username: "x-access-token",
      password: expect.stringMatching(/^ghs_/),
      expiresAt: new Date(t.clock.now() + 3_600_000).toISOString(),
    });
    expect(again.body).toEqual(first.body);
    expect(t.github.installationTokenRequests.slice(asked)).toEqual([
      {
        installationId: ws.installationId,
        body: {
          repository_ids: [ws.repo.githubRepoId],
          permissions: { contents: "write", metadata: "read" },
        },
      },
    ]);
    expect(JSON.stringify(t.logs)).not.toContain(first.body.password);

    t.clock.advance(51 * 60_000);
    const fresh = await send(runner, "POST", "/git-credential", github(`${ws.repo.fullName}.git`));
    expect(fresh.body.password).not.toBe(first.body.password);
  });

  test("an erased token is not handed out again", async () => {
    const { design, runner } = await sample();
    const ask = github(`${ws.repo.fullName}.git`);
    const first = await send(runner, "POST", "/git-credential", ask);

    const erased = await send(runner, "POST", "/git-credential/erase", {
      ...ask,
      reason: "GitHub's git answered 404 to the runner's check, 4 times",
    });
    await send(runner, "POST", "/git-credential/erase", ask);
    const next = await send(runner, "POST", "/git-credential", ask);

    expect(erased.status).toBe(204);
    expect(next.body.password).not.toBe(first.body.password);
    // Which token was given back, and why, by its fingerprint.
    expect(t.logs.filter((line) => line.event === "git_credential_erased").slice(-2)).toEqual([
      expect.objectContaining({
        designId: design.id,
        fingerprint: fingerprint(first.body.password),
        reason: "GitHub's git answered 404 to the runner's check, 4 times",
      }),
      expect.objectContaining({ fingerprint: null, reason: null }),
    ]);
  });

  test("every token git is handed is logged: minted or reused, its expiry and what GitHub granted, never the token", async () => {
    const { design, runner } = await sample();
    const ask = github(`${ws.repo.fullName}.git`);
    await send(runner, "POST", "/git-credential/erase", ask);
    const first = await send(runner, "POST", "/git-credential", ask);
    await send(runner, "POST", "/git-credential", ask);

    const lines = t.logs.filter((line) => line.event === "git_credential").slice(-2);
    const said = {
      designId: design.id,
      fingerprint: fingerprint(first.body.password),
      expiresAt: first.body.expiresAt,
      permissions: { contents: "write", metadata: "read" },
      repositoryIds: [ws.repo.githubRepoId],
    };
    expect(lines).toEqual([
      expect.objectContaining({ ...said, minted: true }),
      expect.objectContaining({ ...said, minted: false }),
    ]);
    expect(JSON.stringify(t.logs)).not.toContain(first.body.password);
  });

  test("what the runner saw of git and GitHub is logged here, under the design: its checks and pushes", async () => {
    const { design, runner } = await sample();
    const refused = await send(runner, "POST", "/git-report", {
      name: "git_credential_refused",
      fields: { fingerprint: "0123456789ab", status: 404, check: 2 },
    });
    expect(refused.status).toBe(204);
    await send(runner, "POST", "/git-report", {
      name: "git_push",
      fields: {
        branch: "pz/hero",
        attempt: 0,
        ok: false,
        kind: "transient",
        said: "x".repeat(900),
      },
    });
    expect(t.logs.findLast((line) => line.event === "git_credential_refused")).toMatchObject({
      designId: design.id,
      from: "runner",
      fingerprint: "0123456789ab",
      status: 404,
      check: 2,
    });
    const pushed = t.logs.findLast((line) => line.event === "git_push");
    expect(pushed).toMatchObject({ designId: design.id, ok: false, kind: "transient" });
    expect(String(pushed?.said).length).toBe(500);

    // Only names it knows, and only short scalar fields.
    const bad = async (body: unknown) => (await send(runner, "POST", "/git-report", body)).status;
    expect(await bad({ name: "anything", fields: {} })).toBe(400);
    expect(await bad({ name: "git_push", fields: { nested: { a: 1 } } })).toBe(400);
  });

  test("a token GitHub grants less than contents: write is minted again, and never handed to git", async () => {
    const { runner } = await sample();
    const ask = github(`${ws.repo.fullName}.git`);
    await send(runner, "POST", "/git-credential/erase", ask);
    const asked = t.github.installationTokenRequests.length;

    t.github.grantNext.push({ metadata: "read" });
    const second = await send(runner, "POST", "/git-credential", ask);
    expect(second.status).toBe(200);
    expect(t.github.installationTokenRequests.length - asked).toBe(2);
    expect(t.logs.findLast((line) => line.event === "git_credential")).toMatchObject({
      permissions: { contents: "write", metadata: "read" },
    });

    await send(runner, "POST", "/git-credential/erase", ask);
    t.github.grantNext.push({ metadata: "read" }, { contents: "read", metadata: "read" });
    const refused = await send(runner, "POST", "/git-credential", ask);
    expect([refused.status, refused.body.error.code]).toEqual([502, "upstream_unavailable"]);
  });

  test("any other host, path or protocol is forbidden, Scratch has none, and GitHub failing is upstream", async () => {
    const { runner } = await sample();
    const scratch = await sample("scratch");
    const code = async (who: StartedRunner, body: unknown, path = "/git-credential") => {
      const answer = await send(who, "POST", path, body);
      return [answer.status, answer.body.error.code];
    };

    expect(
      await code(runner, { ...github(`${ws.repo.fullName}.git`), host: "gitlab.com" }),
    ).toEqual([403, "forbidden"]);
    expect(await code(runner, { ...github(`${ws.repo.fullName}.git`), protocol: "http" })).toEqual([
      403,
      "forbidden",
    ]);
    expect(await code(runner, github("north/elsewhere.git"))).toEqual([403, "forbidden"]);
    expect(await code(runner, github("north/elsewhere.git"), "/git-credential/erase")).toEqual([
      403,
      "forbidden",
    ]);
    expect(await code(scratch.runner, github(`${ws.repo.fullName}.git`))).toEqual([
      404,
      "not_found",
    ]);
    // Nothing kept to reuse, so GitHub is asked, and fails.
    await send(runner, "POST", "/git-credential/erase", github(`${ws.repo.fullName}.git`));
    t.github.failNext(`/app/installations/${ws.installationId}/access_tokens`);
    expect(await code(runner, github(`${ws.repo.fullName}.git`))).toEqual([
      502,
      "upstream_unavailable",
    ]);
  });
});

describe("usage", () => {
  test("each turn is recorded once, by model", async () => {
    const { design, runner } = await sample();
    const turn = {
      id: crypto.randomUUID(),
      claudeSessionId: "sess-1",
      at: new Date(t.clock.now()).toISOString(),
      models: [
        {
          model: "claude-opus-5-5",
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: 30,
          cacheWriteTokens: 40,
          costUsd: 0.0125,
        },
      ],
    };

    expect((await send(runner, "POST", "/usage", { turns: [turn] })).body).toEqual({ recorded: 1 });
    expect((await send(runner, "POST", "/usage", { turns: [turn] })).body).toEqual({ recorded: 0 });
    const rows = (await t.db.execute(
      `select cost_microusd, credits, payer from usage_events where design_id = '${design.id}'`,
    )) as unknown as { rows: { cost_microusd: string | number; payer: string }[] };
    expect(rows.rows.map((row) => [Number(row.cost_microusd), row.payer])).toEqual([
      [12_500, "own_plan"],
    ]);
  });
});

test("no event reaches a design that is not the runner's, whatever it names", async () => {
  const { runner } = await sample();
  const other = await designIn(t, ws, "maya", emptyDoc("Other"));
  const event = await say(other.id, "theirs");
  await createRunnerToken(t.db, { designId: other.id, ttlSeconds: 60 });

  const claimed = await send(runner, "POST", "/events/claim", claim());
  const acked = await send(runner, "POST", "/events/ack", {
    ids: [event.id],
    claudeSessionId: null,
  });

  expect(claimed.body.events).toEqual([]);
  expect(acked.body).toEqual({ acked: 0 });
  expect((await feedOf(t.db, other.id))[0]!.deliveredAt).toBeNull();
});
