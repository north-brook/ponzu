// Search's writes on a real Postgres: every statement that writes `search_entries` once (pg_trgm
// and the trigram index included), and a commit racing a reindex. Runs only when
// PONZU_TEST_DATABASE_URL names a migrated database (see ../live.ts); CI gives it a Postgres 18.
import { afterAll, expect, test } from "bun:test";
import {
  applyOp,
  type Doc,
  docSearchChanges,
  docSearchEntries,
  emptyDoc,
  type Op,
  SEARCH_VERSION,
  searchTerms,
} from "@ponzu/core";
import { sampleDoc } from "@ponzu/core/fixtures";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { Db } from "../client.ts";
import { agent, seedRepo, seedUser, seedWorkspace } from "../fixtures.ts";
import { describeLive } from "../live.ts";
import { jobs, searchEntries, searchState } from "../schema/index.ts";
import { upsertMembership } from "./accounts.ts";
import { createCanvas } from "./canvases.ts";
import { queryJson } from "./json.ts";
import { commitOps } from "./ops.ts";
import { recordPullRequestRead } from "./pull-requests.ts";
import {
  queueSearchBackfill,
  replaceDocSearchEntries,
  SEARCH_REINDEX_JOB,
  searchCanvases,
  searchStatement,
  toSearchRows,
  upsertSearchEntries,
} from "./search.ts";
import { postMessage } from "./thread.ts";

/** A canvas's entries that are not empty, as `toSearchRows` would make them, in key order. */
async function live(db: Db, canvasId: string, kinds?: string[]) {
  const rows = await db
    .select()
    .from(searchEntries)
    .where(eq(searchEntries.canvasId, canvasId))
    .orderBy(searchEntries.kind, searchEntries.ref);
  return rows
    .filter((row) => row.text !== "" && (!kinds || kinds.includes(row.kind)))
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

const DOC_KINDS = ["canvas", "page", "board", "comment"];
const sorted = <T extends { kind: string; ref: string }>(rows: T[]) =>
  rows.sort((a, b) =>
    a.kind === b.kind ? (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0) : a.kind < b.kind ? -1 : 1,
  );
const entriesOf = (doc: Doc) => sorted(toSearchRows(docSearchEntries(doc)));

describeLive("search entries on a real Postgres", ({ db, close }) => {
  afterAll(close);

  test("pg_trgm is installed and the index is a trigram one", async () => {
    const found = await queryJson<{ index: string; extensions: number }>(
      db,
      sql`
        select json_build_object(
          'index', (select indexdef from pg_indexes
                     where indexname = 'search_entries_folded_trgm_idx'),
          'extensions', (select count(*) from pg_extension where extname = 'pg_trgm')
        ) as result
      `,
    );
    expect(found?.index).toContain("USING gin (folded gin_trgm_ops)");
    expect(found?.extensions).toBe(1);
  });

  test("each statement that writes entries runs, once each", async () => {
    const [user, workspace] = await Promise.all([seedUser(db), seedWorkspace(db)]);
    const repo = await seedRepo(db, workspace.id, `north-brook/search-${Date.now()}`);
    const author = { kind: "user" as const, id: user.id, name: "Bryce" };
    const doc = sampleDoc();
    const canvas = await createCanvas(db, {
      workspaceId: workspace.id,
      repoId: repo.id,
      ownerId: user.id,
      claudeAccountId: null,
      name: doc.name,
      // The database outlives a run, and a repo seeded again is the same repo.
      branch: `pz/search-live-${Date.now()}`,
      doc,
      firstMessage: {
        item: { text: "Zebra first" },
        event: { text: "Zebra first" },
        search: { text: "Zebra first", author },
      },
    });
    expect(await live(db, canvas.id, DOC_KINDS)).toEqual(entriesOf(doc));

    const item = await postMessage(db, {
      canvasId: canvas.id,
      userId: user.id,
      item: { text: "Zebra second" },
      event: { text: "Zebra second" },
      search: { text: "Zebra second", author },
    });
    expect(item.createdAt).toBeInstanceOf(Date);

    const op: Op = { op: "page.delete", id: "pg_1" };
    const before = structuredClone(doc);
    const inverse = applyOp(doc, op);
    const committed = await commitOps(db, {
      canvasId: canvas.id,
      expectedSeq: 0,
      actor: agent,
      ops: [{ id: "live-1", op, inverse }],
      search: docSearchChanges(before, doc, [op])!,
    });
    expect(committed.kind).toBe("committed");
    expect(await live(db, canvas.id, DOC_KINDS)).toEqual(entriesOf(doc));

    expect(
      await upsertSearchEntries(db, {
        canvasId: canvas.id,
        entries: [
          {
            kind: "message",
            ref: "ti_answer",
            text: "Zebra answer",
            context: { kind: "message", itemSeq: 1 },
            author: { kind: "agent", id: null, name: "Ponzu" },
            at: Date.now(),
          },
        ],
      }),
    ).toBe(1);

    const at = new Date();
    await recordPullRequestRead(db, {
      canvasId: canvas.id,
      number: 412,
      title: "Zebra checkout",
      state: "open",
      checks: "none",
      mergeable: null,
      autoMerge: false,
      updatedAt: at,
      readAt: at,
    });

    expect(
      await replaceDocSearchEntries(db, {
        canvasId: canvas.id,
        seq: 1,
        entries: docSearchEntries(doc),
        version: SEARCH_VERSION,
      }),
    ).toBe(true);
    const rows = await live(db, canvas.id);
    expect(rows.filter((row) => DOC_KINDS.includes(row.kind))).toEqual(entriesOf(doc));
    // The reindex leaves what the document does not hold alone.
    expect(
      new Set(rows.filter((row) => !DOC_KINDS.includes(row.kind)).map((row) => row.text)),
    ).toEqual(new Set(["Zebra first", "Zebra second", "Zebra answer", "#412 Zebra checkout"]));

    // The backfill, on this canvas alone: everything else in the database is marked done.
    await db.execute(sql`
      insert into search_state (canvas_id, version, indexed_seq, indexed_at)
      select id, ${SEARCH_VERSION}, 0, now() from canvases
      on conflict (canvas_id) do update set version = greatest(search_state.version, excluded.version)
    `);
    await db.delete(searchState).where(eq(searchState.canvasId, canvas.id));
    expect(await queueSearchBackfill(db, { limit: 5, version: SEARCH_VERSION })).toBe(1);
    expect(await queueSearchBackfill(db, { limit: 5, version: SEARCH_VERSION })).toBe(0);
    // Leave no job behind for the tests that claim every job.
    await db
      .delete(jobs)
      .where(and(eq(jobs.kind, SEARCH_REINDEX_JOB), inArray(jobs.key, [canvas.id])));
  }, 60_000);

  test("a commit racing a reindex ends equal to the final document", async () => {
    const [user, workspace] = await Promise.all([seedUser(db), seedWorkspace(db)]);
    const doc = sampleDoc();
    const canvas = await createCanvas(db, {
      workspaceId: workspace.id,
      repoId: null,
      ownerId: user.id,
      claudeAccountId: null,
      name: doc.name,
      branch: null,
      doc: structuredClone(doc),
    });
    let seq = 0;
    let replacedFirst = 0;
    let committedFirst = 0;
    for (let round = 0; round < 40; round++) {
      // As if the canvas had never been indexed: the reindex writes every entry, and the
      // commit removes ones it never saw written.
      if (round % 2 === 0)
        await db.delete(searchEntries).where(eq(searchEntries.canvasId, canvas.id));
      const atSeq = structuredClone(doc);
      const ops: Op[] = [
        { op: "page.create", index: 0, page: { id: `pg_r${round}`, name: `Round ${round}` } },
        { op: "file.rename", name: `Zebra ${round}` },
      ];
      if (round > 0) ops.push({ op: "page.delete", id: `pg_r${round - 1}` });
      const op: Op = { op: "batch", ops };
      const inverse = applyOp(doc, op);
      const replace = () =>
        replaceDocSearchEntries(db, {
          canvasId: canvas.id,
          seq,
          entries: docSearchEntries(atSeq),
          version: SEARCH_VERSION,
        });
      const commit = () =>
        commitOps(db, {
          canvasId: canvas.id,
          expectedSeq: seq,
          actor: agent,
          ops: [{ id: `race-${round}`, op, inverse }],
          search: docSearchChanges(atSeq, doc, [op])!,
        });
      // Sent at once, each going first in turn, so both orders are taken.
      const [replaced, committed] =
        round % 4 < 2
          ? await Promise.all([replace(), commit()])
          : await Promise.all([commit(), replace()]).then(([c, r]) => [r, c] as const);
      expect(committed.kind).toBe("committed");
      seq += 1;
      if (replaced) {
        // The reindex went first and the commit waited on it: the commit's changes landed on
        // what the reindex wrote, with nothing more to do.
        replacedFirst++;
      } else {
        // The commit went first: the reindex found the seq moved and, as the job does, reads
        // the document again and replaces at the new seq.
        committedFirst++;
        expect(
          await replaceDocSearchEntries(db, {
            canvasId: canvas.id,
            seq,
            entries: docSearchEntries(doc),
            version: SEARCH_VERSION,
          }),
        ).toBe(true);
      }
      expect([round, await live(db, canvas.id, DOC_KINDS)]).toEqual([round, entriesOf(doc)]);
    }
    // Which goes first is up to the connections; every round ended right whichever it was.
    expect(replacedFirst + committedFirst).toBe(40);
  }, 120_000);

  test("a commit that waits on a reindex's lock lands its changes on what the reindex wrote", async () => {
    // The order that needs commits to empty entries rather than delete them, held open on
    // purpose: the reindex writes every entry and holds the canvas, the commit starts, waits
    // for it, and then removes entries it could not see when it began.
    const pool = (db as unknown as { $client: unknown }).$client;
    if (!(pool instanceof pg.Pool)) return; // Neon's drivers are covered by the race above.
    const [user, workspace] = await Promise.all([seedUser(db), seedWorkspace(db)]);
    const doc = sampleDoc();
    const canvas = await createCanvas(db, {
      workspaceId: workspace.id,
      repoId: null,
      ownerId: user.id,
      claudeAccountId: null,
      name: doc.name,
      branch: null,
      doc: structuredClone(doc),
    });
    await db.delete(searchEntries).where(eq(searchEntries.canvasId, canvas.id));
    const atSeq = structuredClone(doc);
    const op: Op = {
      op: "batch",
      ops: [
        { op: "page.delete", id: "pg_1" },
        { op: "file.rename", name: "Zebra" },
      ],
    };
    const inverse = applyOp(doc, op);

    const client = await pool.connect();
    try {
      await client.query("begin");
      expect(
        await replaceDocSearchEntries(drizzle({ client }), {
          canvasId: canvas.id,
          seq: 0,
          entries: docSearchEntries(atSeq),
          version: SEARCH_VERSION,
        }),
      ).toBe(true);
      const committing = commitOps(db, {
        canvasId: canvas.id,
        expectedSeq: 0,
        actor: agent,
        ops: [{ id: "held-1", op, inverse }],
        search: docSearchChanges(atSeq, doc, [op])!,
      });
      // Until the commit is waiting on the canvas's row, with a deadline rather than a sleep.
      const deadline = Date.now() + 10_000;
      for (;;) {
        const waiting = await queryJson<{ n: number }>(
          db,
          sql`
            select json_build_object('n', count(*)) as result
              from pg_stat_activity
             where datname = current_database() and wait_event_type = 'Lock'
          `,
        );
        if ((waiting?.n ?? 0) > 0) break;
        if (Date.now() > deadline) throw new Error("The commit never waited on the reindex.");
        await new Promise((resolve) => setImmediate(resolve));
      }
      await client.query("commit");
      expect((await committing).kind).toBe("committed");
    } finally {
      client.release();
    }
    expect(await live(db, canvas.id, DOC_KINDS)).toEqual(entriesOf(doc));
  }, 60_000);

  test("a search for a word of 3 or more characters is served by the trigram index", async () => {
    // A guard on the plan, not on time: 20,000 entries over 20 canvases one person may read,
    // then ANALYZE, then what Postgres would do for a rare word and for a phrase.
    const [user, workspace] = await Promise.all([seedUser(db), seedWorkspace(db)]);
    await upsertMembership(db, { workspaceId: workspace.id, userId: user.id, role: "member" });
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const canvas = await createCanvas(db, {
        workspaceId: workspace.id,
        repoId: null,
        ownerId: user.id,
        claudeAccountId: null,
        name: `Plan ${i}`,
        branch: null,
        doc: emptyDoc(`Plan ${i}`),
      });
      ids.push(canvas.id);
    }
    // The database outlives a run, and the seeded person and workspace are the same each run,
    // so the rare word is this run's own.
    const rare = `zebrafish${Date.now().toString(36)}`;
    // md5's hex is lowercase letters and digits, so each text is already its own folding.
    await db.execute(sql`
      insert into search_entries (canvas_id, kind, ref, text, folded, context)
      select c.id, 'message', 'plan_' || g, t.text, t.text,
             jsonb_build_object('kind', 'message', 'itemSeq', g)
        from json_array_elements_text(${JSON.stringify(ids)}::json) with ordinality as c(id, i)
       cross join generate_series(1, 1000) g
       cross join lateral (
         select case when g = 500 and c.i < 4 then ${`${rare} tank `} else '' end
                || 'note ' || md5(c.i || ':' || g) || ' ' || md5(g || ':' || c.i) as text
       ) t
    `);
    // And 2,000 board names, a few of them starting with "pl".
    await db.execute(sql`
      insert into search_entries (canvas_id, kind, ref, text, folded, context)
      select c.id, 'board', 'ab_' || g, t.text, t.text,
             jsonb_build_object('kind', 'board', 'pageId', 'pg_1')
        from json_array_elements_text(${JSON.stringify(ids)}::json) with ordinality as c(id, i)
       cross join generate_series(1, 100) g
       cross join lateral (
         select case when g = 50 then 'planks ' else 'board ' end || md5(g || ':' || c.i) as text
       ) t
    `);
    // Every table the statement reads, as autovacuum would have them on a database in use.
    await db.execute(sql`analyze search_entries, canvases, memberships, repo_access, users`);

    for (const query of [rare, `"${rare} tank"`]) {
      const search = { workspaceId: workspace.id, userId: user.id, terms: searchTerms(query) };
      const { rows } = (await db.execute(
        sql`explain (format json) ${searchStatement(search)!}`,
      )) as unknown as { rows: Record<string, unknown>[] };
      expect(JSON.stringify(rows[0])).toContain('"Index Name":"search_entries_folded_trgm_idx"');
      const hits = await searchCanvases(db, search);
      expect(hits.messages.map((hit) => hit.canvasId).sort()).toEqual(ids.slice(0, 3).sort());
    }

    // Short words alone search names only, which an index serves (the names' trigram index, or
    // the key's when the person's canvases are few), never a read of the whole table.
    const short = { workspaceId: workspace.id, userId: user.id, terms: searchTerms("pl") };
    const { rows } = (await db.execute(
      sql`explain (format json) ${searchStatement(short)!}`,
    )) as unknown as { rows: Record<string, unknown>[] };
    const scans: string[] = [];
    const walk = (node: Record<string, unknown>) => {
      if (node["Relation Name"] === "search_entries") scans.push(String(node["Node Type"]));
      for (const child of (node.Plans as Record<string, unknown>[] | undefined) ?? []) walk(child);
    };
    walk((rows[0]!["QUERY PLAN"] as { Plan: Record<string, unknown> }[])[0]!.Plan);
    expect(scans.length).toBeGreaterThan(0);
    expect(scans).not.toContain("Seq Scan");
    expect((await searchCanvases(db, short)).boards.map((hit) => hit.text.slice(0, 6))).toEqual(
      Array(8).fill("planks"),
    );
  }, 120_000);
});
