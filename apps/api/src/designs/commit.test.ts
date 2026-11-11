import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { applyOp, type Doc, MAX_COMMIT_OPS } from "@ponzu/core";
import { el, sampleDoc } from "@ponzu/core/fixtures";
import { getDesign, listThreadItems, readDocSource, readOps } from "@ponzu/db";
import { feedOf } from "@ponzu/db/testing";
import type { RunnerActor } from "../auth/actor.ts";
import {
  call,
  designIn,
  runnerHeaders,
  type Workspace,
  workspaceWithRepo,
} from "../testing/designs.ts";
import { createTestApp, type TestApp } from "../testing/index.ts";
import { AGENT } from "./actor.ts";
import { commitPost } from "./commit.ts";
import { DocCache } from "./doc-cache.ts";
import { readCurrentDoc } from "./document.ts";

let t: TestApp;
let ws: Workspace;
beforeAll(async () => {
  t = await createTestApp();
  ws = await workspaceWithRepo(t, { maya: "write", leo: "write", ines: "read", omar: "none" });
});
afterAll(() => t.close());

const as = (login: string) => ws.people[login]!.headers;
const post = (headers: Record<string, string>, designId: string, ops: unknown[]) =>
  call(t, headers, "POST", `/v1/designs/${designId}/ops`, { ops });
const sample = () => designIn(t, ws, "maya", sampleDoc());
/** The design as everyone would rebuild it from its checkpoint and log. */
async function rebuilt(designId: string): Promise<{ doc: Doc; seq: number }> {
  const source = (await readDocSource(t.db, designId))!;
  const { doc } = source.checkpoint;
  for (const stored of source.ops) applyOp(doc, stored.op);
  return { doc, seq: source.seq };
}

describe("committing", () => {
  test("commits ops in order with the next seqs, signed by the caller and timed by the API", async () => {
    const design = await sample();
    t.clock.advance(1_000);

    const { status, body } = await post(as("maya"), design.id, [
      { id: "op_move", op: { op: "artboard.update", id: "ab_1", x: 10, y: 20 } },
      { id: "op_page", op: { op: "page.create", index: 2, page: { id: "pg_9", name: "More" } } },
    ]);

    expect(status).toBe(200);
    const maya = {
      kind: "user",
      id: ws.people.maya!.userId,
      name: "Maya",
      avatarUrl: expect.any(String),
    };
    expect(body).toEqual({
      committed: [
        {
          seq: 1,
          id: "op_move",
          op: { op: "artboard.update", id: "ab_1", x: 10, y: 20 },
          actor: maya,
          at: expect.any(String),
        },
        {
          seq: 2,
          id: "op_page",
          op: { op: "page.create", index: 2, page: { id: "pg_9", name: "More" } },
          actor: maya,
          at: expect.any(String),
        },
      ],
      rejected: [],
      seq: 2,
    });
    expect((await call(t, as("ines"), "GET", `/v1/designs/${design.id}/doc`)).body).toEqual(
      await rebuilt(design.id),
    );
  });

  test("a comment's author and every time in it are the API's, whatever was sent", async () => {
    const design = await sample();
    const forged = {
      id: "m_forged",
      author: { kind: "agent", id: "claude", name: "Claude" },
      text: "Ship it.",
      createdAt: 1,
      editedAt: 2,
    };

    const { body } = await post(as("maya"), design.id, [
      { id: "op_reply", op: { op: "thread.message", id: "th_1", message: forged } },
    ]);

    expect(body.committed[0].op.message).toEqual({
      id: "m_forged",
      author: {
        kind: "user",
        id: ws.people.maya!.userId,
        name: "Maya",
        avatarUrl: expect.any(String),
      },
      text: "Ship it.",
      createdAt: t.clock.now(),
    });
  });

  test("markup is sanitized before it is applied or stored", async () => {
    const design = await sample();
    const button = el("n_btn", "button");
    button.attrs = { onclick: "steal()", href: "javascript:steal()", title: "Buy" };

    const { body } = await post(await runnerHeaders(t, design.id), design.id, [
      {
        id: "op_markup",
        op: { op: "insert", parent: "n_1", index: 0, nodes: [el("n_s", "script"), button] },
      },
    ]);

    expect(body.committed[0].op.nodes).toEqual([{ ...button, attrs: { title: "Buy" } }]);
    // What the log holds, as any client will read it back.
    const stored = await readOps(t.db, { designId: design.id, after: 0 });
    expect(stored).toMatchObject({ kind: "ok", seq: 1 });
    expect(JSON.stringify(stored)).not.toMatch(/script|steal/);
  });

  test("a page moved is stored as the order it makes, which every client can replay", async () => {
    const design = await sample();

    const { body } = await post(as("maya"), design.id, [
      { id: "op_pagemove", op: { op: "page.move", id: "pg_1", index: 1 } },
    ]);

    expect(body.committed[0].op).toEqual({ op: "page.order", ids: ["pg_2", "pg_1"] });
  });

  test("an op that does not fit is rejected on its own, leaves nothing behind, and the rest go on", async () => {
    const design = await sample();

    const { body } = await post(await runnerHeaders(t, design.id), design.id, [
      { id: "op_1", op: { op: "note", name: "plan", content: "One" } },
      {
        // Its second op names a node that is not there: its first must not stay.
        id: "op_2",
        op: {
          op: "batch",
          ops: [
            { op: "style", id: "n_1", style: { color: "red" } },
            { op: "remove", id: "n_missing" },
          ],
        },
      },
      { id: "op_3", op: { op: "made.up" } },
      { id: "op_4", op: { op: "note", name: "plan", content: "Two" } },
    ]);

    expect(body.committed.map((op: any) => [op.seq, op.id])).toEqual([
      [1, "op_1"],
      [2, "op_4"],
    ]);
    expect(body.rejected).toEqual([
      { id: "op_2", reason: expect.stringContaining("n_missing") },
      { id: "op_3", reason: expect.stringContaining("not an op Ponzu knows") },
    ]);
    const { doc } = await rebuilt(design.id);
    expect(doc.notes.plan).toBe("Two");
    expect(doc.pages[0]!.artboards[0]!.root.children[0]).toMatchObject({ id: "n_1", style: {} });
  });

  test("posting the same ids again answers with what they first got and appends nothing", async () => {
    const design = await sample();
    const ops = [
      { id: "op_a", op: { op: "artboard.update", id: "ab_1", x: 1 } },
      { id: "op_b", op: { op: "artboard.update", id: "ab_1", x: 2 } },
    ];
    const first = await post(as("maya"), design.id, ops);
    t.clock.advance(5_000);

    // A retry of the same post, and one that adds an op after it.
    const again = await post(as("maya"), design.id, ops);
    const more = await post(as("maya"), design.id, [
      ...ops,
      { id: "op_c", op: { op: "artboard.update", id: "ab_1", x: 3 } },
    ]);

    expect(again.body).toEqual(first.body);
    expect(more.body.committed.map((op: any) => [op.seq, op.id])).toEqual([
      [1, "op_a"],
      [2, "op_b"],
      [3, "op_c"],
    ]);
    expect(more.body.committed.slice(0, 2)).toEqual(first.body.committed);
    expect(await feedOf(t.db, design.id)).toHaveLength(3);
  });

  test("a post that is malformed, too long, too large or repeats an id is refused whole", async () => {
    const design = await sample();
    const op = { op: "artboard.update", id: "ab_1", x: 1 };
    const many = Array.from({ length: MAX_COMMIT_OPS + 1 }, (_, i) => ({ id: `op_${i}`, op }));
    const heavy = Array.from({ length: 4 }, (_, i) => ({
      id: `op_heavy_${i}`,
      op: { op: "note", name: `n${i}`, content: "x".repeat(900_000) },
    }));

    const refusals = await Promise.all([
      post(as("maya"), design.id, many),
      post(as("maya"), design.id, [
        { id: "op_same", op },
        { id: "op_same", op },
      ]),
      post(as("maya"), design.id, [{ id: "not an id!", op }]),
      call(t, as("maya"), "POST", `/v1/designs/${design.id}/ops`, { nope: [] }),
      post(await runnerHeaders(t, design.id), design.id, heavy),
    ]);

    expect(refusals.map(({ status, body }) => [status, body.error.code])).toEqual([
      [400, "invalid_request"],
      [400, "invalid_request"],
      [400, "invalid_request"],
      [400, "invalid_request"],
      [413, "payload_too_large"],
    ]);
    expect(refusals[1]!.body.error.details.issues).toEqual([
      { path: "json.ops.1.id", message: "is the id of another op in this post" },
    ]);
    expect((await rebuilt(design.id)).seq).toBe(0);
  });

  test("someone who may only look, or not even that, commits nothing; nor does another design's runner", async () => {
    const [design, other] = await Promise.all([sample(), sample()]);
    const ops = [{ id: "op_x", op: { op: "artboard.update", id: "ab_1", x: 9 } }];

    const answers = await Promise.all([
      post(as("ines"), design.id, ops),
      post(as("omar"), design.id, ops),
      post(await runnerHeaders(t, other.id), design.id, ops),
    ]);

    expect(answers.map(({ status, body }) => [status, body.error.code])).toEqual([
      [403, "forbidden"],
      [404, "not_found"],
      [404, "not_found"],
    ]);
    expect((await rebuilt(design.id)).seq).toBe(0);
  });
});

describe("comments", () => {
  test("a person edits and deletes their own messages only, and may delete anyone's thread", async () => {
    const design = await sample();
    const thread = {
      id: "th_talk",
      pageId: "pg_2",
      x: 0,
      y: 0,
      status: "open",
      createdAt: 0,
      updatedAt: 0,
      messages: [
        { id: "m_maya", author: { kind: "user", name: "Maya" }, text: "Hi", createdAt: 0 },
      ],
    };
    await post(as("maya"), design.id, [{ id: "op_t", op: { op: "thread.create", thread } }]);
    const reply = { id: "m_leo", author: { kind: "user", name: "Leo" }, text: "Yo", createdAt: 0 };
    await post(as("leo"), design.id, [
      { id: "op_r", op: { op: "thread.message", id: "th_talk", message: reply } },
    ]);
    const edit = (messageId: string) => ({
      op: "thread.edit",
      id: "th_talk",
      messageId,
      text: "Changed",
      editedAt: 0,
    });

    const leo = await post(as("leo"), design.id, [
      { id: "op_e1", op: edit("m_maya") },
      { id: "op_e2", op: { op: "thread.unmessage", id: "th_talk", messageId: "m_maya" } },
      { id: "op_e3", op: edit("m_leo") },
    ]);
    const maya = await post(as("maya"), design.id, [
      { id: "op_e4", op: edit("m_maya") },
      { id: "op_e5", op: { op: "thread.unmessage", id: "th_talk", messageId: "m_leo" } },
    ]);
    const runner = await post(await runnerHeaders(t, design.id), design.id, [
      { id: "op_e6", op: edit("m_maya") },
    ]);

    expect(leo.body.committed.map((op: any) => op.id)).toEqual(["op_e3"]);
    expect(leo.body.rejected.map((op: any) => op.id)).toEqual(["op_e1", "op_e2"]);
    expect(maya.body.committed.map((op: any) => op.id)).toEqual(["op_e4"]);
    expect(maya.body.rejected).toEqual([
      { id: "op_e5", reason: "Only whoever wrote a message can change or delete it." },
    ]);
    expect(runner.body.rejected.map((op: any) => op.id)).toEqual(["op_e6"]);
    const deleted = await post(as("leo"), design.id, [
      { id: "op_d", op: { op: "thread.delete", id: "th_talk" } },
    ]);
    expect(deleted.body.committed).toHaveLength(1);
  });

  test("the agent's own messages are its to edit", async () => {
    const design = await sample();
    const runner = await runnerHeaders(t, design.id);
    const message = { id: "m_claude", author: AGENT, text: "Done?", createdAt: 0 };
    await post(runner, design.id, [
      { id: "op_c", op: { op: "thread.message", id: "th_1", message } },
    ]);

    const { body } = await post(runner, design.id, [
      {
        id: "op_ce",
        op: { op: "thread.edit", id: "th_1", messageId: "m_claude", text: "Done.", editedAt: 0 },
      },
    ]);

    expect(body.committed).toHaveLength(1);
  });
});

describe("the event feed", () => {
  const feed = (designId: string) => feedOf(t.db, designId);
  /** What the next module's runner reports; set by hand here. */
  const agentOn = (designId: string, state: string, boards: string) =>
    t.db.execute(
      `update designs set agent_state = '${state}', agent_artboards = '{${boards}}' where id = '${designId}'`,
    );
  const comment = (id: string, artboardId: string) => ({
    op: "thread.create",
    thread: {
      id,
      artboardId,
      x: 0,
      y: 0,
      status: "open",
      createdAt: 0,
      updatedAt: 0,
      messages: [
        { id: `m_${id}`, author: { kind: "user", name: "Maya" }, text: "Bigger", createdAt: 0 },
      ],
    },
  });

  test("a person's comment is `next`, `now` on a board the agent is working on, and an edit is `later`", async () => {
    const design = await sample();
    await post(await runnerHeaders(t, design.id), design.id, [
      {
        id: "op_board",
        op: {
          op: "artboard.create",
          page: "pg_1",
          index: 1,
          artboard: { id: "ab_2", name: "Busy", x: 2000, y: 0, root: el("ab_2", "section") },
        },
      },
    ]);
    await agentOn(design.id, "working", "ab_2");

    await post(as("maya"), design.id, [
      { id: "op_c1", op: comment("th_a", "ab_1") },
      { id: "op_c2", op: comment("th_b", "ab_2") },
      { id: "op_c3", op: { op: "thread.update", id: "th_1", status: "resolved" } },
      { id: "op_c4", op: { op: "artboard.update", id: "ab_1", x: 50 } },
    ]);

    const userId = ws.people.maya!.userId;
    expect(
      (await feed(design.id)).map(({ kind, priority, payload, userId }) => ({
        kind,
        priority,
        payload,
        userId,
      })),
    ).toEqual([
      {
        kind: "comment",
        priority: "next",
        userId,
        payload: {
          seq: 2,
          threadId: "th_a",
          messageId: "m_th_a",
          text: "Bigger",
          reply: false,
          artboardId: "ab_1",
          artboardName: "Home",
          nodeId: null,
        },
      },
      {
        kind: "comment",
        priority: "now",
        userId,
        payload: {
          seq: 3,
          threadId: "th_b",
          messageId: "m_th_b",
          text: "Bigger",
          reply: false,
          artboardId: "ab_2",
          artboardName: "Busy",
          nodeId: null,
        },
      },
      // Resolving a comment is a change to the canvas, not something said to the agent.
      {
        kind: "edit",
        priority: "later",
        userId,
        payload: { seq: 4, summary: expect.any(String), artboards: [] },
      },
      {
        kind: "edit",
        priority: "later",
        userId,
        payload: {
          seq: 5,
          summary: 'updated artboard "Home"',
          artboards: [{ id: "ab_1", name: "Home" }],
        },
      },
    ]);
  });

  test("a new comment and a reply each show in the thread beside their event, by the person", async () => {
    const design = await sample();
    const reply = {
      op: "thread.message",
      id: "th_1",
      message: { id: "m_yes", author: { kind: "user", name: "Maya" }, text: "Yes", createdAt: 0 },
    };

    await post(as("maya"), design.id, [
      { id: "op_c1", op: comment("th_new", "ab_1") },
      { id: "op_c2", op: reply },
    ]);

    const maya = ws.people.maya!;
    const from = { id: maya.userId, name: "Maya", login: "maya" };
    const thread = await listThreadItems(t.db, { designId: design.id });
    expect(
      thread.map(({ kind, userId, streaming, payload }) => ({ kind, userId, streaming, payload })),
    ).toEqual([
      {
        kind: "comment",
        userId: maya.userId,
        streaming: false,
        payload: {
          threadId: "th_new",
          messageId: "m_th_new",
          text: "Bigger",
          artboardId: "ab_1",
          artboardName: "Home",
          pageId: "pg_1",
          pageName: "First",
          at: { x: 0, y: 0 },
          from,
        },
      },
      {
        kind: "comment",
        userId: maya.userId,
        streaming: false,
        payload: {
          threadId: "th_1",
          messageId: "m_yes",
          text: "Yes",
          artboardId: "ab_1",
          artboardName: "Home",
          pageId: "pg_1",
          pageName: "First",
          at: { x: 10, y: 20 },
          from,
        },
      },
    ]);
    expect(
      (await feed(design.id)).map((event) => (event.payload as { reply: boolean }).reply),
    ).toEqual([false, true]);
  });

  test("a comment on the open canvas says its page and where on it", async () => {
    const design = await sample();
    await post(as("maya"), design.id, [
      {
        id: "op_open",
        op: {
          op: "thread.create",
          thread: {
            id: "th_open",
            pageId: "pg_2",
            x: -40,
            y: 300,
            status: "open",
            createdAt: 0,
            updatedAt: 0,
            messages: [
              { id: "m_open", author: { kind: "user", name: "Maya" }, text: "Here", createdAt: 0 },
            ],
          },
        },
      },
    ]);
    const [item] = await listThreadItems(t.db, { designId: design.id });
    expect(item!.payload).toMatchObject({
      artboardId: null,
      artboardName: null,
      pageId: "pg_2",
      pageName: "Second",
      at: { x: -40, y: 300 },
    });
    expect(item!.payload).not.toHaveProperty("picture");
  });

  test("a person's ops ask for the design's sandbox, and a comment asks it to wake", async () => {
    const design = await sample();
    const wakes = async () => {
      const result = await t.db.execute(
        `select key from jobs where kind = 'sandbox.wake' and key = '${design.id}'`,
      );
      return (result as unknown as { rows: unknown[] }).rows.length;
    };

    await post(as("maya"), design.id, [
      { id: "op_e", op: { op: "artboard.update", id: "ab_1", x: 9 } },
    ]);
    expect(await wakes()).toBe(0);

    await post(as("maya"), design.id, [{ id: "op_c", op: comment("th_w", "ab_1") }]);
    expect(await wakes()).toBe(1);
    // The agent's own ops are not news to it.
    await post(await runnerHeaders(t, design.id), design.id, [
      { id: "op_r", op: { op: "artboard.update", id: "ab_1", x: 10 } },
    ]);
    expect((await feed(design.id)).map((event) => event.kind)).toEqual(["edit", "comment"]);
  });

  test("a comment is `next` while the agent is not working, whatever boards it last named", async () => {
    const design = await sample();
    await agentOn(design.id, "idle", "ab_1");

    await post(as("maya"), design.id, [{ id: "op_c", op: comment("th_c", "ab_1") }]);

    expect((await feed(design.id)).map((event) => event.priority)).toEqual(["next"]);
  });

  test("an op and its event land together or not at all, so a retry is never an op the agent missed", async () => {
    const design = await sample();
    // The next insert into the feed fails, once: a database that hiccups between two writes.
    for (const statement of [
      "create sequence events_fail_once",
      `create function events_fail_once() returns trigger language plpgsql as $$
       begin
         if nextval('events_fail_once') = 1 then raise exception 'the feed is down'; end if;
         return new;
       end $$`,
      `create trigger events_fail_once before insert on events
         for each row execute function events_fail_once()`,
    ]) {
      await t.db.execute(statement);
    }
    const reply = {
      id: "op_reply",
      op: {
        op: "thread.message",
        id: "th_1",
        message: {
          id: "m_reply",
          author: { kind: "user", name: "Maya" },
          text: "Yes",
          createdAt: 0,
        },
      },
    };

    try {
      const failed = await post(as("maya"), design.id, [reply]);
      expect(failed.status).toBe(500);
      expect((await getDesign(t.db, design.id))!.seq).toBe(0);

      const retried = await post(as("maya"), design.id, [reply]);
      expect(retried.body).toMatchObject({ committed: [{ id: "op_reply", seq: 1 }], seq: 1 });
    } finally {
      await t.db.execute("drop trigger events_fail_once on events");
      await t.db.execute("drop function events_fail_once()");
      await t.db.execute("drop sequence events_fail_once");
    }
    const events = await feed(design.id);
    expect(events.map(({ kind, payload }) => [kind, (payload as { seq: number }).seq])).toEqual([
      ["comment", 1],
    ]);
  });

  test("a comment an undo or a redo puts back is an edit, not said or shown again", async () => {
    const design = await sample();
    await post(as("maya"), design.id, [{ id: "op_c", op: comment("th_u", "ab_1") }]);
    const deleted = { op: "thread.delete", id: "th_u" };
    await post(as("maya"), design.id, [{ id: "op_d", op: deleted }]);
    const act = (kind: "undo" | "redo") =>
      call(t, as("maya"), "POST", `/v1/designs/${design.id}/${kind}`);

    // Undoing the deletion puts the comment back; so does undoing the comment, then redoing it.
    expect((await act("undo")).status).toBe(200);
    await post(as("maya"), design.id, [{ id: "op_d2", op: deleted }]);
    for (const kind of ["undo", "undo", "redo"] as const)
      expect((await act(kind)).status).toBe(200);

    expect((await feed(design.id)).map((event) => event.kind)).toEqual([
      "comment",
      "edit",
      "edit",
      "edit",
      "edit",
      "edit",
      "edit",
    ]);
    const thread = await listThreadItems(t.db, { designId: design.id });
    expect(thread.map((item) => item.kind)).toEqual(["comment"]);
  });

  test("the runner's own ops make no events", async () => {
    const design = await sample();

    await post(await runnerHeaders(t, design.id), design.id, [
      { id: "op_r1", op: comment("th_r", "ab_1") },
      { id: "op_r2", op: { op: "style", id: "n_1", style: { color: "red" } } },
    ]);

    expect(await feed(design.id)).toEqual([]);
  });
});

describe("reading", () => {
  test("ops after a seq, and 410 once the log no longer reaches back that far", async () => {
    const design = await sample();
    const runner = await runnerHeaders(t, design.id);
    for (const n of [1, 2, 3]) {
      await post(runner, design.id, [
        { id: `op_${n}`, op: { op: "note", name: "n", content: `${n}` } },
      ]);
    }
    const after = (n: number) =>
      call(t, as("ines"), "GET", `/v1/designs/${design.id}/ops?after=${n}`);

    expect((await after(1)).body).toMatchObject({ seq: 3, ops: [{ seq: 2 }, { seq: 3 }] });
    expect((await after(3)).body).toEqual({ ops: [], seq: 3 });
    // What pruning does once the ops are a week old and checkpointed.
    await t.db.execute(`delete from design_ops where design_id = '${design.id}' and seq = 1`);
    const gone = await after(0);
    expect([gone.status, gone.body.error.code]).toEqual([410, "ops_pruned"]);
    expect((await after(-1)).status).toBe(400);
  });

  test("a checkpoint is written after 64 ops, and the document reads the same from it", async () => {
    const design = await sample();
    const runner = await runnerHeaders(t, design.id);
    const ops = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        id: `op_n${from + i}`,
        op: { op: "note", name: "count", content: `${from + i}` },
      }));
    await post(runner, design.id, ops(1, 63));
    await t.backgroundDone();
    const checkpoint = async () => (await readDocSource(t.db, design.id))!.checkpoint.seq;
    expect(await checkpoint()).toBe(0);

    await post(runner, design.id, ops(64, 2));
    await t.backgroundDone();

    expect(await checkpoint()).toBe(65);
    const fresh = await readCurrentDoc({ ...t.deps, docs: new DocCache() }, design.id);
    expect(fresh!.doc.notes.count).toBe("65");
    expect(fresh!.seq).toBe(65);
  });
});

describe("two function instances", () => {
  const runnerOf = (designId: string): RunnerActor => ({
    kind: "runner",
    tokenId: "rt_test",
    designId,
    runnerId: "rnr_test",
  });
  const instance = () => ({ ...t.deps, docs: new DocCache() });

  test("each catches up from the log before it commits, so none commits against a stale document", async () => {
    const row = (await getDesign(t.db, (await sample()).id))!;
    const [a, b] = [instance(), instance()];
    const commit = (deps: typeof a, id: string, op: unknown) =>
      commitPost(deps, { design: row, caller: runnerOf(row.id), posted: [{ id, op }] });

    await commit(a, "op_1", { op: "note", name: "who", content: "a" });
    expect(a.docs.get(row.id)!.seq).toBe(1);
    // B deletes the board while A still holds the document from before.
    await commit(b, "op_2", { op: "artboard.delete", id: "ab_1" });

    const late = await commit(a, "op_3", { op: "artboard.update", id: "ab_1", x: 5 });

    expect(late.committed).toEqual([]);
    expect(late.rejected).toEqual([{ id: "op_3", reason: expect.stringContaining("ab_1") }]);
    expect(late.seq).toBe(2);
    const truth = await rebuilt(row.id);
    for (const deps of [a, b]) expect(await readCurrentDoc(deps, row.id)).toMatchObject(truth);
  });

  test("racing commits all land, in one order, and every instance converges on it", async () => {
    const row = (await getDesign(t.db, (await sample()).id))!;
    const instances = [instance(), instance(), instance(), instance()];
    // Each instance has read the design once already, so each starts from its own seq.
    for (const deps of instances) await readCurrentDoc(deps, row.id);

    const results = await Promise.all(
      instances.map((deps, i) =>
        commitPost(deps, {
          design: row,
          caller: runnerOf(row.id),
          posted: [
            { id: `op_race_${i}`, op: { op: "artboard.update", id: "ab_1", x: i } },
            { id: `op_note_${i}`, op: { op: "note", name: `from-${i}`, content: "here" } },
          ],
        }),
      ),
    );

    const seqs = results
      .flatMap((result) => result.committed.map((op) => op.seq))
      .sort((x, y) => x - y);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const truth = await rebuilt(row.id);
    expect(truth.seq).toBe(8);
    expect(Object.keys(truth.doc.notes).sort()).toEqual([
      "brief",
      "from-0",
      "from-1",
      "from-2",
      "from-3",
    ]);
    for (const deps of instances) expect(await readCurrentDoc(deps, row.id)).toMatchObject(truth);
  });
});
