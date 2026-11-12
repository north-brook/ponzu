import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { sampleDoc } from "@ponzu/core/fixtures";
import { getCanvasAssetKey, getCanvasHead, getQuestion, listThreadItems, newId } from "@ponzu/db";
import { feedOf } from "@ponzu/db/testing";
import { portBinding } from "../sandboxes/environment.ts";
import {
  call,
  canvasIn,
  canvasWithRunner,
  type StartedRunner,
  type Workspace,
  workspaceWithRepo,
} from "../testing/canvases.ts";
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
const sample = () => canvasWithRunner(t, ws, "maya", sampleDoc());
const wakesOf = async (canvasId: string) => {
  const result = await t.db.execute(
    `select payload from jobs where kind = 'sandbox.wake' and key = '${canvasId}'`,
  );
  return (result as unknown as { rows: { payload: unknown }[] }).rows.map((row) => row.payload);
};

/** Gives the canvas an awake sandbox the API can reach, as the orchestrator will record one. */
async function awake(canvasId: string) {
  const token = await t.deps.vault.seal("port-token", portBinding(canvasId));
  await t.db.execute(
    `insert into sandboxes (canvas_id, state, session_id, address, encrypted_port_token, awake_since)
     values ('${canvasId}', 'awake', 'sbx_session', 'https://sbx.test', '${token}', now())`,
  );
}

describe("messages", () => {
  test("a message is a thread item and a `now` event, and asks for the canvas's sandbox", async () => {
    const { canvas } = await sample();

    const { status, body } = await call(
      t,
      as("maya"),
      "POST",
      `/v1/canvases/${canvas.id}/messages`,
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
    expect(await listThreadItems(t.db, { canvasId: canvas.id })).toMatchObject([{ id: body.id }]);
    expect((await feedOf(t.db, canvas.id)).map((e) => [e.kind, e.priority, e.payload])).toEqual([
      ["message", "now", { text: "Make the hero blue" }],
    ]);
    expect(await wakesOf(canvas.id)).toEqual([{ canvasId: canvas.id, reason: "message" }]);
  });

  test("each message pokes an awake runner", async () => {
    const { canvas } = await sample();
    await awake(canvas.id);
    const pokes = t.poke.pokes.length;

    for (const text of ["one", "two"]) {
      await call(t, as("maya"), "POST", `/v1/canvases/${canvas.id}/messages`, { text });
    }
    await t.backgroundDone();

    expect(t.poke.pokes.slice(pokes)).toEqual([
      { url: "https://sbx.test", token: "port-token" },
      { url: "https://sbx.test", token: "port-token" },
    ]);
  });

  test("a runner that cannot be poked does not fail the message", async () => {
    const { canvas } = await sample();
    await awake(canvas.id);
    t.poke.failing = true;
    try {
      const { status } = await call(t, as("maya"), "POST", `/v1/canvases/${canvas.id}/messages`, {
        text: "hello",
      });
      await t.backgroundDone();
      expect(status).toBe(201);
      expect(t.logs.some((line) => line.event === "background_failed")).toBe(true);
    } finally {
      t.poke.failing = false;
    }
  });

  test("someone who may only look cannot message, someone outside cannot see the canvas, and nothing is empty", async () => {
    const { canvas } = await sample();
    const post = (login: string, body: unknown) =>
      call(t, as(login), "POST", `/v1/canvases/${canvas.id}/messages`, body);

    const reader = await post("ines", { text: "hi" });
    const stranger = await post("omar", { text: "hi" });
    const empty = await post("maya", { text: "   " });

    expect([reader.status, reader.body.error.code]).toEqual([403, "forbidden"]);
    expect([stranger.status, stranger.body.error.code]).toEqual([404, "not_found"]);
    expect([empty.status, empty.body.error.code]).toEqual([400, "invalid_request"]);
    expect(await feedOf(t.db, canvas.id)).toEqual([]);
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
  const answer = (login: string, canvasId: string, id: string, body: unknown) =>
    call(t, as(login), "POST", `/v1/canvases/${canvasId}/questions/${id}/answer`, body);

  test("the first answer wins, and becomes an `answer` event carrying what was asked", async () => {
    const { canvas, runner } = await sample();
    const payload = { questions: [HEADLINE] };
    const id = await raise(runner, { kind: "question", payload });

    const first = await answer("maya", canvas.id, id, { answers: { "Which way?": "Shorten it" } });
    const second = await answer("maya", canvas.id, id, {
      answers: { "Which way?": "Let it wrap" },
    });

    expect([first.status, first.body]).toEqual([200, { id, status: "answered" }]);
    expect([second.status, second.body.error.code]).toEqual([409, "question_closed"]);
    // The one who got there second is told who answered.
    expect(second.body.error.details).toEqual({
      answeredBy: { id: ws.people.maya!.userId, name: expect.any(String), login: "maya" },
    });
    expect((await getCanvasHead(t.db, canvas.id))!.needsYouCount).toBe(0);
    expect(
      (await feedOf(t.db, canvas.id)).map((e) => [e.kind, e.priority, e.userId, e.payload]),
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
    expect(await wakesOf(canvas.id)).toEqual([{ canvasId: canvas.id, reason: "answer" }]);
  });

  test("a plan or a permission is approved or not, with a note", async () => {
    const { canvas, runner } = await sample();
    const id = await raise(runner, { kind: "plan", payload: { plan: "1. Draw" } });

    const missing = await answer("maya", canvas.id, id, { note: "Hmm" });
    const given = await answer("maya", canvas.id, id, { approved: false, note: "Not yet" });

    expect([missing.status, missing.body.error.code]).toEqual([400, "invalid_request"]);
    expect(given.status).toBe(200);
    expect((await feedOf(t.db, canvas.id))[0]!.payload).toMatchObject({
      approved: false,
      note: "Not yet",
    });
  });

  test("an answer to what was not asked, to a withdrawn question, or to none is refused", async () => {
    const { canvas, runner } = await sample();
    const asked = await raise(runner, { kind: "question", payload: { questions: [HEADLINE] } });
    const withdrawn = await raise(runner, { kind: "plan", payload: { plan: "x" } });
    await call(t, runner.headers, "POST", "/v1/runner/questions/withdraw", { ids: [withdrawn] });
    const code = async (id: string, body: unknown, login = "maya") => {
      const { status, body: answered } = await answer(login, canvas.id, id, body);
      return [status, answered.error.code];
    };

    expect(await code(asked, { answers: { "Something else?": "Yes" } })).toEqual([
      400,
      "invalid_request",
    ]);
    expect(await code(asked, { answers: {} })).toEqual([400, "invalid_request"]);
    expect(await code(withdrawn, { approved: true })).toEqual([409, "question_closed"]);
    // Nobody answered a withdrawn one: nobody is named.
    expect(
      (await answer("maya", canvas.id, withdrawn, { approved: true })).body.error,
    ).not.toHaveProperty("details");
    expect(await code("q_0000000000000000", { approved: true })).toEqual([404, "not_found"]);
    expect(await code(asked, { answers: { "Which way?": "x" } }, "ines")).toEqual([
      403,
      "forbidden",
    ]);
    expect(await feedOf(t.db, canvas.id)).toEqual([]);
  });

  test("a question as it stands: open, then the answer that won and who gave it, to anyone who may read", async () => {
    const { canvas, runner } = await sample();
    const id = await raise(runner, { kind: "question", payload: { questions: [HEADLINE] } });
    const read = (login: string) =>
      call(t, as(login), "GET", `/v1/canvases/${canvas.id}/questions/${id}`);

    const open = await read("ines");
    await answer("maya", canvas.id, id, { answers: { "Which way?": "Let it wrap" } });
    const answered = await read("ines");
    const stranger = await read("omar");
    const none = await call(t, as("maya"), "GET", `/v1/canvases/${canvas.id}/questions/q_none`);

    expect([open.status, open.body]).toEqual([
      200,
      { id, status: "open", answer: null, answeredBy: null },
    ]);
    expect(answered.body).toEqual({
      id,
      status: "answered",
      answer: { answers: { "Which way?": "Let it wrap" } },
      answeredBy: { id: ws.people.maya!.userId, name: expect.any(String), login: "maya" },
    });
    expect(stranger.status).toBe(404);
    expect(none.status).toBe(404);
  });

  test("an answer to several questions answers every one of them, and no others", async () => {
    const { canvas, runner } = await sample();
    const size = { ...HEADLINE, header: "Size", question: "How big?" };
    const asked = await raise(runner, {
      kind: "question",
      payload: { questions: [HEADLINE, size] },
    });

    const partial = await answer("maya", canvas.id, asked, {
      answers: { "Which way?": "Shorten it" },
    });
    const extra = await answer("maya", canvas.id, asked, {
      answers: { "Which way?": "Shorten it", "How big?": "Big", "Why?": "Because" },
    });

    expect([partial.status, partial.body.error]).toEqual([
      400,
      { code: "invalid_request", message: "Answer every question: How big?" },
    ]);
    expect([extra.status, extra.body.error.code]).toEqual([400, "invalid_request"]);
    expect((await getQuestion(t.db, { canvasId: canvas.id, id: asked }))!.status).toBe("open");
    const both = { "Which way?": "Shorten it", "How big?": "Big" };
    expect((await answer("maya", canvas.id, asked, { answers: both })).status).toBe(200);
  });

  test("a question is answered through its own canvas only", async () => {
    const one = await sample();
    const other = await sample();
    const id = await raise(one.runner, { kind: "plan", payload: { plan: "x" } });

    const reached = await answer("maya", other.canvas.id, id, { approved: true });

    expect(reached.status).toBe(404);
  });
});

describe("stopping", () => {
  test("a stop is a `now` event from the person, and the runner's stopped notice names them", async () => {
    const { canvas, runner } = await sample();

    const stopped = await call(t, as("maya"), "POST", `/v1/canvases/${canvas.id}/stop`);
    const reader = await call(t, as("ines"), "POST", `/v1/canvases/${canvas.id}/stop`);

    expect(stopped.status).toBe(204);
    expect(reader.status).toBe(403);
    const [stop] = await feedOf(t.db, canvas.id);
    expect(stop).toMatchObject({ kind: "stop", priority: "now", payload: {}, userId: maya().id });
    // A stopped sandbox is running nothing to stop: a stop records no wake.
    expect(await wakesOf(canvas.id)).toEqual([]);

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
    const [notice] = await listThreadItems(t.db, { canvasId: canvas.id });
    expect(notice!.payload).toEqual({ type: "stopped", by: maya() });
  });
});

describe("the thread", () => {
  test("is read a page at a time, newest first, by anyone who may open the canvas", async () => {
    const { canvas } = await sample();
    for (const text of ["1", "2", "3", "4", "5"]) {
      await call(t, as("maya"), "POST", `/v1/canvases/${canvas.id}/messages`, { text });
    }
    const page = (query: string, login = "ines") =>
      call(t, as(login), "GET", `/v1/canvases/${canvas.id}/thread${query}`);
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

  test("an image is uploaded beside the canvas's files, never over one, and attached to a message", async () => {
    const { canvas } = await sample();
    const signed = await call(t, as("maya"), "POST", `/v1/canvases/${canvas.id}/uploads`, {
      files: [declared("logo.png", "image/png")],
    });
    const [file] = signed.body.files;
    await t.storage.fetch(file.put.url, { method: "PUT", headers: file.put.headers, body: png });

    const done = await call(t, as("maya"), "POST", `/v1/canvases/${canvas.id}/uploads/complete`, {
      ids: [file.id],
    });

    const assetKey = await getCanvasAssetKey(t.db, canvas.id);
    const [completed] = done.body.files;
    expect(completed.ref).toMatch(/^assets\/logo-[0-9a-z]{6}\.png$/);
    expect(completed.url).toBe(`${TEST_ASSETS_URL}/${assetKey}/${completed.ref}`);

    const message = await call(t, as("maya"), "POST", `/v1/canvases/${canvas.id}/messages`, {
      text: "Use this",
      attachments: [completed.ref],
    });
    expect(message.body.payload).toEqual({
      text: "Use this",
      from: maya(),
      attachments: [{ ref: completed.ref, contentType: "image/png" }],
    });
    expect((await feedOf(t.db, canvas.id))[0]!.payload).toEqual({
      text: "Use this",
      attachments: [{ ref: completed.ref, contentType: "image/png" }],
    });
  });

  test("an attachment must be one of the canvas's files", async () => {
    const { canvas } = await sample();

    const { status, body } = await call(
      t,
      as("maya"),
      "POST",
      `/v1/canvases/${canvas.id}/messages`,
      {
        text: "Use this",
        attachments: ["assets/nothing.png"],
      },
    );

    expect([status, body.error.code]).toEqual([400, "invalid_request"]);
  });

  test("only images, only by someone who can write, and only their own uploads are completed", async () => {
    const { canvas, runner } = await sample();
    const font = await call(t, as("maya"), "POST", `/v1/canvases/${canvas.id}/uploads`, {
      files: [declared("brand.woff2", "font/woff2")],
    });
    const reader = await call(t, as("ines"), "POST", `/v1/canvases/${canvas.id}/uploads`, {
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
      `/v1/canvases/${canvas.id}/uploads/complete`,
      {
        ids: [file.id],
      },
    );

    expect([font.status, font.body.error.code]).toEqual([415, "unsupported_file_type"]);
    expect([reader.status, reader.body.error.code]).toEqual([403, "forbidden"]);
    expect([completed.status, completed.body.error.code]).toEqual([404, "not_found"]);
  });

  test("a canvas in another workspace is not found, whoever asks", async () => {
    const other = await canvasIn(
      t,
      await workspaceWithRepo(t, { kim: "write" }),
      "kim",
      sampleDoc(),
    );

    const { status } = await call(t, as("maya"), "POST", `/v1/canvases/${other.id}/uploads`, {
      files: [declared("logo.png", "image/png")],
    });

    expect(status).toBe(404);
  });
});

describe("a comment's picture", () => {
  const webp = (theme: string) => new TextEncoder().encode(`RIFF WEBP ${theme}`);
  const declared = (name: string, body: Uint8Array, contentType = "image/webp") => ({
    name,
    contentType,
    size: body.byteLength,
    sha256: createHash("sha256").update(body).digest("hex"),
  });
  const comment = (messageId: string) => ({
    op: "thread.create",
    thread: {
      id: `th_${messageId}`,
      artboardId: "ab_1",
      x: 40,
      y: 30,
      status: "open",
      createdAt: 0,
      updatedAt: 0,
      messages: [
        { id: messageId, author: { kind: "user", name: "Maya" }, text: "Here", createdAt: 0 },
      ],
    },
  });
  /** Uploads both themes for `messageId` as `who`, and answers the ids to complete. */
  async function upload(canvasId: string, messageId: string, who = "maya") {
    const files = { light: webp("light"), dark: webp("dark") };
    const signed = await call(
      t,
      as(who),
      "POST",
      `/v1/canvases/${canvasId}/comments/${messageId}/picture`,
      { files: [declared("light.webp", files.light), declared("dark.webp", files.dark)] },
    );
    expect(signed.status).toBe(200);
    for (const [index, file] of signed.body.files.entries()) {
      const body = index === 0 ? files.light : files.dark;
      await t.storage.fetch(file.put.url, { method: "PUT", headers: file.put.headers, body });
    }
    return signed.body.files.map((file: { id: string }) => file.id) as string[];
  }
  const complete = (canvasId: string, messageId: string, ids: string[], who = "maya") =>
    call(t, as(who), "POST", `/v1/canvases/${canvasId}/comments/${messageId}/picture/complete`, {
      ids,
    });

  test("its two files go under comments/, and the comment's thread item keeps the first", async () => {
    const { canvas } = await sample();
    const ids = await upload(canvas.id, "m_pic1");

    const assetKey = await getCanvasAssetKey(t.db, canvas.id);
    const keys = () => [...t.storage.objects.keys()];
    const served = () => keys().filter((key) => key.startsWith(`${assetKey}/comments/`));
    const staged = () => keys().filter((key) => /^staging\/.*m_pic1-/.test(key));
    // The bytes wait under staging/, served from nowhere, until a comment has them.
    expect(staged()).toHaveLength(2);
    expect(served()).toEqual([]);

    // Before the comment is committed, there is nothing to give it to; asking again is fine.
    const early = await complete(canvas.id, "m_pic1", ids);
    expect([early.status, early.body.error.code]).toEqual([404, "not_found"]);
    expect(served()).toEqual([]);

    await call(t, as("maya"), "POST", `/v1/canvases/${canvas.id}/ops`, {
      ops: [{ id: "op_pic1", op: comment("m_pic1") }],
    });
    const done = await complete(canvas.id, "m_pic1", ids);
    expect(done.status).toBe(200);
    const { picture } = done.body;
    expect(picture).toEqual({
      light: expect.stringMatching(/^comments\/m_pic1-light-[0-9a-z]{6}\.webp$/),
      dark: expect.stringMatching(/^comments\/m_pic1-dark-[0-9a-z]{6}\.webp$/),
      width: 240,
      height: 160,
    });
    const light = await t.storage.head(`${assetKey}/${picture.light}`);
    expect(light?.size).toBe(webp("light").byteLength);
    const [item] = await listThreadItems(t.db, { canvasId: canvas.id });
    expect(item!.payload).toMatchObject({ messageId: "m_pic1", picture });
    await t.backgroundDone();
    expect(staged()).toEqual([]);

    // A second picture for it (another window of theirs) changes nothing: the first is the one
    // it keeps, and the second is never served.
    const again = await complete(canvas.id, "m_pic1", await upload(canvas.id, "m_pic1"));
    expect(again.body.picture).toEqual(picture);
    expect(served().sort()).toEqual(
      [`${assetKey}/${picture.light}`, `${assetKey}/${picture.dark}`].sort(),
    );
  });

  test("only its author gives a comment a picture, of its own files, both themes", async () => {
    const { canvas } = await sample();
    await call(t, as("maya"), "POST", `/v1/canvases/${canvas.id}/ops`, {
      ops: [{ id: "op_pic2", op: comment("m_pic2") }],
    });
    const reader = await call(
      t,
      as("ines"),
      "POST",
      `/v1/canvases/${canvas.id}/comments/m_pic2/picture`,
      { files: [declared("light.webp", webp("l")), declared("dark.webp", webp("d"))] },
    );
    const png = await call(
      t,
      as("maya"),
      "POST",
      `/v1/canvases/${canvas.id}/comments/m_pic2/picture`,
      {
        files: [declared("light.png", webp("l"), "image/png"), declared("dark.webp", webp("d"))],
      },
    );
    // Another comment's files are not this one's picture.
    const elsewhere = await complete(canvas.id, "m_pic2", await upload(canvas.id, "m_other"));

    expect([reader.status, reader.body.error.code]).toEqual([403, "forbidden"]);
    expect(png.status).toBeGreaterThanOrEqual(400);
    expect([elsewhere.status, elsewhere.body.error.code]).toEqual([400, "invalid_request"]);
    const [item] = await listThreadItems(t.db, { canvasId: canvas.id });
    expect(item!.payload).not.toHaveProperty("picture");
    const assetKey = await getCanvasAssetKey(t.db, canvas.id);
    const served = [...t.storage.objects.keys()].filter((key) => key.startsWith(`${assetKey}/`));
    expect(served).toEqual([]);
  });
});
