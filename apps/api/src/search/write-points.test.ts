import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  applyOp,
  type Doc,
  docSearchEntries,
  newOpId,
  type Op,
  SEARCH_VERSION,
  type SearchEntry,
} from "@ponzu/core";
import { SAMPLE_OPS, sampleDoc } from "@ponzu/core/fixtures";
import {
  jobs,
  listSearchEntries,
  newId,
  readDocSource,
  SEARCH_REINDEX_JOB,
  searchState,
  toSearchRows,
  upsertSearchEntries,
} from "@ponzu/db";
import { RetryLater } from "../jobs/retry.ts";
import { runDueJobs } from "../jobs/run.ts";
import {
  call,
  canvasIn,
  canvasWithRunner,
  runnerHeaders,
  type Workspace,
  workspaceWithRepo,
} from "../testing/canvases.ts";
import { createTestApp, TEST_CRON_SECRET, type TestApp } from "../testing/index.ts";
import { reindexCanvas } from "./reindex.ts";

/*
 * Every place search entries are written from the API (docs/cloud.md "Search"): the commit and
 * its undo, the runner's answers, the reindex job and the cron's backfill. The rule each test
 * holds them to: what is stored is what the source says now.
 */

let t: TestApp;
let ws: Workspace;
beforeAll(async () => {
  t = await createTestApp();
  ws = await workspaceWithRepo(t, { maya: "write" });
});
afterAll(() => t.close());

const maya = () => ws.people.maya!.headers;

/** The canvas's document as everyone would rebuild it from its checkpoint and log. */
async function rebuilt(canvasId: string): Promise<Doc> {
  const source = (await readDocSource(t.db, canvasId))!;
  const { doc } = source.checkpoint;
  for (const stored of source.ops) applyOp(doc, stored.op);
  return doc;
}

/** A row as `toSearchRows` makes it, without the folded text it is matched by. */
type Comparable = Omit<ReturnType<typeof toSearchRows>[number], "folded">;

/** The canvas's stored entries of `kinds`, as rows; the empty ones a commit leaves are not entries. */
async function stored(canvasId: string, kinds = ["canvas", "page", "board", "comment"]) {
  return (await listSearchEntries(t.db, canvasId))
    .filter((row) => row.text !== "" && kinds.includes(row.kind))
    .map(
      (row): Comparable => ({
        kind: row.kind,
        ref: row.ref,
        text: row.text,
        context: row.context,
        authorKind: row.authorKind,
        authorId: row.authorId,
        authorName: row.authorName,
        at: row.at?.toISOString() ?? null,
      }),
    )
    .sort(byKey);
}

/** What a document's entries are, as rows, in the same order. */
function expected(entries: SearchEntry[]): Comparable[] {
  return toSearchRows(entries)
    .map(({ folded: _folded, ...row }) => row)
    .sort(byKey);
}

const byKey = (a: Comparable, b: Comparable) =>
  `${a.kind}:${a.ref}`.localeCompare(`${b.kind}:${b.ref}`);

/** The test database's own client (PGlite), under the Drizzle handle the API is given. */
interface PgClient {
  query(text: string, params?: unknown[]): Promise<unknown>;
}
const pg = () => (t.db as unknown as { $client: PgClient }).$client;

/** One statement on the test database, by hand: what a fault or an older release left. */
const sqlRun = (text: string, ...params: unknown[]) => pg().query(text, params);

/** Every statement sent while `body` runs. */
async function statements(body: () => Promise<unknown>): Promise<string[]> {
  const client = pg();
  const query = client.query.bind(client);
  const seen: string[] = [];
  client.query = ((text: string, ...rest: never[]) => {
    seen.push(text);
    return query(text, ...rest);
  }) as typeof client.query;
  try {
    await body();
  } finally {
    client.query = query;
  }
  return seen;
}

/** Run `body` with every statement matching `pattern` failing, as a database fault would. */
async function failing(pattern: RegExp, body: () => Promise<unknown>): Promise<void> {
  const client = pg();
  const query = client.query.bind(client);
  client.query = ((text: string, ...rest: never[]) => {
    if (pattern.test(text)) return Promise.reject(new Error("the database said no"));
    return query(text, ...rest);
  }) as typeof client.query;
  try {
    await body();
  } finally {
    client.query = query;
  }
}

describe("commits", () => {
  test("after every kind of op, and its undo, the entries are the document's", async () => {
    for (const [kind, op] of Object.entries(SAMPLE_OPS) as [string, Op][]) {
      const canvas = await canvasIn(t, ws, "maya", sampleDoc());
      const posted = await call(t, maya(), "POST", `/v1/canvases/${canvas.id}/ops`, {
        ops: [{ id: newOpId(), op }],
      });
      expect(posted.status, kind).toBe(200);
      const after = await rebuilt(canvas.id);
      expect(await stored(canvas.id), kind).toEqual(expected(docSearchEntries(after)));

      const undone = await call(t, maya(), "POST", `/v1/canvases/${canvas.id}/undo`);
      if (posted.body.committed.length > 0) expect(undone.status, kind).toBe(200);
      const back = await rebuilt(canvas.id);
      expect(await stored(canvas.id), `${kind} undone`).toEqual(expected(docSearchEntries(back)));
      if (undone.status === 200) {
        const redone = await call(t, maya(), "POST", `/v1/canvases/${canvas.id}/redo`);
        expect(redone.status, kind).toBe(200);
        const again = await rebuilt(canvas.id);
        expect(await stored(canvas.id), `${kind} redone`).toEqual(
          expected(docSearchEntries(again)),
        );
      }
    }
  });

  test("renames, a board renamed through its root, a page deleted, and a comment's whole life", async () => {
    const { canvas, runner } = await canvasWithRunner(t, ws, "maya", sampleDoc());
    const steps: Op[] = [
      { op: "file.rename", name: "Checkout flow" },
      { op: "name", id: "ab_1", name: "Landing hero" },
      { op: "page.delete", id: "pg_2" },
      {
        op: "thread.create",
        thread: {
          id: "th_new",
          artboardId: "ab_1",
          x: 1,
          y: 1,
          status: "open",
          createdAt: 1,
          updatedAt: 1,
          messages: [
            { id: "m_a", author: { kind: "user", name: "x" }, text: "First", createdAt: 1 },
          ],
        },
      },
      {
        op: "thread.message",
        id: "th_new",
        message: { id: "m_b", author: { kind: "user", name: "x" }, text: "Second", createdAt: 1 },
      },
      { op: "thread.edit", id: "th_new", messageId: "m_a", text: "First, edited", editedAt: 2 },
      { op: "thread.update", id: "th_new", status: "resolved" },
      { op: "thread.unmessage", id: "th_new", messageId: "m_b" },
      { op: "thread.delete", id: "th_new" },
    ];
    for (const op of steps) {
      // Only the agent names nodes; a person renames the canvas and edits comments.
      const as = op.op === "name" ? runner.headers : maya();
      const posted = await call(t, as, "POST", `/v1/canvases/${canvas.id}/ops`, {
        ops: [{ id: newOpId(), op }],
      });
      expect(posted.body.rejected, op.op).toEqual([]);
      const doc = await rebuilt(canvas.id);
      expect(await stored(canvas.id), op.op).toEqual(expected(docSearchEntries(doc)));
    }
    for (const _ of steps) {
      await call(t, maya(), "POST", `/v1/canvases/${canvas.id}/undo`);
      const doc = await rebuilt(canvas.id);
      expect(await stored(canvas.id)).toEqual(expected(docSearchEntries(doc)));
    }
    expect((await rebuilt(canvas.id)).name).toBe("Sample");
  });

  test("the agent's node edits send no search SQL; a rename does", async () => {
    const canvas = await canvasIn(t, ws, "maya", sampleDoc());
    const runner = await runnerHeaders(t, canvas.id);
    const nodeOps: Op[] = [
      { op: "style", id: "n_1", style: { color: "red" } },
      { op: "attrs", id: "n_1", attrs: { class: "card" } },
      SAMPLE_OPS.insert,
      { op: "note", name: "plan", content: "Later" },
    ];

    const quiet = await statements(() =>
      call(t, runner, "POST", `/v1/canvases/${canvas.id}/ops`, {
        ops: nodeOps.map((op) => ({ id: newOpId(), op })),
      }),
    );
    const renamed = await statements(() =>
      call(t, runner, "POST", `/v1/canvases/${canvas.id}/ops`, {
        ops: [{ id: newOpId(), op: { op: "file.rename", name: "Renamed" } }],
      }),
    );

    expect(quiet.some((text) => text.includes("canvas_ops"))).toBe(true);
    expect(quiet.filter((text) => text.includes("search_entries"))).toEqual([]);
    expect(renamed.filter((text) => text.includes("search_entries")).length).toBeGreaterThan(0);
  });
});

/** A runner's write of one ended turn: its work item, an aside, and its answer. */
function endedTurn(answer: string, aside: string) {
  const [work, asideId, answerId] = [newId("ti"), newId("ti"), newId("ti")];
  return {
    ids: { work, aside: asideId, answer: answerId },
    items: [
      {
        id: work,
        kind: "tool",
        streaming: false,
        payload: {
          label: "Worked",
          steps: 1,
          artboards: [],
          turn: { ended: "done", ms: 5, final: answerId, boards: 0, files: 0, log: [] },
        },
      },
      { id: asideId, kind: "assistant", streaming: false, payload: { text: aside } },
      { id: answerId, kind: "assistant", streaming: false, payload: { text: answer } },
    ],
  };
}

describe("the runner's answers", () => {
  test("a failed index write still answers the runner, logs ids only, and queues a reindex that repairs it", async () => {
    const { canvas, runner } = await canvasWithRunner(t, ws, "maya", sampleDoc());
    const turn = endedTurn("The okapi answer", "an okapi aside");
    const logged = t.logs.length;

    let wrote: Awaited<ReturnType<typeof call>> | undefined;
    await failing(/insert into search_entries/, async () => {
      wrote = await call(t, runner.headers, "POST", "/v1/runner/thread", { items: turn.items });
    });

    expect(wrote!.status).toBe(200);
    expect(wrote!.body.items.map((item: any) => item.id)).toEqual(turn.items.map((i) => i.id));
    const failed = t.logs.slice(logged).filter((line) => line.event === "search_index_failed");
    expect(failed).toEqual([expect.objectContaining({ level: "error", canvasId: canvas.id })]);
    expect(JSON.stringify(failed)).not.toContain("okapi");
    expect(await stored(canvas.id, ["message"])).toEqual([]);
    const queued = (await t.db.select().from(jobs)).find((job) => job.key === canvas.id);
    expect(queued).toMatchObject({ kind: SEARCH_REINDEX_JOB, payload: { canvasId: canvas.id } });

    await runDueJobs(t.deps, "test");

    const messages = await stored(canvas.id, ["message"]);
    expect(messages.map((row) => [row.ref, row.text, row.authorKind])).toEqual([
      [turn.ids.answer, "The okapi answer", "agent"],
    ]);
  });

  test("a turn's ending written before its answer's last words queues a reindex that finds it", async () => {
    const { canvas, runner } = await canvasWithRunner(t, ws, "maya", sampleDoc());
    const turn = endedTurn("The tapir answer, in full", "a tapir aside");
    const [work, aside, answer] = turn.items as [
      (typeof turn.items)[0],
      (typeof turn.items)[1],
      (typeof turn.items)[2],
    ];
    const write = (items: unknown[]) =>
      call(t, runner.headers, "POST", "/v1/runner/thread", { items });

    // The turn open and its answer streaming; then the turn's ending, then the answer's last
    // words, each in a write of its own, as the runner's writer may split them.
    const running = { ...work.payload, turn: { ...work.payload.turn, ended: null, final: null } };
    await write([
      { ...work, streaming: true, payload: running },
      aside,
      { ...answer, streaming: true, payload: { text: "The tapir" } },
    ]);
    expect((await write([work])).status).toBe(200);
    await write([answer]);

    expect(await stored(canvas.id, ["message"])).toEqual([]);
    const queued = (await t.db.select().from(jobs)).find((job) => job.key === canvas.id);
    expect(queued).toMatchObject({ kind: SEARCH_REINDEX_JOB, completedAt: null });

    await runDueJobs(t.deps, "test");

    expect((await stored(canvas.id, ["message"])).map((row) => [row.ref, row.text])).toEqual([
      [turn.ids.answer, "The tapir answer, in full"],
    ]);
  });

  test("a reindex that runs before the answer's last words comes back for them", async () => {
    const { canvas, runner } = await canvasWithRunner(t, ws, "maya", sampleDoc());
    const turn = endedTurn("The bongo answer, in full", "a bongo aside");
    const [work, aside, answer] = turn.items as [
      (typeof turn.items)[0],
      (typeof turn.items)[1],
      (typeof turn.items)[2],
    ];
    const write = (items: unknown[]) =>
      call(t, runner.headers, "POST", "/v1/runner/thread", { items });

    // The turn has ended, but its answer is still streaming when the reindex runs.
    await write([work, aside, { ...answer, streaming: true, payload: { text: "The bongo" } }]);
    let thrown: unknown;
    try {
      await reindexCanvas(t.deps, canvas.id);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RetryLater);
    // What there was is written meanwhile.
    expect((await stored(canvas.id, ["message"])).map((row) => row.text)).toEqual(["The bongo"]);

    // The last words come in a write that names no turn; the next try finds them.
    await write([answer]);
    expect(await reindexCanvas(t.deps, canvas.id)).toMatchObject({ removed: 0 });
    expect((await stored(canvas.id, ["message"])).map((row) => row.text)).toEqual([
      "The bongo answer, in full",
    ]);
  });

  test("writing the same turn again changes nothing", async () => {
    const { canvas, runner } = await canvasWithRunner(t, ws, "maya", sampleDoc());
    const turn = endedTurn("Answer once", "aside");
    await call(t, runner.headers, "POST", "/v1/runner/thread", { items: turn.items });
    const first = await listSearchEntries(t.db, canvas.id);

    const again = await statements(() =>
      call(t, runner.headers, "POST", "/v1/runner/thread", { items: turn.items }),
    );

    expect(again.some((text) => text.includes("search_entries"))).toBe(true);
    expect(await listSearchEntries(t.db, canvas.id)).toEqual(first);
  });
});

describe("the reindex", () => {
  test("rebuilds a canvas's entries whole: its document, messages and answers, and no aside", async () => {
    const { canvas, runner } = await canvasWithRunner(t, ws, "maya", sampleDoc());
    await call(t, maya(), "POST", `/v1/canvases/${canvas.id}/messages`, { text: "Make it calm" });
    const turn = endedTurn("Calmer now", "thinking aloud");
    await call(t, runner.headers, "POST", "/v1/runner/thread", { items: turn.items });
    // An answer from before turns had records: no turn's work item comes before it.
    const legacy = await canvasWithRunner(t, ws, "maya", sampleDoc());
    const oldAnswer = newId("ti");
    await call(t, legacy.runner.headers, "POST", "/v1/runner/thread", {
      items: [
        { id: oldAnswer, kind: "assistant", streaming: false, payload: { text: "Old *answer*" } },
      ],
    });
    // Everything lost, and an aside wrongly indexed.
    await sqlRun("delete from search_entries where canvas_id = $1", canvas.id);
    await sqlRun("delete from search_state where canvas_id = $1", canvas.id);
    await upsertSearchEntries(t.db, {
      canvasId: canvas.id,
      entries: [
        {
          kind: "message",
          ref: turn.ids.aside,
          text: "thinking aloud",
          context: { kind: "message", itemSeq: 1 },
          author: { kind: "agent", id: "claude", name: "Claude" },
          at: null,
        },
      ],
    });

    const done = await reindexCanvas(t.deps, canvas.id);
    await reindexCanvas(t.deps, legacy.canvas.id);

    expect(done).toEqual({ doc: 5, messages: 2, removed: 1 });
    expect(await stored(canvas.id)).toEqual(expected(docSearchEntries(await rebuilt(canvas.id))));
    const messages = await stored(canvas.id, ["message"]);
    expect(messages.map((row) => [row.text, row.authorKind])).toEqual(
      expect.arrayContaining([
        ["Make it calm", "user"],
        ["Calmer now", "agent"],
      ]),
    );
    expect(messages).toHaveLength(2);
    expect((await stored(legacy.canvas.id, ["message"])).map((row) => row.text)).toEqual([
      "Old answer",
    ]);
    const state = (await t.db.select().from(searchState)).find((row) => row.canvasId === canvas.id);
    expect(state).toMatchObject({ version: SEARCH_VERSION, indexedSeq: 0 });
    // Again: nothing to write.
    expect(await reindexCanvas(t.deps, canvas.id)).toEqual({ doc: 5, messages: 0, removed: 0 });
  });

  test("a canvas that keeps changing under it is tried again later; one that is gone is done", async () => {
    const canvas = await canvasIn(t, ws, "maya", sampleDoc());
    const client = pg();
    const query = client.query.bind(client);
    let moved = 0;
    // Each time the reindex goes to write, a commit has just moved the canvas on.
    client.query = (async (text: string, ...rest: never[]) => {
      if (text.includes("with locked as")) {
        moved++;
        await query("update canvases set seq = seq + 1 where id = $1", [canvas.id]);
      }
      return query(text, ...rest);
    }) as typeof client.query;
    let thrown: unknown;
    try {
      await reindexCanvas(t.deps, canvas.id);
    } catch (error) {
      thrown = error;
    } finally {
      client.query = query;
    }

    expect(thrown).toBeInstanceOf(RetryLater);
    expect(moved).toBe(3);
    expect(await reindexCanvas(t.deps, "cnv_nothing")).toBeNull();
  });
});

describe("the backfill", () => {
  test("the cron queues a reindex for a canvas no reindex has done, and the jobs step runs it", async () => {
    const canvas = await canvasIn(t, ws, "maya", sampleDoc());
    await sqlRun("delete from search_state where canvas_id = $1", canvas.id);
    await sqlRun("delete from search_entries where canvas_id = $1", canvas.id);
    const cron = async () =>
      (await call(t, { authorization: `Bearer ${TEST_CRON_SECRET}` }, "GET", "/v1/cron/minute"))
        .body.steps;

    expect((await cron()).search_backfill).toEqual({ queued: 1 });
    // The next minute's jobs step runs it, before the backfill looks again.
    const next = await cron();

    expect(next.jobs.ran).toBeGreaterThanOrEqual(1);
    expect(next.search_backfill).toEqual({ queued: 0 });
    expect(await stored(canvas.id)).toEqual(expected(docSearchEntries(await rebuilt(canvas.id))));
  });
});
