import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  applyOp,
  SEARCH_KINDS as CORE_SEARCH_KINDS,
  type Doc,
  docSearchChanges,
  docSearchEntries,
  emptyDoc,
  type Op,
  SEARCH_TEXT_MAX,
  SEARCH_VERSION,
  type SearchEntry,
} from "@ponzu/core";
import { SAMPLE_OPS, sampleDoc, VARIANTS } from "@ponzu/core/fixtures";
import { and, eq, isNull, sql } from "drizzle-orm";
import { SEARCH_KINDS } from "../enums.ts";
import { actorFor, agent, seedRepo, seedUser, seedWorkspace } from "../fixtures.ts";
import { canvases, jobs, searchEntries, searchState } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { anonymiseUser, DELETED_PERSON } from "./account-deletion.ts";
import { createCanvas } from "./canvases.ts";
import { commitOps } from "./ops.ts";
import { recordPullRequestRead } from "./pull-requests.ts";
import {
  queueSearchBackfill,
  replaceDocSearchEntries,
  SEARCH_REINDEX_JOB,
  type SearchRow,
  toSearchRows,
  upsertSearchEntries,
} from "./search.ts";
import { postMessage } from "./thread.ts";
import { commitReversal } from "./undo.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

/** Every statement sent while `body` runs. */
async function statements(body: () => Promise<unknown>): Promise<string[]> {
  const client = db.$client;
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

/** A person, a workspace and a Scratch canvas of theirs whose document is `doc`. */
async function canvasWith(
  doc: Doc,
  firstMessage?: Parameters<typeof createCanvas>[1]["firstMessage"],
) {
  const [user, workspace] = await Promise.all([seedUser(db), seedWorkspace(db)]);
  const canvas = await createCanvas(db, {
    workspaceId: workspace.id,
    repoId: null,
    ownerId: user.id,
    claudeAccountId: null,
    name: doc.name,
    branch: null,
    doc,
    ...(firstMessage ? { firstMessage } : {}),
  });
  return { user, workspace, canvas };
}

/** A canvas's entries as rows, by key, leaving out the empty ones commits leave. */
async function stored(canvasId: string, { empty = false } = {}): Promise<SearchRow[]> {
  const rows = await db
    .select()
    .from(searchEntries)
    .where(eq(searchEntries.canvasId, canvasId))
    .orderBy(searchEntries.kind, searchEntries.ref);
  return rows
    .filter((row) => empty || row.text !== "")
    .map((row) => ({
      kind: row.kind,
      ref: row.ref,
      text: row.text,
      folded: row.folded,
      context: row.context,
      authorKind: row.authorKind,
      authorId: row.authorId,
      authorName: row.authorName,
      at: row.at?.toISOString() ?? null,
    }));
}

/** What a canvas's document entries should be stored as, in the order `stored` gives. */
const expected = (doc: Doc, others: SearchRow[] = []) =>
  [...toSearchRows(docSearchEntries(doc)), ...others].sort((a, b) =>
    a.kind === b.kind ? (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0) : a.kind < b.kind ? -1 : 1,
  );

const docKinds = (rows: SearchRow[]) =>
  rows.filter((row) => ["canvas", "page", "board", "comment"].includes(row.kind));

let opIds = 0;

/** Apply `op` to `doc` and commit it with what it changed in the search entries. */
async function commitWithSearch(canvasId: string, seq: number, doc: Doc, op: Op) {
  const before = structuredClone(doc);
  const inverse = applyOp(doc, op);
  const id = `op_${opIds++}`;
  const changes = docSearchChanges(before, doc, [op]);
  const result = await commitOps(db, {
    canvasId,
    expectedSeq: seq,
    actor: agent,
    ops: [{ id, op, inverse }],
    ...(changes ? { search: changes } : {}),
  });
  if (result.kind !== "committed") throw new Error(`expected a commit, got ${result.kind}`);
  return { seq: result.seq, inverse, op, before };
}

test("SEARCH_KINDS is core's list", () => {
  expect([...SEARCH_KINDS]).toEqual([...CORE_SEARCH_KINDS]);
});

describe("toSearchRows", () => {
  const entry = (fields: Partial<SearchEntry>): SearchEntry => ({
    kind: "comment",
    ref: "th_1/m_1",
    text: "Tighter?",
    context: {
      kind: "comment",
      threadId: "th_1",
      messageId: "m_1",
      pageId: null,
      artboardId: null,
      resolved: false,
    },
    author: { kind: "user", id: "usr_1", name: "Ada" },
    at: 1000,
    ...fields,
  });

  test("folds the text and keeps the first of each key", () => {
    const rows = toSearchRows([
      entry({ text: "Crème Brûlée!" }),
      entry({ text: "second" }),
      entry({ kind: "board", ref: "th_1/m_1", text: "Other kind" }),
    ]);
    expect(rows.map((row) => [row.kind, row.text, row.folded])).toEqual([
      ["comment", "Crème Brûlée!", "creme brulee "],
      ["board", "Other kind", "other kind"],
    ]);
    expect(rows[0]).toMatchObject({
      authorKind: "user",
      authorId: "usr_1",
      authorName: "Ada",
      at: "1970-01-01T00:00:01.000Z",
    });
  });

  test("makes every row storable and drops what an index could refuse", () => {
    const long = `${"a".repeat(SEARCH_TEXT_MAX - 1)}🎉 and more`;
    const rows = toSearchRows([
      entry({ ref: "a", text: "nul\u0000here" }),
      entry({ ref: "b", text: long }),
      entry({ ref: "c", text: "\u0000".replace("\u0000", "") }),
      entry({ ref: "x".repeat(2_000), text: "too long a key" }),
      entry({ ref: "bad\u0000ref", text: "unstorable key" }),
      entry({ ref: "d", text: "far future", at: 8.64e15 }),
      entry({ ref: "e", text: "year -100", at: Date.UTC(-100, 0, 1) }),
      entry({ ref: "f", text: "no time", at: Number.NaN }),
    ]);
    expect(rows.map((row) => row.ref)).toEqual(["a", "b", "d", "e", "f"]);
    expect(rows[0]!.text).toBe("nul�here");
    // Clipped short of the emoji rather than through it.
    expect(rows[1]!.text).toBe("a".repeat(SEARCH_TEXT_MAX - 1));
    expect(rows[1]!.folded).toHaveLength(SEARCH_TEXT_MAX - 1);
    expect(rows.slice(2).map((row) => row.at)).toEqual([null, null, null]);
  });
});

describe("createCanvas", () => {
  test("indexes the document and records the version at seq 0", async () => {
    const { canvas } = await canvasWith(sampleDoc());
    expect(await stored(canvas.id)).toEqual(expected(sampleDoc()));
    const [state] = await db.select().from(searchState).where(eq(searchState.canvasId, canvas.id));
    expect(state).toMatchObject({ version: SEARCH_VERSION, indexedSeq: 0 });
  });

  test("indexes the first message with its item's id, seq and time", async () => {
    const author = { kind: "user" as const, id: "usr_ada", name: "Ada" };
    const { canvas } = await canvasWith(emptyDoc("Lisbon"), {
      item: { text: "Make a zebra landing page" },
      event: { text: "Make a zebra landing page" },
      search: { text: "Make a zebra landing page", author },
    });
    const [item] = await db
      .execute<{ id: string; seq: number; created_at: string }>(
        sql`select id, seq::int as seq, created_at::text from thread_items where canvas_id = ${canvas.id}`,
      )
      .then((result) => result.rows);
    const message = (await stored(canvas.id)).find((row) => row.kind === "message");
    expect(message).toEqual({
      kind: "message",
      ref: item!.id,
      text: "Make a zebra landing page",
      folded: "make a zebra landing page",
      context: { kind: "message", itemSeq: item!.seq },
      authorKind: "user",
      authorId: "usr_ada",
      authorName: "Ada",
      at: new Date(item!.created_at).toISOString(),
    });
  });

  test("indexes no message when it is not asked to", async () => {
    const { canvas } = await canvasWith(emptyDoc("Lisbon"), {
      item: { text: "Hello" },
      event: { text: "Hello" },
    });
    expect((await stored(canvas.id)).map((row) => row.kind)).toEqual(["canvas"]);
  });
});

describe("commits", () => {
  test("every kind of op, and its undo, leave the entries equal to the document's", async () => {
    let slow = 0;
    for (const kind of VARIANTS) {
      const doc = sampleDoc();
      const { canvas, user } = await canvasWith(structuredClone(doc));
      const { seq, inverse, op, before } = await commitWithSearch(
        canvas.id,
        0,
        doc,
        SAMPLE_OPS[kind],
      );
      if (docSearchChanges(before, doc, [op])) slow++;
      expect([kind, await stored(canvas.id)]).toEqual([kind, expected(doc)]);

      // Undo it: the inverse, taken back through the reversal statement.
      const after = structuredClone(doc);
      applyOp(doc, inverse);
      const changes = docSearchChanges(after, doc, [inverse]);
      const undone = await commitReversal(db, {
        canvasId: canvas.id,
        expectedSeq: seq,
        actor: actorFor(user),
        kind: "undo",
        reverses: seq,
        op: { id: `undo_${opIds++}`, op: inverse, inverse: op },
        ...(changes ? { search: changes } : {}),
      });
      expect(undone.kind).toBe("committed");
      expect([kind, await stored(canvas.id)]).toEqual([kind, expected(doc)]);
      expect([kind, docSearchEntries(doc)]).toEqual([kind, docSearchEntries(before)]);
    }
    expect(slow).toBeGreaterThan(5);
  });

  test("a run of every kind of op, then undoing them all, stays equal at every step", async () => {
    const doc = sampleDoc();
    const { canvas } = await canvasWith(structuredClone(doc));
    let seq = 0;
    const done: { op: Op; inverse: Op; seq: number }[] = [];
    for (const kind of VARIANTS) {
      try {
        applyOp(structuredClone(doc), SAMPLE_OPS[kind]);
      } catch {
        continue; // An op the document no longer has a target for.
      }
      const step = await commitWithSearch(canvas.id, seq, doc, SAMPLE_OPS[kind]);
      seq = step.seq;
      done.push({ op: step.op, inverse: step.inverse, seq });
      expect([kind, await stored(canvas.id)]).toEqual([kind, expected(doc)]);
    }
    expect(done.length).toBeGreaterThan(10);
    for (const { inverse } of done.reverse()) {
      ({ seq } = await commitWithSearch(canvas.id, seq, doc, inverse));
      expect(await stored(canvas.id)).toEqual(expected(doc));
    }
    expect(await stored(canvas.id)).toEqual(expected(sampleDoc()));
  });

  test("a removal empties the entry rather than deleting it", async () => {
    const doc = sampleDoc();
    const { canvas } = await canvasWith(structuredClone(doc));
    await commitWithSearch(canvas.id, 0, doc, SAMPLE_OPS["page.delete"]);
    const empty = (await stored(canvas.id, { empty: true })).filter((row) => row.text === "");
    expect(empty.map((row) => [row.kind, row.ref, row.folded, row.authorKind, row.at])).toEqual([
      ["board", "ab_1", "", null, null],
      ["page", "pg_1", "", null, null],
    ]);
  });

  test("a conflict or a replay writes no entries", async () => {
    const doc = sampleDoc();
    const { canvas } = await canvasWith(structuredClone(doc));
    const rename = (name: string): Op => ({ op: "file.rename", name });
    const search = {
      upsert: [
        {
          kind: "canvas" as const,
          ref: "",
          text: "Zebra",
          context: { kind: "canvas" as const },
          author: null,
          at: null,
        },
      ],
      remove: [{ kind: "page" as const, ref: "pg_1" }],
    };
    const conflict = await commitOps(db, {
      canvasId: canvas.id,
      expectedSeq: 5,
      actor: agent,
      ops: [{ id: "r1", op: rename("Zebra"), inverse: rename("Sample") }],
      search,
    });
    expect(conflict.kind).toBe("conflict");
    expect(await stored(canvas.id, { empty: true })).toEqual(expected(sampleDoc()));

    const first = await commitOps(db, {
      canvasId: canvas.id,
      expectedSeq: 0,
      actor: agent,
      ops: [{ id: "r2", op: rename("Sample 2"), inverse: rename("Sample") }],
      search: { upsert: [{ ...search.upsert[0]!, text: "Sample 2" }], remove: [] },
    });
    expect(first.kind).toBe("committed");
    const before = await db
      .select()
      .from(searchEntries)
      .where(eq(searchEntries.canvasId, canvas.id));
    // The same op again, carrying different search data: it is a replay, so none is written.
    const replay = await commitOps(db, {
      canvasId: canvas.id,
      expectedSeq: 0,
      actor: agent,
      ops: [{ id: "r2", op: rename("Sample 2"), inverse: rename("Sample") }],
      search,
    });
    expect(replay).toMatchObject({ kind: "committed", replayed: ["r2"] });
    expect(
      await db.select().from(searchEntries).where(eq(searchEntries.canvasId, canvas.id)),
    ).toEqual(before);
  });

  test("a commit whose ops touch nothing searched carries no search SQL", async () => {
    const doc = sampleDoc();
    const { canvas } = await canvasWith(structuredClone(doc));
    let seq = 0;
    const sent = await statements(async () => {
      for (const kind of ["insert", "style", "attrs", "note", "tokens"] as const) {
        ({ seq } = await commitWithSearch(canvas.id, seq, doc, SAMPLE_OPS[kind]));
      }
    });
    expect(sent).toHaveLength(5);
    expect(sent.filter((text) => text.includes("search_entries"))).toEqual([]);
    // And one that renames does carry it.
    const renamed = await statements(() =>
      commitWithSearch(canvas.id, seq, doc, SAMPLE_OPS["file.rename"]),
    );
    expect(renamed.filter((text) => text.includes("search_entries"))).toHaveLength(1);
  });

  test("search data that could break a statement never fails the commit", async () => {
    const doc = sampleDoc();
    const { canvas } = await canvasWith(structuredClone(doc));
    const canvasEntry = (text: string): SearchEntry => ({
      kind: "canvas",
      ref: "",
      text,
      context: { kind: "canvas" },
      author: null,
      at: null,
    });
    const result = await commitOps(db, {
      canvasId: canvas.id,
      expectedSeq: 0,
      actor: agent,
      ops: [
        {
          id: "big",
          op: { op: "file.rename", name: "Big" },
          inverse: { op: "file.rename", name: "Sample" },
        },
      ],
      search: {
        // A key twice, 9,000 characters with an emoji at the cut, a NUL, a key too long to
        // index, and a key both upserted and removed.
        upsert: [
          canvasEntry(`${"z".repeat(7_999)}🎉${"z".repeat(1_000)}`),
          canvasEntry("second of the same key"),
          { ...canvasEntry("nul\u0000"), kind: "page", ref: "pg_1" },
          { ...canvasEntry("long key"), kind: "board", ref: "k".repeat(3_000) },
        ],
        remove: [
          { kind: "page", ref: "pg_1" },
          { kind: "board", ref: "ab_1" },
          { kind: "board", ref: "ab_1" },
          { kind: "board", ref: "q".repeat(3_000) },
        ],
      },
    });
    expect(result.kind).toBe("committed");
    const rows = await stored(canvas.id, { empty: true });
    expect(rows.find((row) => row.kind === "canvas")?.text).toBe("z".repeat(7_999));
    expect(rows.find((row) => row.kind === "page" && row.ref === "pg_1")?.text).toBe("nul�");
    expect(rows.find((row) => row.kind === "board" && row.ref === "ab_1")?.text).toBe("");
    expect(rows.some((row) => row.ref.length > 1_000)).toBe(false);
  });
});

describe("postMessage", () => {
  test("indexes the message with the item's id and seq, and answers with the item", async () => {
    const { canvas, user } = await canvasWith(emptyDoc("Lisbon"));
    const item = await postMessage(db, {
      canvasId: canvas.id,
      userId: user.id,
      item: { text: "Zebra stripes on the hero" },
      event: { text: "Zebra stripes on the hero" },
      search: {
        text: "Zebra stripes on the hero",
        author: { kind: "user", id: user.id, name: "Bryce" },
      },
    });
    expect(item.createdAt).toBeInstanceOf(Date);
    expect(item).toMatchObject({ canvasId: canvas.id, kind: "message", userId: user.id });
    expect(typeof item.seq).toBe("number");
    const message = (await stored(canvas.id)).find((row) => row.kind === "message");
    expect(message).toEqual({
      kind: "message",
      ref: item.id,
      text: "Zebra stripes on the hero",
      folded: "zebra stripes on the hero",
      context: { kind: "message", itemSeq: item.seq },
      authorKind: "user",
      authorId: user.id,
      authorName: "Bryce",
      at: item.createdAt.toISOString(),
    });
  });

  test("indexes nothing without search, or for a message with no text", async () => {
    const { canvas, user } = await canvasWith(emptyDoc("Lisbon"));
    await postMessage(db, { canvasId: canvas.id, userId: user.id, item: { text: "a" }, event: {} });
    await postMessage(db, {
      canvasId: canvas.id,
      userId: user.id,
      item: { text: "" },
      event: {},
      search: { text: "", author: { kind: "user", id: user.id, name: "Bryce" } },
    });
    expect((await stored(canvas.id)).map((row) => row.kind)).toEqual(["canvas"]);
  });

  test("a deleted account's name leaves its entries, and nobody else's", async () => {
    const { canvas, user } = await canvasWith(emptyDoc("Lisbon"));
    const other = await seedUser(db);
    const say = (userId: string, name: string) =>
      postMessage(db, {
        canvasId: canvas.id,
        userId,
        item: { text: "Zebra" },
        event: {},
        search: { text: "Zebra", author: { kind: "user", id: userId, name } },
      });
    const theirs = await say(user.id, "Bryce");
    const kept = await say(other.id, "Ada");
    expect(await anonymiseUser(db, user.id)).toBeGreaterThan(0);
    const names = Object.fromEntries(
      (await stored(canvas.id))
        .filter((row) => row.kind === "message")
        .map((row) => [row.ref, row.authorName]),
    );
    expect(names).toEqual({ [theirs.id]: DELETED_PERSON.name, [kept.id]: "Ada" });
  });
});

describe("upsertSearchEntries", () => {
  const answer = (text: string): SearchEntry => ({
    kind: "message",
    ref: "ti_answer",
    text,
    context: { kind: "message", itemSeq: 9 },
    author: { kind: "agent", id: null, name: "Ponzu" },
    at: Date.UTC(2026, 10, 12),
  });

  test("writes once, changes nothing when written again, and updates what differs", async () => {
    const { canvas } = await canvasWith(emptyDoc("Lisbon"));
    expect(await upsertSearchEntries(db, { canvasId: canvas.id, entries: [answer("Done.")] })).toBe(
      1,
    );
    expect(await upsertSearchEntries(db, { canvasId: canvas.id, entries: [answer("Done.")] })).toBe(
      0,
    );
    expect(await upsertSearchEntries(db, { canvasId: canvas.id, entries: [answer("Done!")] })).toBe(
      1,
    );
    const row = (await stored(canvas.id)).find((r) => r.kind === "message");
    expect(row).toMatchObject({
      text: "Done!",
      authorKind: "agent",
      authorId: null,
      at: "2026-11-12T00:00:00.000Z",
    });
  });

  test("writes nothing, and does not fail, for a canvas that is not there", async () => {
    expect(await upsertSearchEntries(db, { canvasId: "cnv_gone", entries: [answer("x")] })).toBe(0);
    expect(await upsertSearchEntries(db, { canvasId: "cnv_gone", entries: [] })).toBe(0);
  });
});

describe("recordPullRequestRead", () => {
  async function prCanvas() {
    const [user, workspace] = await Promise.all([seedUser(db), seedWorkspace(db)]);
    const repo = await seedRepo(db, workspace.id, `north-brook/zebra-${opIds++}`);
    const canvas = await createCanvas(db, {
      workspaceId: workspace.id,
      repoId: repo.id,
      ownerId: user.id,
      claudeAccountId: null,
      name: "Checkout",
      branch: "pz/checkout",
      doc: emptyDoc("Checkout"),
    });
    return canvas;
  }
  const read = (canvasId: string, number: number, title: string, second: number) => ({
    canvasId,
    number,
    title,
    state: "open" as const,
    checks: "running" as const,
    mergeable: null,
    autoMerge: false,
    updatedAt: new Date(Date.UTC(2026, 10, 10, 12, 0, second)),
    readAt: new Date(Date.UTC(2026, 10, 10, 12, 0, second)),
  });
  const prRows = async (canvasId: string) =>
    db
      .select()
      .from(searchEntries)
      .where(and(eq(searchEntries.canvasId, canvasId), eq(searchEntries.kind, "pull_request")))
      .orderBy(searchEntries.ref);

  test("keeps one entry per pull request, written only when its title changes", async () => {
    const canvas = await prCanvas();
    expect(
      await recordPullRequestRead(db, read(canvas.id, 412, "Zebra checkout", 1)),
    ).not.toBeNull();
    const [first] = await prRows(canvas.id);
    expect(first).toMatchObject({
      ref: "412",
      text: "#412 Zebra checkout",
      folded: " 412 zebra checkout",
      context: { kind: "pull_request", number: 412 },
      authorKind: null,
      at: null,
    });

    // A check finishing: the row changes, the entry does not.
    expect(
      await recordPullRequestRead(db, {
        ...read(canvas.id, 412, "Zebra checkout", 2),
        checks: "passing",
      }),
    ).not.toBeNull();
    expect(await prRows(canvas.id)).toEqual([first!]);

    // The same read again changes nothing at all; a new title alone changes only the entry.
    expect(
      await recordPullRequestRead(db, {
        ...read(canvas.id, 412, "Zebra checkout", 2),
        checks: "passing",
      }),
    ).toBeNull();
    expect(await prRows(canvas.id)).toEqual([first!]);
    await recordPullRequestRead(db, {
      ...read(canvas.id, 412, "Zebra checkout v2", 2),
      checks: "passing",
    });
    expect((await prRows(canvas.id)).map((row) => row.text)).toEqual(["#412 Zebra checkout v2"]);

    // A later pull request from the branch: the earlier one keeps its entry.
    await recordPullRequestRead(db, read(canvas.id, 500, "Second try", 3));
    expect((await prRows(canvas.id)).map((row) => row.text)).toEqual([
      "#412 Zebra checkout v2",
      "#500 Second try",
    ]);
  });

  test("writes nothing, and does not fail, for a canvas that is not there", async () => {
    expect(await recordPullRequestRead(db, read("cnv_gone", 1, "Nope", 1))).toBeNull();
    expect(await prRows("cnv_gone")).toEqual([]);
  });
});

describe("replaceDocSearchEntries", () => {
  test("replaces the document's entries at its seq and records the version", async () => {
    const doc = sampleDoc();
    const { canvas, user } = await canvasWith(structuredClone(doc));
    // Something that drifted, a removal left by a commit, and entries that are not the document's.
    await db
      .update(searchEntries)
      .set({ text: "stale", folded: "stale" })
      .where(
        and(
          eq(searchEntries.canvasId, canvas.id),
          eq(searchEntries.kind, "page"),
          eq(searchEntries.ref, "pg_2"),
        ),
      );
    await db.insert(searchEntries).values({
      canvasId: canvas.id,
      kind: "board",
      ref: "ab_gone",
      text: "",
      folded: "",
      context: { kind: "board", pageId: "pg_1" },
    });
    await postMessage(db, {
      canvasId: canvas.id,
      userId: user.id,
      item: { text: "zebra" },
      event: {},
      search: { text: "zebra", author: { kind: "user", id: user.id, name: "Bryce" } },
    });
    const { seq } = await commitWithSearch(canvas.id, 0, doc, SAMPLE_OPS["file.rename"]);
    await db.delete(searchState).where(eq(searchState.canvasId, canvas.id));

    const applied = await replaceDocSearchEntries(db, {
      canvasId: canvas.id,
      seq,
      entries: docSearchEntries(doc),
      version: SEARCH_VERSION,
    });
    expect(applied).toBe(true);
    const rows = await stored(canvas.id, { empty: true });
    expect(docKinds(rows)).toEqual(expected(doc));
    expect(rows.filter((row) => row.kind === "message").map((row) => row.text)).toEqual(["zebra"]);
    const [state] = await db.select().from(searchState).where(eq(searchState.canvasId, canvas.id));
    expect(state).toMatchObject({ version: SEARCH_VERSION, indexedSeq: seq });
  });

  test("writes nothing once the seq has moved, or for a canvas that is not there", async () => {
    const doc = sampleDoc();
    const { canvas } = await canvasWith(structuredClone(doc));
    const before = await stored(canvas.id, { empty: true });
    const applied = await replaceDocSearchEntries(db, {
      canvasId: canvas.id,
      seq: 3,
      entries: docSearchEntries(emptyDoc("Elsewhere")),
      version: SEARCH_VERSION + 1,
    });
    expect(applied).toBe(false);
    expect(await stored(canvas.id, { empty: true })).toEqual(before);
    const [state] = await db.select().from(searchState).where(eq(searchState.canvasId, canvas.id));
    expect(state?.version).toBe(SEARCH_VERSION);
    expect(
      await replaceDocSearchEntries(db, { canvasId: "cnv_gone", seq: 0, entries: [], version: 1 }),
    ).toBe(false);
  });

  test("refuses entries a document does not hold", async () => {
    const message: SearchEntry = {
      kind: "message",
      ref: "ti_1",
      text: "hi",
      context: { kind: "message", itemSeq: 1 },
      author: null,
      at: null,
    };
    await expect(
      replaceDocSearchEntries(db, { canvasId: "cnv_x", seq: 0, entries: [message], version: 1 }),
    ).rejects.toThrow("A document holds no message entries.");
  });
});

describe("queueSearchBackfill", () => {
  test("queues the canvases no reindex has done at this version, most active first, once", async () => {
    // Make this database's canvases all indexed at the version, so only the ones below count.
    await db.execute(sql`
      insert into search_state (canvas_id, version, indexed_seq, indexed_at)
      select id, ${SEARCH_VERSION}, 0, now() from canvases
      on conflict (canvas_id) do update set version = excluded.version
    `);
    const made = [];
    for (const name of ["old", "middle", "new"])
      made.push((await canvasWith(emptyDoc(name))).canvas);
    const [old, middle, recent] = made as [(typeof made)[0], (typeof made)[0], (typeof made)[0]];
    for (const [canvas, hour] of [
      [old, 1],
      [middle, 2],
      [recent, 3],
    ] as const) {
      await db
        .update(canvases)
        .set({ lastActivityAt: new Date(Date.UTC(2026, 10, 1, hour)) })
        .where(eq(canvases.id, canvas.id));
    }
    await db.delete(searchState).where(eq(searchState.canvasId, recent.id));
    await db
      .update(searchState)
      .set({ version: SEARCH_VERSION - 1 })
      .where(eq(searchState.canvasId, middle.id));
    await db.delete(searchState).where(eq(searchState.canvasId, old.id));

    const queued = async () =>
      (
        await db
          .select({ key: jobs.key })
          .from(jobs)
          .where(eq(jobs.kind, SEARCH_REINDEX_JOB))
          .orderBy(jobs.createdAt, jobs.id)
      ).map((job) => job.key);

    expect(await queueSearchBackfill(db, { limit: 2, version: SEARCH_VERSION })).toBe(2);
    expect(new Set(await queued())).toEqual(new Set([recent.id, middle.id]));
    // Two wait already, the most allowed at once: nothing more is queued.
    expect(await queueSearchBackfill(db, { limit: 2, version: SEARCH_VERSION })).toBe(0);
    // One is done (its reindex wrote the state), so one place is free: the third, and no more.
    await db
      .update(jobs)
      .set({ completedAt: new Date() })
      .where(and(eq(jobs.kind, SEARCH_REINDEX_JOB), eq(jobs.key, recent.id)));
    await db.insert(searchState).values({
      canvasId: recent.id,
      version: SEARCH_VERSION,
      indexedSeq: 0,
      indexedAt: new Date(),
    });
    expect(await queueSearchBackfill(db, { limit: 2, version: SEARCH_VERSION })).toBe(1);
    expect(await queueSearchBackfill(db, { limit: 2, version: SEARCH_VERSION })).toBe(0);
    expect((await queued()).sort()).toEqual([old.id, middle.id, recent.id].sort());
    // Due when the caller's clock says.
    const at = new Date(Date.UTC(2026, 0, 2));
    await db.delete(searchState).where(eq(searchState.canvasId, recent.id));
    await db
      .update(jobs)
      .set({ completedAt: new Date() })
      .where(and(eq(jobs.kind, SEARCH_REINDEX_JOB), eq(jobs.key, middle.id)));
    await db
      .update(searchState)
      .set({ version: SEARCH_VERSION })
      .where(eq(searchState.canvasId, middle.id));
    expect(await queueSearchBackfill(db, { limit: 2, version: SEARCH_VERSION, now: at })).toBe(1);
    const [again] = await db
      .select({ runAt: jobs.runAt })
      .from(jobs)
      .where(
        and(eq(jobs.kind, SEARCH_REINDEX_JOB), eq(jobs.key, recent.id), isNull(jobs.completedAt)),
      );
    expect(again?.runAt).toEqual(at);
    await db
      .update(jobs)
      .set({ completedAt: new Date() })
      .where(and(eq(jobs.kind, SEARCH_REINDEX_JOB), eq(jobs.key, recent.id)));
    await db.insert(searchState).values({
      canvasId: recent.id,
      version: SEARCH_VERSION,
      indexedSeq: 0,
      indexedAt: new Date(),
    });

    // A reindex that failed for good today is not queued again until tomorrow.
    await db
      .update(jobs)
      .set({ failedAt: new Date() })
      .where(and(eq(jobs.kind, SEARCH_REINDEX_JOB), eq(jobs.key, old.id)));
    expect(await queueSearchBackfill(db, { limit: 5, version: SEARCH_VERSION })).toBe(0);
    await db
      .update(jobs)
      .set({ failedAt: new Date(Date.now() - 2 * 86_400_000) })
      .where(and(eq(jobs.kind, SEARCH_REINDEX_JOB), eq(jobs.key, old.id)));
    expect(await queueSearchBackfill(db, { limit: 5, version: SEARCH_VERSION })).toBe(1);
    expect(await queueSearchBackfill(db, { limit: 0, version: SEARCH_VERSION })).toBe(0);
  });
});

test("deleting a canvas deletes its entries and its search state", async () => {
  const { canvas } = await canvasWith(sampleDoc());
  expect((await stored(canvas.id)).length).toBeGreaterThan(0);
  await db.delete(canvases).where(eq(canvases.id, canvas.id));
  expect(await stored(canvas.id, { empty: true })).toEqual([]);
  expect(await db.select().from(searchState).where(eq(searchState.canvasId, canvas.id))).toEqual(
    [],
  );
});
