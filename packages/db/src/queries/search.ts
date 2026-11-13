import {
  assertSearchTerm,
  foldForSearch,
  SEARCH_SHORT_TERM,
  type SearchAuthor,
  type SearchContext,
  type SearchEntry,
  type SearchKind,
  type SearchTerm,
  searchText,
} from "@ponzu/core";
import { type SQL, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { newId } from "../ids.ts";
import { canvases, type PrState, searchEntries } from "../schema/index.ts";
import { DELETED_PERSON } from "./account-deletion.ts";
import { queryJson } from "./json.ts";
import { readableCanvases } from "./readable.ts";
import { run } from "./run.ts";
import { isStorable, scrubbed } from "./text.ts";

/*
 * Search entries (`search_entries`), written by the statement that changes their source: the
 * commit statement for a canvas's name, pages, boards and comments (`commit` in ops.ts),
 * `createCanvas`, `postMessage`, `recordPullRequestRead`; and by the statements here, for the
 * agent's settled answers and for a whole canvas's reindex. `searchCanvases`, at the end, reads
 * them for a search.
 *
 * No write here can fail on what a row holds. The rows are made by `toSearchRows`, which keeps
 * one row per key, makes every string storable and drops what an index could refuse, and the
 * table has no check constraints. That matters most in the commit statement, where a failed
 * entry would fail the commit.
 */

/** The job kind that rebuilds one canvas's entries; its key is the canvas id. */
export const SEARCH_REINDEX_JOB = "search.reindex";

/** The kinds a canvas's document holds, which a reindex replaces whole. */
export const DOC_SEARCH_KINDS = [
  "canvas",
  "page",
  "board",
  "comment",
] as const satisfies readonly SearchKind[];

/** A key of an entry within its canvas. */
export interface SearchKey {
  kind: SearchKind;
  ref: string;
}

/** An entry as a statement takes it: the entry, folded, as json. */
export interface SearchRow {
  kind: SearchKind;
  ref: string;
  text: string;
  folded: string;
  context: SearchContext;
  authorKind: SearchAuthor["kind"] | null;
  authorId: string | null;
  authorName: string | null;
  /** ISO 8601, or null. */
  at: string | null;
}

/** A person's thread message to index with it: its text and who wrote it. */
export interface MessageSearch {
  text: string;
  author: SearchAuthor;
}

/**
 * The longest ref, in UTF-8 bytes, that is stored. A btree key over about 2,700 bytes is refused,
 * which in the commit statement would fail the commit. Ids are at most 64 characters, so no ref
 * a document can hold today comes near it.
 */
const REF_MAX_BYTES = 1024;

/** Times Postgres's timestamptz and JavaScript's Date can both hold: 0001-01-01 to 9999-12-31. */
const EARLIEST_AT = -62_135_596_800_000;
const LATEST_AT = 253_402_300_799_999;

const NUL = /\u0000/g;
/** Text with each NUL and each lone surrogate made U+FFFD, clipped to SEARCH_TEXT_MAX. */
const storableText = (text: string) => searchText(text.replace(NUL, "�"));
/** Whether a ref can be a key: storable as it is, and short enough for the primary key's index. */
const indexableRef = (ref: string) => isStorable(ref) && utf8.encode(ref).length <= REF_MAX_BYTES;
const utf8 = new TextEncoder();

/**
 * Entries as rows for a statement. The first entry of each key wins and the rest are dropped,
 * so no statement ever carries one key twice, which `insert … on conflict` refuses. An entry
 * whose ref Postgres could not store or index is dropped. Text is `searchText`'d again with each
 * NUL made U+FFFD, and an entry whose text is then empty is dropped. A time outside the years
 * 1 to 9999 is stored as null.
 */
export function toSearchRows(entries: readonly SearchEntry[]): SearchRow[] {
  const rows: SearchRow[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.kind}:${entry.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!indexableRef(entry.ref)) continue;
    const text = storableText(entry.text);
    if (!text) continue;
    rows.push({
      kind: entry.kind,
      ref: entry.ref,
      text,
      folded: foldForSearch(text),
      context: scrubbed(entry.context),
      authorKind: entry.author?.kind ?? null,
      authorId: entry.author?.id == null ? null : storableText(entry.author.id),
      authorName: entry.author == null ? null : storableText(entry.author.name),
      at: atParam(entry.at),
    });
  }
  return rows;
}

function atParam(at: number | null): string | null {
  if (at === null || !Number.isFinite(at) || at < EARLIEST_AT || at > LATEST_AT) return null;
  return new Date(at).toISOString();
}

/** Keys as a statement takes them: one each, storable, and none a row could not have. */
export function toSearchKeys(keys: readonly SearchKey[]): SearchKey[] {
  const out: SearchKey[] = [];
  const seen = new Set<string>();
  for (const { kind, ref } of keys) {
    const key = `${kind}:${ref}`;
    if (seen.has(key) || !indexableRef(ref)) continue;
    seen.add(key);
    out.push({ kind, ref });
  }
  return out;
}

/**
 * `insert into search_entries` of `rows` (json text of `SearchRow`s) for one canvas, when
 * `gate` holds, updating an entry already there only when something in it differs. For a
 * statement's `with`.
 *
 * A person author whose id names no `users` row deleted their account (docs/cloud.md "Deleting
 * an account"), and is stored as `DELETED_PERSON`, whatever name the source still carries: a
 * document's comments keep the name they were written with, so a commit that touches such a
 * thread, or a reindex, would otherwise write that name back after `anonymiseUser` took it out.
 */
export function upsertSearchRows(canvasId: string, rows: string, gate: SQL): SQL {
  return sql`
    insert into search_entries as s (
      canvas_id, kind, ref, text, folded, context, author_kind, author_id, author_name, at
    )
    select ${canvasId}, r->>'kind', r->>'ref', r->>'text', r->>'folded', (r->'context')::jsonb,
           r->>'authorKind', r->>'authorId',
           case
             when r->>'authorKind' = 'user' and r->>'authorId' is not null
                  and not exists (select 1 from users u where u.id = r->>'authorId')
             then ${DELETED_PERSON.name}
             else r->>'authorName'
           end,
           (r->>'at')::timestamptz
      from json_array_elements(${rows}::json) r
     where ${gate}
    on conflict (canvas_id, kind, ref) do update
       set text = excluded.text,
           folded = excluded.folded,
           context = excluded.context,
           author_kind = excluded.author_kind,
           author_id = excluded.author_id,
           author_name = excluded.author_name,
           at = excluded.at,
           updated_at = now()
     where (s.text, s.context, s.author_kind, s.author_id, s.author_name, s.at)
           is distinct from
           (excluded.text, excluded.context, excluded.author_kind, excluded.author_id,
            excluded.author_name, excluded.at)
  `;
}

/**
 * Empty the entries of `keys` (json text of `SearchKey`s) for one canvas, when `gate` holds:
 * how a commit removes an entry. It is an upsert rather than a delete because only an upsert
 * reaches a row that a reindex committed after this statement began (a delete sees the rows as
 * they were when it began), and a commit can wait on a reindex's lock of the canvas and go on
 * once it has written. A key with no row gets an empty one. An empty entry matches no search,
 * and the canvas's next reindex deletes it.
 */
export function emptySearchRows(canvasId: string, keys: string, gate: SQL): SQL {
  return sql`
    insert into search_entries as s (canvas_id, kind, ref, text, folded, context)
    select ${canvasId}, k->>'kind', k->>'ref', '', '', jsonb_build_object('kind', k->>'kind')
      from json_array_elements(${keys}::json) k
     where ${gate}
    on conflict (canvas_id, kind, ref) do update
       set text = '', folded = '', author_kind = null, author_id = null, author_name = null,
           at = null, updated_at = now()
     where s.text <> ''
  `;
}

/**
 * `insert into search_entries` of a person's message, whose thread item `item` (a `with` name)
 * inserts in the same statement: the entry's ref is the item's id, and its `itemSeq` and time
 * are the item's, which only the inserted row knows. Null when the message has no text to find.
 */
export function insertMessageRow(
  canvasId: string,
  search: MessageSearch,
  item: string,
): SQL | null {
  const [row] = toSearchRows([
    {
      kind: "message",
      ref: "",
      text: search.text,
      context: { kind: "message", itemSeq: 0 },
      author: search.author,
      at: null,
    },
  ]);
  if (!row) return null;
  const from = sql.identifier(item);
  return sql`
    insert into search_entries (
      canvas_id, kind, ref, text, folded, context, author_kind, author_id, author_name, at
    )
    select ${canvasId}, 'message', ${from}.id, ${row.text}, ${row.folded},
           jsonb_build_object('kind', 'message', 'itemSeq', ${from}.seq),
           ${row.authorKind}, ${row.authorId}, ${row.authorName}, ${from}.created_at
      from ${from}
  `;
}

/**
 * Upsert entries of one canvas, in one statement: the agent's settled answers, which the
 * runner's thread write does not carry. Idempotent: writing the same entries again changes
 * nothing. Nothing is written when there is no such canvas. Answers how many rows were written.
 */
export async function upsertSearchEntries(
  db: Db,
  { canvasId, entries }: { canvasId: string; entries: readonly SearchEntry[] },
): Promise<number> {
  const rows = toSearchRows(entries);
  if (rows.length === 0) return 0;
  const result = await queryJson<{ written: number }>(
    db,
    sql`
      with target as (
        -- Holds off a delete of the canvas until this statement is done, so the rows below are
        -- never left pointing at a canvas that went in between.
        select id from canvases where id = ${canvasId} for key share
      ),
      written as (
        ${upsertSearchRows(canvasId, JSON.stringify(rows), sql`exists (select 1 from target)`)}
        returning 1
      )
      select json_build_object('written', (select count(*) from written)) as result
    `,
  );
  return result?.written ?? 0;
}

/**
 * Replace a canvas's document entries (its name, pages, boards and comments) with `entries`,
 * the document's entries as of `seq`, and record that `version` of the rules indexed it there.
 * One statement, which writes only while the canvas is still at `seq`, and holds the canvas's row
 * while it does: a commit waits for it, or it finds the seq moved and writes nothing. True when
 * it wrote; false when the seq moved (read the document again and retry) or there is no such
 * canvas.
 *
 * Every row of these kinds whose key is not in `entries` is deleted, including the empty rows
 * commits leave. Messages and pull requests are not touched.
 */
export async function replaceDocSearchEntries(
  db: Db,
  {
    canvasId,
    seq,
    entries,
    version,
  }: { canvasId: string; seq: number; entries: readonly SearchEntry[]; version: number },
): Promise<boolean> {
  const kinds = new Set<string>(DOC_SEARCH_KINDS);
  const other = entries.find((entry) => !kinds.has(entry.kind));
  if (other) throw new Error(`A document holds no ${other.kind} entries.`);
  const rows = JSON.stringify(toSearchRows(entries));
  const result = await queryJson<{ applied: boolean }>(
    db,
    sql`
      with locked as (
        select id from canvases where id = ${canvasId} and seq = ${seq} for update
      ),
      upserted as (
        ${upsertSearchRows(canvasId, rows, sql`exists (select 1 from locked)`)}
      ),
      removed as (
        delete from search_entries s
         where s.canvas_id = ${canvasId}
           and s.kind in ('canvas', 'page', 'board', 'comment')
           and exists (select 1 from locked)
           and not exists (
             select 1
               from json_array_elements(${rows}::json) r
              where r->>'kind' = s.kind and r->>'ref' = s.ref
           )
      ),
      stated as (
        insert into search_state (canvas_id, version, indexed_seq, indexed_at)
        select id, ${version}, ${seq}, now() from locked
        on conflict (canvas_id) do update
           set version = excluded.version,
               indexed_seq = excluded.indexed_seq,
               indexed_at = excluded.indexed_at
      )
      select json_build_object('applied', exists (select 1 from locked)) as result
    `,
  );
  return result?.applied ?? false;
}

/**
 * Queue a reindex (`SEARCH_REINDEX_JOB`) for up to `limit` canvases that no reindex has done
 * at `version`: those with no `search_state` row, or an older version. The most recently active
 * go first. A canvas with a reindex waiting already is passed over, and so is one whose reindex
 * failed for good in the last day, so a canvas that cannot be indexed is not queued every
 * minute. Each job's payload is `{ canvasId }` (`SearchReindexPayload`), as a handler is not
 * handed the job's key.
 *
 * At most `limit` reindexes wait at once: with that many waiting already, nothing more is
 * queued. The cron's jobs step takes the oldest due jobs first, so an unbounded backfill would
 * hold every other kind's retries behind it. Each is due at `now` (the caller's clock, so a
 * claim made with the same clock takes it; the database's own time when left out). Answers how
 * many were queued.
 */
export async function queueSearchBackfill(
  db: Db,
  { limit, version, now }: { limit: number; version: number; now?: Date },
): Promise<number> {
  if (limit <= 0) return 0;
  const ids = JSON.stringify(Array.from({ length: limit }, () => newId("job")));
  const runAt = now ? sql`${now.toISOString()}::timestamptz` : sql`now()`;
  const result = await queryJson<{ queued: number }>(
    db,
    sql`
      with due as (
        select c.id, row_number() over (order by c.last_activity_at desc, c.id) as n
          from canvases c
          left join search_state st on st.canvas_id = c.id
         where (st.canvas_id is null or st.version < ${version})
           and not exists (
             select 1
               from jobs j
              where j.kind = ${SEARCH_REINDEX_JOB}
                and j.key = c.id
                and j.completed_at is null
                and (j.failed_at is null or j.failed_at > now() - interval '1 day')
           )
         order by c.last_activity_at desc, c.id
         limit ${limit}
      ),
      waiting as (
        select count(*) as n
          from jobs j
         where j.kind = ${SEARCH_REINDEX_JOB} and j.completed_at is null and j.failed_at is null
      ),
      queued as (
        insert into jobs (id, kind, key, payload, run_at)
        select ids.id, ${SEARCH_REINDEX_JOB}, d.id, jsonb_build_object('canvasId', d.id), ${runAt}
          from due d
          join json_array_elements_text(${ids}::json) with ordinality as ids(id, n) on ids.n = d.n
         where d.n <= ${limit} - (select n from waiting)
        on conflict (kind, key) where completed_at is null and failed_at is null do nothing
        returning id
      )
      select json_build_object('queued', (select count(*) from queued)) as result
    `,
  );
  return result?.queued ?? 0;
}

/** What a `SEARCH_REINDEX_JOB` carries. */
export interface SearchReindexPayload {
  canvasId: string;
}

/**
 * Delete entries of one canvas by key, in one statement: a reindex taking out an agent's message
 * that its turn no longer names as the answer. Answers how many were deleted.
 */
export async function deleteSearchEntries(
  db: Db,
  { canvasId, keys }: { canvasId: string; keys: readonly SearchKey[] },
): Promise<number> {
  const wanted = toSearchKeys(keys);
  if (wanted.length === 0) return 0;
  const result = await queryJson<{ deleted: number }>(
    db,
    sql`
      with deleted as (
        delete from search_entries s
         using json_array_elements(${JSON.stringify(wanted)}::json) k
         where s.canvas_id = ${canvasId} and s.kind = k->>'kind' and s.ref = k->>'ref'
        returning 1
      )
      select json_build_object('deleted', (select count(*) from deleted)) as result
    `,
  );
  return result?.deleted ?? 0;
}

/**
 * Every entry of one canvas as stored, empty ones included, by kind and ref. For tests and the
 * reindex's checks; search reads through `searchCanvases`.
 */
export async function listSearchEntries(
  db: Db,
  canvasId: string,
): Promise<(typeof searchEntries.$inferSelect)[]> {
  return run(
    db
      .select()
      .from(searchEntries)
      .where(sql`${searchEntries.canvasId} = ${canvasId}`)
      .orderBy(searchEntries.kind, searchEntries.ref),
  );
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

/** The groups a search answers in, in the order they are shown. */
export const SEARCH_GROUPS = [
  "canvases",
  "boards",
  "comments",
  "messages",
  "pullRequests",
] as const;

export type SearchGroup = (typeof SEARCH_GROUPS)[number];

/** The kinds of entry each group holds. Pages and boards share one. */
export const SEARCH_GROUP_KINDS = {
  canvases: ["canvas"],
  boards: ["page", "board"],
  comments: ["comment"],
  messages: ["message"],
  pullRequests: ["pull_request"],
} as const satisfies Record<SearchGroup, readonly SearchKind[]>;

/** The most hits a group answers with. */
export const SEARCH_GROUP_CAPS = {
  canvases: 8,
  boards: 8,
  comments: 8,
  messages: 8,
  pullRequests: 4,
} as const satisfies Record<SearchGroup, number>;

/**
 * The groups searched only when some word of the query has at least SEARCH_SHORT_TERM
 * characters. Their entries are long, and a pattern of one or two characters gives the trigram
 * index almost nothing to narrow by, so a query of short words alone searches names only.
 */
const LONG_TEXT_GROUPS: readonly SearchGroup[] = ["comments", "messages"];

/**
 * How well a hit matches, best first: 0, its whole text is the query (or a pull request's number
 * is one of its terms); 1, its text starts with the query; 2, every term starts a word in it;
 * 3, every term is somewhere in it.
 */
export type SearchTier = 0 | 1 | 2 | 3;

/** A person who wrote a hit, as their `users` row now says. */
export interface SearchHitUser {
  id: string;
  name: string | null;
  login: string;
  avatarUrl: string | null;
}

/** One entry that matched, as `searchCanvases` answers it. */
export interface SearchHit {
  group: SearchGroup;
  kind: SearchKind;
  canvasId: string;
  /** The canvas's name as its row has it now. */
  canvasName: string;
  ref: string;
  /** As stored; match offsets are into this. */
  text: string;
  context: SearchContext;
  authorKind: SearchAuthor["kind"] | null;
  authorId: string | null;
  /** The name the source carried when it was indexed. */
  authorName: string | null;
  /**
   * The author's `users` row, when the author is a person and the row is there. A person author
   * whose id names no row is someone who deleted their account, or comes from an old document
   * that kept no id; the API says which.
   */
  authorUser: SearchHitUser | null;
  /** When it was said; null for names and pull requests. */
  at: Date | null;
  /** What ranked it within its tier: `at`, or else the canvas's last activity. */
  rankedAt: Date;
  tier: SearchTier;
  /** The canvas's current pull request, for a pull request hit's state. */
  canvasPr: { number: number; state: PrState | null } | null;
}

export type SearchHits = Record<SearchGroup, SearchHit[]>;

const noHits = (): SearchHits => ({
  canvases: [],
  boards: [],
  comments: [],
  messages: [],
  pullRequests: [],
});

interface HitRow extends Omit<SearchHit, "at" | "rankedAt" | "canvasPr"> {
  at: string | null;
  rankedAt: string;
  prNumber: number | null;
  prState: PrState | null;
}

/** Whether a term starts a word of `folded`: at its start, or after a space. */
function wordStart(term: SearchTerm, folded: SQL = sql`s.folded`): SQL {
  if (term.words.length > 1) return sql`${folded} ~ ${`(^| )${term.words.join(" +")}`}`;
  const word = term.words[0]!;
  return sql`(${folded} like ${`${word}%`} or ${folded} like ${`% ${word}%`})`;
}

/** One condition per term on the folded text, each one the trigram index can serve. */
function termFilter(term: SearchTerm): SQL {
  if (term.words.length > 1) {
    // The words are letters, digits and marks (asserted), so they go into a pattern as they are.
    return sql`s.folded ~ ${term.words.join(" +")}`;
  }
  const word = term.words[0]!;
  // A short term only at a word start.
  if (term.short) return wordStart(term);
  return sql`s.folded like ${`%${word}%`}`;
}

/**
 * The entries of one workspace that match `terms`, among the canvases `readableCanvases` lets
 * `userId` read, in one statement: at most SEARCH_GROUP_CAPS of each group asked for, ranked by
 * tier (`SearchTier`), then by recency (an entry's own time, or else its canvas's last
 * activity), then by canvas and key.
 *
 * Every term must match. A one-word term matches anywhere in the folded text, a short one (fewer
 * than SEARCH_SHORT_TERM characters) only at a word start, and a phrase its words in order, one
 * or more spaces apart: what `findMatches` marks. Comments and messages are searched only when
 * some word has SEARCH_SHORT_TERM characters or more. Empty entries (the ones commits leave)
 * never match. No terms, or no groups, answers no hits without asking the database.
 *
 * Terms reach the statement only as parameters, and each is checked by `assertSearchTerm` first,
 * so no LIKE wildcard, escape or regex metacharacter of the person's can reach a pattern. That
 * the person is a member is checked here too; that their repo access is recent is the caller's
 * to make sure of, as for the list.
 */
export async function searchCanvases(db: Db, search: SearchQuery): Promise<SearchHits> {
  const answer = noHits();
  const statement = searchStatement(search);
  if (!statement) return answer;
  const rows = await queryJson<HitRow[]>(db, statement);
  for (const { at, rankedAt, prNumber, prState, ...row } of rows ?? []) {
    answer[row.group].push({
      ...row,
      at: at === null ? null : new Date(at),
      rankedAt: new Date(rankedAt),
      canvasPr: prNumber === null ? null : { number: prNumber, state: prState },
    });
  }
  return answer;
}

/** What `searchCanvases` is asked. */
export interface SearchQuery {
  workspaceId: string;
  userId: string;
  terms: readonly SearchTerm[];
  /** Every group when left out. */
  groups?: readonly SearchGroup[];
}

/**
 * The one statement `searchCanvases` runs, or null when it would ask nothing. Apart so that a
 * test and the bench can ask Postgres for its plan.
 */
export function searchStatement({
  workspaceId,
  userId,
  terms,
  groups = SEARCH_GROUPS,
}: SearchQuery): SQL | null {
  for (const term of terms) assertSearchTerm(term);
  const hasLongWord = terms.some((term) =>
    term.words.some((word) => [...word].length >= SEARCH_SHORT_TERM),
  );
  const searched = SEARCH_GROUPS.filter(
    (group) => groups.includes(group) && (hasLongWord || !LONG_TEXT_GROUPS.includes(group)),
  );
  if (terms.length === 0 || searched.length === 0) return null;

  // The kinds are this module's own words, never the person's, and go in as literals so that
  // the planner can match them against a partial index.
  const kinds = sql.raw(
    searched.flatMap((group) => SEARCH_GROUP_KINDS[group].map((kind) => `'${kind}'`)).join(", "),
  );
  // Ranking works on the folded text as stored, runs of spaces and all, so it needs no
  // rewriting of each hit's text: a pattern allows one or more spaces wherever the query has one.
  const words = terms.flatMap((term) => term.words).join(" +");
  const exact = `^ *${words} *$`;
  const prefix = `^ *${words}`;
  // Only a text that starts with the first word, or with a space, can be either. That is far
  // cheaper to ask than a pattern, which Postgres runs over the whole text, so it is asked first.
  const first = terms[0]!.words[0]!;
  const opens = sql`(x.f like ${`${first}%`} or x.f like ' %')`;
  const numbers = terms
    .filter((term) => term.words.length === 1 && /^[0-9]{1,15}$/.test(term.words[0]!))
    .map((term) => sql`${String(Number(term.words[0]))}`);
  const byNumber = numbers.length
    ? sql`when s.kind = 'pull_request' and s.ref in (${sql.join(numbers, sql`, `)}) then 0`
    : sql``;
  const startsWords = sql.join(
    terms.map((term) => wordStart(term, sql`x.f`)),
    sql` and `,
  );
  const filters = sql.join(terms.map(termFilter), sql` and `);
  // Groups are ranked by number, which sorts faster than a name.
  const caps = sql.raw(
    searched
      .map((group) => `when ${SEARCH_GROUPS.indexOf(group)} then ${SEARCH_GROUP_CAPS[group]}`)
      .join(" "),
  );
  const groupName = sql.raw(SEARCH_GROUPS.map((group, i) => `when ${i} then '${group}'`).join(" "));

  // The hits are ranked on their keys alone, and only the few kept are read whole, so that a
  // common word's thousands of long texts are never sorted.
  return sql`
    with readable as (
      select ${canvases.id} as id, ${canvases.lastActivityAt} as last_activity_at
        from ${canvases}
       where ${readableCanvases({ workspaceId, userId })}
    ),
    matched as (
      select s.canvas_id, s.kind, s.ref,
             case s.kind
               when 'canvas' then 0
               when 'page' then 1
               when 'board' then 1
               when 'comment' then 2
               when 'message' then 3
               else 4
             end as grp,
             case
               when ${opens} and x.f ~ ${exact} then 0
               ${byNumber}
               when ${opens} and x.f ~ ${prefix} then 1
               when ${startsWords} then 2
               else 3
             end as tier,
             coalesce(s.at, r.last_activity_at) as ranked_at
        from search_entries s
        join readable r on r.id = s.canvas_id
        -- The folded text read out once per hit (a long one is stored compressed), for the
        -- tests that rank it; offset 0 keeps it from being read again for each of them.
        cross join lateral (select s.folded || '' as f offset 0) x
       where s.kind in (${kinds})
         and s.folded <> ''
         and ${filters}
    ),
    kept as (
      select numbered.*
        from (
          select m.*,
                 row_number() over (
                   partition by m.grp
                   order by m.tier, m.ranked_at desc, m.canvas_id collate "C",
                            m.kind collate "C", m.ref collate "C"
                 ) as n
            from matched m
        ) numbered
       where numbered.n <= case numbered.grp ${caps} else 0 end
    )
    select coalesce(json_agg(json_build_object(
             'group', case k.grp ${groupName} end,
             'kind', k.kind,
             'canvasId', k.canvas_id,
             'canvasName', c.name,
             'ref', k.ref,
             'text', s.text,
             'context', s.context,
             'authorKind', s.author_kind,
             'authorId', s.author_id,
             'authorName', s.author_name,
             'authorUser', case when u.id is null then null else json_build_object(
               'id', u.id, 'name', u.name, 'login', u.github_login, 'avatarUrl', u.avatar_url
             ) end,
             'at', s.at,
             'rankedAt', k.ranked_at,
             'tier', k.tier,
             'prNumber', c.pr_number,
             'prState', c.pr_state
           ) order by k.grp, k.n), '[]'::json) as result
      from kept k
      join search_entries s on s.canvas_id = k.canvas_id and s.kind = k.kind and s.ref = k.ref
      join ${canvases} c on c.id = k.canvas_id
      left join users u on s.author_kind = 'user' and u.id = s.author_id
  `;
}
