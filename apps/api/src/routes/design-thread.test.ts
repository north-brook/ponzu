import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { sampleDoc } from "@ponzu/core/fixtures";
import { getDesignAssetKey, getDesignHead, getQuestion, listThreadItems, newId } from "@ponzu/db";
import { feedOf } from "@ponzu/db/testing";
import {
  call,
  designIn,
  designWithRunner,
  type StartedRunner,
  type Workspace,
  workspaceWithRepo,
} from "../testing/designs.ts";
import { createTestApp, TEST_ASSETS_URL, type TestApp } from "../testing/index.ts";

let t: TestApp;
let ws: Workspace;
beforeAll(async () => {
  t = await createTestApp();
  ws = await workspaceWithRepo(t, { maya: "write", ines: "read", omar: "none" });
});
afterAll(() => t.close());

const as = (login: string) => ws.people[login]!.headers;
const maya = () => ({ id: ws.people.maya!.userId, name: "Maya", login: "maya" });
const sample = () => designWithRunner(t, ws, "maya", sampleDoc());
const wakesOf = async (designId: string) => {
  const result = await t.db.execute(
    `select payload from jobs where kind = 'sandbox.wake' and key = '${designId}'`,
  );
  return (result as unknown as { rows: { payload: unknown }[] }).rows.map((row) => row.payload);
};

/** Gives the design an awake sandbox the API can reach, as the orchestrator will record one. */
async function awake(designId: string) {
  const sandboxId = newId("sbx");
  const token = await t.deps.vault.seal("port-token", {
    column: "sandboxes.encrypted_address_token",
    row: sandboxId,
  });
  await t.db.execute(
    `insert into sandboxes (id, design_id, provider, provider_id, state, address, encrypted_address_token, awake_since)
     values ('${sandboxId}', '${designId}', 'boat', '${sandboxId}', 'awake', 'https://sbx.test', '${token}', now())`,
  );
  await t.db.execute(`update designs set sandbox_id = '${sandboxId}' where id = '${designId}'`);
}

describe("messages", () => {
  test("a message is a thread item and a `now` event, and asks for the design's sandbox", async () => {
    const { design } = await sample();

    const { status, body } = await call(
      t,
      as("maya"),
      "POST",
      `/v1/designs/${design.id}/messages`,
      {
        text: "  Make the hero blue  ",
      },
    );

    expect(status).toBe(201);
    expect(body).toEqual({
      id: expect.stringMatching(/^ti_/),
      seq: expect.any(Number),
      at: new Date(body.at).toISOString(),
      streaming: false,
      kind: "message",
      payload: { text: "Make the hero blue", from: maya() },
    });
    expect(await listThreadItems(t.db, { designId: design.id })).toMatchObject([{ id: body.id }]);
    expect((await feedOf(t.db, design.id)).map((e) => [e.kind, e.priority, e.payload])).toEqual([
      ["message", "now", { text: "Make the hero blue" }],
    ]);
    expect(await wakesOf(design.id)).toEqual([{ designId: design.id, reason: "message" }]);
  });

  test("a second message while a wake waits records no second wake, and an awake runner is poked", async () => {
    const { design } = await sample();
    await awake(design.id);
    const pokes = t.poke.pokes.length;

    for (const text of ["one", "two"]) {
      await call(t, as("maya"), "POST", `/v1/designs/${design.id}/messages`, { text });
    }
    await t.backgroundDone();

    expect(await wakesOf(design.id)).toHaveLength(1);
    expect(t.poke.pokes.slice(pokes)).toEqual([
      { url: "https://sbx.test", token: "port-token" },
      { url: "https://sbx.test", token: "port-token" },
    ]);
  });

  test("a runner that cannot be poked does not fail the message", async () => {
    const { design } = await sample();
    await awake(design.id);
    t.poke.failing = true;
    try {
      const { status } = await call(t, as("maya"), "POST", `/v1/designs/${design.id}/messages`, {
        text: "hello",
      });
      await t.backgroundDone();
      expect(status).toBe(201);
      expect(t.logs.some((line) => line.event === "background_failed")).toBe(true);
    } finally {
      t.poke.failing = false;
    }
  });

  test("someone who may only look cannot message, someone outside cannot see the design, and nothing is empty", async () => {
    const { design } = await sample();
    const post = (login: string, body: unknown) =>
      call(t, as(login), "POST", `/v1/designs/${design.id}/messages`, body);

    const reader = await post("ines", { text: "hi" });
    const stranger = await post("omar", { text: "hi" });
    const empty = await post("maya", { text: "   " });

    expect([reader.status, reader.body.error.code]).toEqual([403, "forbidden"]);
    expect([stranger.status, stranger.body.error.code]).toEqual([404, "not_found"]);
    expect([empty.status, empty.body.error.code]).toEqual([400, "invalid_request"]);
    expect(await feedOf(t.db, design.id)).toEqual([]);
  });
});

describe("answers", () => {
  const HEADLINE = {
    header: "Headline",
    question: "Which way?",
    options: [
      { label: "Shorten it", description: "Two lines." },
      { label: "Let it wrap", description: "Three lines." },
    ],
    multiSelect: false,
  };
  const raise = async (runner: StartedRunner, body: unknown) => {
    const id = newId("q");
    await call(t, runner.headers, "POST", "/v1/runner/questions", { id, ...(body as object) });
    return id;
  };
  const answer = (login: string, designId: string, id: string, body: unknown) =>
    call(t, as(login), "POST", `/v1/designs/${designId}/questions/${id}/answer`, body);

  test("the first answer wins, and becomes an `answer` event carrying what was asked", async () => {
    const { design, runner } = await sample();
    const payload = { questions: [HEADLINE] };
    const id = await raise(runner, { kind: "question", payload });

    const first = await answer("maya", design.id, id, { answers: { "Which way?": "Shorten it" } });
    const second = await answer("maya", design.id, id, {
      answers: { "Which way?": "Let it wrap" },
    });

    expect([first.status, first.body]).toEqual([200, { id, status: "answered" }]);
    expect([second.status, second.body.error.code]).toEqual([409, "question_closed"]);
    expect((await getDesignHead(t.db, design.id))!.needsYouCount).toBe(0);
    expect(
      (await feedOf(t.db, design.id)).map((e) => [e.kind, e.priority, e.userId, e.payload]),
    ).toEqual([
      [
        "answer",
        "now",
        ws.people.maya!.userId,
        {
          questionId: id,
          question: { kind: "question", payload },
          answers: { "Which way?": "Shorten it" },
        },
      ],
    ]);
    expect(await wakesOf(design.id)).toEqual([{ designId: design.id, reason: "answer" }]);
  });

  test("a plan or a permission is approved or not, with a note", async () => {
    const { design, runner } = await sample();
    const id = await raise(runner, { kind: "plan", payload: { plan: "1. Draw" } });

    const missing = await answer("maya", design.id, id, { note: "Hmm" });
    const given = await answer("maya", design.id, id, { approved: false, note: "Not yet" });

    expect([missing.status, missing.body.error.code]).toEqual([400, "invalid_request"]);
    expect(given.status).toBe(200);
    expect((await feedOf(t.db, design.id))[0]!.payload).toMatchObject({
      approved: false,
      note: "Not yet",
    });
  });

  test("an answer to what was not asked, to a withdrawn question, or to none is refused", async () => {
    const { design, runner } = await sample();
    const asked = await raise(runner, { kind: "question", payload: { questions: [HEADLINE] } });
    const withdrawn = await raise(runner, { kind: "plan", payload: { plan: "x" } });
    await call(t, runner.headers, "POST", "/v1/runner/questions/withdraw", { ids: [withdrawn] });
    const code = async (id: string, body: unknown, login = "maya") => {
      const { status, body: answered } = await answer(login, design.id, id, body);
      return [status, answered.error.code];
    };

    expect(await code(asked, { answers: { "Something else?": "Yes" } })).toEqual([
      400,
      "invalid_request",
    ]);
    expect(await code(asked, { answers: {} })).toEqual([400, "invalid_request"]);
    expect(await code(withdrawn, { approved: true })).toEqual([409, "question_closed"]);
    expect(await code("q_0000000000000000", { approved: true })).toEqual([404, "not_found"]);
    expect(await code(asked, { answers: { "Which way?": "x" } }, "ines")).toEqual([
      403,
      "forbidden",
    ]);
    expect(await feedOf(t.db, design.id)).toEqual([]);
  });

  test("an answer to several questions answers every one of them, and no others", async () => {
    const { design, runner } = await sample();
    const size = { ...HEADLINE, header: "Size", question: "How big?" };
    const asked = await raise(runner, {
      kind: "question",
      payload: { questions: [HEADLINE, size] },
    });

    const partial = await answer("maya", design.id, asked, {
      answers: { "Which way?": "Shorten it" },
    });
    const extra = await answer("maya", design.id, asked, {
      answers: { "Which way?": "Shorten it", "How big?": "Big", "Why?": "Because" },
    });

    expect([partial.status, partial.body.error]).toEqual([
      400,
      { code: "invalid_request", message: "Answer every question: How big?" },
    ]);
    expect([extra.status, extra.body.error.code]).toEqual([400, "invalid_request"]);
    expect((await getQuestion(t.db, { designId: design.id, id: asked }))!.status).toBe("open");
    const both = { "Which way?": "Shorten it", "How big?": "Big" };
    expect((await answer("maya", design.id, asked, { answers: both })).status).toBe(200);
  });

  test("a question is answered through its own design only", async () => {
    const one = await sample();
    const other = await sample();
    const id = await raise(one.runner, { kind: "plan", payload: { plan: "x" } });

    const reached = await answer("maya", other.design.id, id, { approved: true });

    expect(reached.status).toBe(404);
  });
});

describe("stopping", () => {
  test("a stop is a `now` event from the person, and the runner's stopped notice names them", async () => {
    const { design, runner } = await sample();

    const stopped = await call(t, as("maya"), "POST", `/v1/designs/${design.id}/stop`);
    const reader = await call(t, as("ines"), "POST", `/v1/designs/${design.id}/stop`);

    expect(stopped.status).toBe(204);
    expect(reader.status).toBe(403);
    const [stop] = await feedOf(t.db, design.id);
    expect(stop).toMatchObject({ kind: "stop", priority: "now", payload: {}, userId: maya().id });
    // A stopped sandbox is running nothing to stop: a stop records no wake.
    expect(await wakesOf(design.id)).toEqual([]);

    await call(t, runner.headers, "POST", "/v1/runner/thread", {
      items: [
        {
          id: newId("ti"),
          kind: "notice",
          streaming: false,
          payload: { type: "stopped", eventId: stop!.id },
        },
      ],
    });
    const [notice] = await listThreadItems(t.db, { designId: design.id });
    expect(notice!.payload).toEqual({ type: "stopped", by: maya() });
  });
});

describe("the thread", () => {
  test("is read a page at a time, newest first, by anyone who may open the design", async () => {
    const { design } = await sample();
    for (const text of ["1", "2", "3", "4", "5"]) {
      await call(t, as("maya"), "POST", `/v1/designs/${design.id}/messages`, { text });
    }
    const page = (query: string, login = "ines") =>
      call(t, as(login), "GET", `/v1/designs/${design.id}/thread${query}`);
    const texts = (items: { payload: { text: string } }[]) => items.map((i) => i.payload.text);

    const newest = await page("?limit=2");
    const older = await page(`?limit=2&before=${newest.body.items[0].seq}`);
    const all = await page("");
    const stranger = await page("", "omar");

    expect(texts(newest.body.items)).toEqual(["4", "5"]);
    expect(texts(older.body.items)).toEqual(["2", "3"]);
    expect(texts(all.body.items)).toEqual(["1", "2", "3", "4", "5"]);
    expect(newest.body.items[0]).toMatchObject({ kind: "message", streaming: false });
    expect(stranger.status).toBe(404);
    expect((await page("?limit=51")).status).toBe(400);
  });
});

describe("a person's uploads", () => {
  const png = new TextEncoder().encode("\x89PNG pasted");
  const declared = (name: string, contentType: string, body = png) => ({
    name,
    contentType,
    size: body.byteLength,
    sha256: createHash("sha256").update(body).digest("hex"),
  });

  test("an image is uploaded beside the design's files, never over one, and attached to a message", async () => {
    const { design } = await sample();
    const signed = await call(t, as("maya"), "POST", `/v1/designs/${design.id}/uploads`, {
      files: [declared("logo.png", "image/png")],
    });
    const [file] = signed.body.files;
    await t.storage.fetch(file.put.url, { method: "PUT", headers: file.put.headers, body: png });

    const done = await call(t, as("maya"), "POST", `/v1/designs/${design.id}/uploads/complete`, {
      ids: [file.id],
    });

    const assetKey = await getDesignAssetKey(t.db, design.id);
    const [completed] = done.body.files;
    expect(completed.ref).toMatch(/^assets\/logo-[0-9a-z]{6}\.png$/);
    expect(completed.url).toBe(`${TEST_ASSETS_URL}/${assetKey}/${completed.ref}`);

    const message = await call(t, as("maya"), "POST", `/v1/designs/${design.id}/messages`, {
      text: "Use this",
      attachments: [completed.ref],
    });
    expect(message.body.payload).toEqual({
      text: "Use this",
      from: maya(),
      attachments: [{ ref: completed.ref, contentType: "image/png" }],
    });
    expect((await feedOf(t.db, design.id))[0]!.payload).toEqual({
      text: "Use this",
      attachments: [{ ref: completed.ref, contentType: "image/png" }],
    });
  });

  test("an attachment must be one of the design's files", async () => {
    const { design } = await sample();

    const { status, body } = await call(
      t,
      as("maya"),
      "POST",
      `/v1/designs/${design.id}/messages`,
      {
        text: "Use this",
        attachments: ["assets/nothing.png"],
      },
    );

    expect([status, body.error.code]).toEqual([400, "invalid_request"]);
  });

  test("only images, only by someone who can write, and only their own uploads are completed", async () => {
    const { design, runner } = await sample();
    const font = await call(t, as("maya"), "POST", `/v1/designs/${design.id}/uploads`, {
      files: [declared("brand.woff2", "font/woff2")],
    });
    const reader = await call(t, as("ines"), "POST", `/v1/designs/${design.id}/uploads`, {
      files: [declared("logo.png", "image/png")],
    });
    const theirs = await call(t, runner.headers, "POST", "/v1/runner/uploads", {
      files: [{ purpose: "asset", ...declared("logo.png", "image/png") }],
    });
    const [file] = theirs.body.files;
    await t.storage.fetch(file.put.url, { method: "PUT", headers: file.put.headers, body: png });
    const completed = await call(
      t,
      as("maya"),
      "POST",
      `/v1/designs/${design.id}/uploads/complete`,
      {
        ids: [file.id],
      },
    );

    expect([font.status, font.body.error.code]).toEqual([415, "unsupported_file_type"]);
    expect([reader.status, reader.body.error.code]).toEqual([403, "forbidden"]);
    expect([completed.status, completed.body.error.code]).toEqual([404, "not_found"]);
  });

  test("a design in another workspace is not found, whoever asks", async () => {
    const other = await designIn(
      t,
      await workspaceWithRepo(t, { kim: "write" }),
      "kim",
      sampleDoc(),
    );

    const { status } = await call(t, as("maya"), "POST", `/v1/designs/${other.id}/uploads`, {
      files: [declared("logo.png", "image/png")],
    });

    expect(status).toBe(404);
  });
});
