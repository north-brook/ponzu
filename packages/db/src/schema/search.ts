import type { SearchContext } from "@ponzu/core";
import { sql } from "drizzle-orm";
import { bigint, index, integer, jsonb, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { ACTOR_KINDS, SEARCH_KINDS } from "../enums.ts";
import { canvases } from "./canvases.ts";
import { instant, updatedAt } from "./columns.ts";

/**
 * One searchable thing on a canvas: its name, a page's or a board's name, a message of a
 * comment thread, a thread message (a person's, or the agent's settled answer), or a pull
 * request's title. Keyed by (kind, ref) within the canvas, and kept current by the statement
 * that changes its source (packages/db/README.md, "Search entries").
 *
 * There is no `workspace_id`: an entry reaches its workspace through its canvas, so a repo that
 * moves takes its canvases' entries with it and nothing can disagree. There are no check
 * constraints either: a check that failed would fail the commit the entry rides in, so what
 * would be checked (the kinds, the length, the folded alphabet) is proved in `@ponzu/core`'s
 * tests instead. No live query watches this table.
 *
 * A row whose `text` is empty is a removal: a commit that takes an entry away empties it rather
 * than deleting it, since only an upsert reaches a row a racing reindex has just written (see
 * `commit` in queries/ops.ts). Nothing empty can match a search term, and the next reindex of
 * the canvas deletes it.
 */
export const searchEntries = pgTable(
  "search_entries",
  {
    canvasId: text("canvas_id")
      .notNull()
      .references(() => canvases.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: SEARCH_KINDS }).notNull(),
    /** "" for the canvas's name, a page's or board's id, `<thread id>/<message id>`, a thread item's id, a pull request's number. */
    ref: text("ref").notNull(),
    /** As shown: NFC, at most SEARCH_TEXT_MAX code units. Offsets in answers are into this. Empty for a removal. */
    text: text("text").notNull(),
    /** `foldForSearch(text)`: the same length, lowercase, accents and punctuation gone. What is matched. */
    folded: text("folded").notNull(),
    /** What a client needs to open the hit where it is. */
    context: jsonb("context").$type<SearchContext>().notNull(),
    authorKind: text("author_kind", { enum: ACTOR_KINDS }),
    /** A user id. Not a foreign key: history outlives people, as `canvas_ops.actor_id` does. */
    authorId: text("author_id"),
    /** The name the source carried, for an author whose id names nobody known. */
    authorName: text("author_name"),
    /** When the thing was said. Null: the canvas's last activity ranks it. */
    at: instant("at"),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.canvasId, t.kind, t.ref] }),
    index("search_entries_folded_trgm_idx").using("gin", t.folded.op("gin_trgm_ops")),
    // The names alone (a canvas's, its pages', its boards', its pull requests' titles): what a
    // query of short words searches (`searchCanvases`). One or two letters give the index above
    // little to narrow by, so it would read every long text holding them only to drop them.
    index("search_entries_names_trgm_idx")
      .using("gin", t.folded.op("gin_trgm_ops"))
      .where(sql`${t.kind} in ('canvas', 'page', 'board', 'pull_request')`),
  ],
);

/**
 * Which version of the extraction rules (`SEARCH_VERSION`) last indexed each canvas whole, and
 * at which seq. Apart from `canvases` so writing it never reaches anyone watching a canvas.
 * A canvas with no row, or an older version, is one the backfill queues for a reindex.
 */
export const searchState = pgTable("search_state", {
  canvasId: text("canvas_id")
    .primaryKey()
    .references(() => canvases.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  indexedSeq: bigint("indexed_seq", { mode: "number" }).notNull(),
  indexedAt: instant("indexed_at").notNull(),
});
