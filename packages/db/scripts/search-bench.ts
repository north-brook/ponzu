// How fast search's statement is on a real Postgres, by hand:
//
//   PONZU_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/ponzu_test \
//     bun packages/db/scripts/search-bench.ts [--sizes 10000,100000,1000000] [--runs 30] [--keep]
//
// The database must be migrated, and its name must contain "test" (see ../README.md for the
// docker line). For each size it makes one workspace whose one member can read every canvas,
// fills it with that many entries in a realistic mix (names of 2 to 6 words, comments and
// messages of 5 to 60, agent answers of 50 to 400, pull request titles, a few in CJK), drawn
// from a fixed word list by a fixed seed, runs ANALYZE, then times `runs` searches of each query
// shape through `searchCanvases` and prints p50, p95 and EXPLAIN (ANALYZE, BUFFERS) of each.
// The workspaces it made are deleted at the end unless --keep is given.
//
// Targets (docs/cloud.md "Search"): p50 at most 20 ms and p95 at most 50 ms up to 100,000 entries.
import { parseArgs } from "node:util";
import { emptyDoc, foldForSearch, searchTerms } from "@ponzu/core";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { Db } from "../src/client.ts";
import { upsertMembership, upsertUser, upsertWorkspace } from "../src/queries/accounts.ts";
import { createCanvas } from "../src/queries/canvases.ts";
import { searchCanvases, searchStatement } from "../src/queries/search.ts";

const { values } = parseArgs({
  options: {
    sizes: { type: "string", default: "10000,100000" },
    runs: { type: "string", default: "30" },
    keep: { type: "boolean", default: false },
  },
});
const sizes = values.sizes.split(",").map(Number);
const runs = Number(values.runs);

const url = process.env.PONZU_TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.includes("test")) {
  console.error('Set PONZU_TEST_DATABASE_URL to a migrated database with "test" in its name.');
  process.exit(1);
}

/** Words a product team writes; lowercase ASCII, so a text of them is its own folding. */
const WORDS = (
  "button color primary secondary layout spacing header footer sidebar modal dialog form " +
  "input field label error warning success toast banner card grid column row stack image " +
  "icon avatar badge chip tab menu dropdown select checkbox radio toggle switch slider " +
  "progress spinner loading empty state onboarding signup login checkout cart payment price " +
  "plan pricing team member invite settings profile account billing invoice receipt " +
  "dashboard chart table filter sort search results list detail page screen flow step " +
  "mobile desktop tablet responsive dark light theme token type scale font weight size " +
  "border radius shadow motion hover focus pressed disabled copy headline body caption " +
  "link nav breadcrumb pagination tooltip popover drawer sheet overlay hero feature " +
  "testimonial quote logo brand palette contrast accessible tighter looser bigger smaller " +
  "align center left right top bottom margin padding gap ship review feedback idea draft " +
  "final version option variant compare prefer keep remove add change fix make try"
).split(" ");
/** Kanji and Hangul that fold to themselves. */
const CJK = "東京 設計 検索 화면 버튼";

for (const word of [...WORDS, ...CJK.split(" ")]) {
  if (foldForSearch(word) !== word) throw new Error(`"${word}" is not its own folding.`);
}

const SHAPES: [label: string, query: string][] = [
  ["rare word", "zebra"],
  ["common word", "button"],
  ["2-character name prefix", "bu"],
  ["two words", "button color"],
  ["phrase", '"primary button"'],
  ["#412", "#412"],
  ["no hit", "qqqzzx"],
  ["6 terms", "button color primary layout spacing header"],
  ["CJK", "検索"],
];

const client = new pg.Pool({ connectionString: url, max: 4 });
const db = drizzle({ client }) as unknown as Db;

const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;

let githubId = 900_000_000 + Math.floor(Math.random() * 1_000_000);
const made: string[] = [];
const people: string[] = [];

try {
  const [{ datctype }] = (
    (await db.execute(
      sql`select datctype from pg_database where datname = current_database()`,
    )) as unknown as { rows: { datctype: string }[] }
  ).rows as [{ datctype: string }];
  const version = (
    (await db.execute(sql`show server_version`)) as unknown as {
      rows: { server_version: string }[];
    }
  ).rows[0]!.server_version;
  console.log(`Postgres ${version}, ctype ${datctype}, ${runs} runs a shape\n`);

  for (const size of sizes) {
    const id = githubId++;
    const { created: _c, ...user } = await upsertUser(db, {
      workosUserId: `bench_${id}`,
      githubUserId: id,
      githubLogin: `bench-${id}`,
      name: "Bench",
      email: null,
      avatarUrl: null,
    });
    const { connected: _w, ...workspace } = await upsertWorkspace(db, {
      githubAccountId: id,
      githubLogin: `bench-${id}`,
      kind: "org",
      name: "Bench",
      avatarUrl: null,
      installationId: id,
      repositorySelection: "all",
      installedByUserId: null,
    });
    made.push(workspace.id);
    people.push(user.id);
    await upsertMembership(db, { workspaceId: workspace.id, userId: user.id, role: "member" });

    const canvasCount = Math.max(1, Math.min(2_000, Math.round(size / 100)));
    const started = performance.now();
    const ids: string[] = [];
    for (let i = 0; i < canvasCount; i++) {
      const name = `${WORDS[i % WORDS.length]} ${WORDS[(i * 7) % WORDS.length]} ${i}`;
      const canvas = await createCanvas(db, {
        workspaceId: workspace.id,
        repoId: null,
        ownerId: user.id,
        claudeAccountId: null,
        name,
        branch: null,
        doc: emptyDoc(name),
      });
      ids.push(canvas.id);
    }
    // The canvases' own entries (their names and first pages) count toward the size.
    await db.execute(sql`
      with w as (
        select array(select json_array_elements_text(${JSON.stringify(WORDS)}::json)) as words,
               array(select json_array_elements_text(${JSON.stringify(ids)}::json)) as ids
      ),
      r as (
        select g, w.ids[1 + g % ${canvasCount}] as canvas_id,
               (hashtext('mix:' || g) & 2147483647) % 100 as mix,
               (hashtext('len:' || g) & 2147483647) as h
          from generate_series(1, ${size}) g, w
      ),
      shaped as (
        select r.g, r.canvas_id,
               case when r.g = 412 or r.mix >= 95 then 'pull_request'
                    when r.mix < 15 then 'page'
                    when r.mix < 30 then 'board'
                    when r.mix < 70 then 'comment'
                    else 'message' end as kind,
               case when r.g = 412 or r.mix >= 95 then 3 + r.h % 6
                    when r.mix < 30 then 2 + r.h % 5
                    when r.mix < 85 then 5 + r.h % 56
                    else 50 + r.h % 351 end as len
          from r
      ),
      texts as (
        select s.*,
               case when s.g % 10007 = 0 then 'zebra ' else '' end
               || case when s.g % 997 = 0 then ${`${CJK} `} else '' end
               || (select string_agg(w.words[1 + (hashtext('w:' || s.g || ':' || k) & 2147483647) % ${WORDS.length}], ' ')
                     from generate_series(1, s.len) k) as body
          from shaped s, w
      )
      insert into search_entries (canvas_id, kind, ref, text, folded, context, author_kind,
                                  author_id, at)
      select t.canvas_id, t.kind,
             case when t.kind = 'pull_request' then t.g::text else 'b' || t.g end,
             case when t.kind = 'pull_request' then '#' || t.g || ' ' || t.body else t.body end,
             case when t.kind = 'pull_request' then ' ' || t.g || ' ' || t.body else t.body end,
             case t.kind
               when 'page' then jsonb_build_object('kind', 'page')
               when 'board' then jsonb_build_object('kind', 'board', 'pageId', 'pg_1')
               when 'comment' then jsonb_build_object(
                 'kind', 'comment', 'threadId', 'th_' || t.g, 'messageId', 'm_1',
                 'pageId', null, 'artboardId', null, 'resolved', false)
               when 'message' then jsonb_build_object('kind', 'message', 'itemSeq', t.g)
               else jsonb_build_object('kind', 'pull_request', 'number', t.g) end,
             case when t.kind in ('comment', 'message') then 'user' end,
             case when t.kind in ('comment', 'message') then ${user.id} end,
             case when t.kind in ('comment', 'message')
                  then now() - ((hashtext('at:' || t.g) & 2147483647) % 365) * interval '1 day' end
        from texts t
    `);
    // Every table the statement reads, as autovacuum would have them on a database in use.
    await db.execute(sql`analyze search_entries, canvases, memberships, repo_access, users`);
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    console.log(
      `## ${size.toLocaleString("en")} entries over ${canvasCount} canvases (seeded in ${seconds} s)\n`,
    );
    console.log("| shape | p50 ms | p95 ms | hits |");
    console.log("|---|---|---|---|");

    const plans: string[] = [];
    for (const [label, query] of SHAPES) {
      const search = { workspaceId: workspace.id, userId: user.id, terms: searchTerms(query) };
      await searchCanvases(db, search);
      const times: number[] = [];
      let hits = 0;
      for (let i = 0; i < runs; i++) {
        const start = performance.now();
        const answer = await searchCanvases(db, search);
        times.push(performance.now() - start);
        hits = Object.values(answer).reduce((n, group) => n + group.length, 0);
      }
      times.sort((a, b) => a - b);
      console.log(
        `| ${label} (${query}) | ${percentile(times, 50).toFixed(1)} | ${percentile(times, 95).toFixed(1)} | ${hits} |`,
      );
      const statement = searchStatement(search);
      if (!statement) continue;
      const { rows } = (await db.execute(
        sql`explain (analyze, buffers) ${statement}`,
      )) as unknown as { rows: { "QUERY PLAN": string }[] };
      plans.push(`### ${label}\n\n${rows.map((row) => row["QUERY PLAN"]).join("\n")}\n`);
    }
    console.log(`\n${plans.join("\n")}`);
  }
} finally {
  if (!values.keep) {
    for (const workspaceId of made) {
      await db.execute(sql`delete from canvases where workspace_id = ${workspaceId}`);
      await db.execute(sql`delete from workspaces where id = ${workspaceId}`);
    }
    for (const userId of people) await db.execute(sql`delete from users where id = ${userId}`);
  }
  await client.end();
}
