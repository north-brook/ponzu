import { type Doc, type Op, threadPage } from "./doc.ts";
import { type SearchKind, searchText } from "./search-text.ts";

/*
 * Search, shared by the API, the database package, the studio and the phone: the text rules in
 * search-text.ts (exported from here too), and which searchable entries a canvas's document
 * holds and what a commit changes in them. Pure, with no clock and no I/O. docs/cloud.md
 * "Search" says what is searched and how the entries are kept.
 */

export * from "./search-text.ts";

/* ------------------------------------------------------------------ */
/* A canvas's entries                                                  */
/* ------------------------------------------------------------------ */

/** One searchable thing on a canvas, keyed by (kind, ref) within it. */
export interface SearchEntry {
  kind: SearchKind;
  ref: string;
  /** Already `searchText`'d, and never empty. */
  text: string;
  context: SearchContext;
  author: SearchAuthor | null;
  /** When it was said, in ms. Null: the canvas's last activity ranks it. */
  at: number | null;
}

/** What a client needs to open a hit where it is, beside the canvas. */
export type SearchContext =
  | { kind: "canvas" }
  | { kind: "page" }
  | { kind: "board"; pageId: string }
  | {
      kind: "comment";
      threadId: string;
      messageId: string;
      pageId: string | null;
      artboardId: string | null;
      resolved: boolean;
    }
  | { kind: "message"; itemSeq: number }
  | { kind: "pull_request"; number: number };

/** Who said it. `id` is null on what the local app wrote, which knew only a name. */
export interface SearchAuthor {
  kind: "user" | "agent";
  id: string | null;
  name: string;
}

/**
 * The entries a document holds: its name (ref ""), each page and board by id, and each message
 * of every comment thread, open or resolved, by `<thread id>/<message id>`. An entry whose text
 * is empty is left out.
 *
 * Ids are not trusted to be unique (docs/cloud.md "Storage rules"): the first occurrence of each
 * (kind, ref) in document order wins, which is the one `findArtboard` and `linkTarget` find, so
 * no list ever carries one key twice.
 */
export function docSearchEntries(doc: Doc): SearchEntry[] {
  const out: SearchEntry[] = [];
  const seen = new Set<string>();
  const add = (
    kind: SearchKind,
    ref: string,
    raw: unknown,
    context: SearchContext,
    author: SearchAuthor | null = null,
    at: number | null = null,
  ) => {
    const key = `${kind}:${ref}`;
    if (seen.has(key)) return;
    seen.add(key);
    const text = typeof raw === "string" ? searchText(raw) : "";
    if (text) out.push({ kind, ref, text, context, author, at });
  };

  add("canvas", "", doc.name, { kind: "canvas" });
  for (const page of doc.pages) add("page", page.id, page.name, { kind: "page" });
  for (const page of doc.pages) {
    for (const board of page.artboards) {
      add("board", board.id, board.name, { kind: "board", pageId: page.id });
    }
  }
  const threads = new Set<string>();
  for (const thread of doc.threads) {
    // A second thread of one id is one no op can reach, so its messages are not offered either.
    if (threads.has(thread.id)) continue;
    threads.add(thread.id);
    const pageId = threadPage(doc, thread)?.id ?? null;
    for (const message of thread.messages) {
      const author: SearchAuthor | null = message.author
        ? {
            kind: message.author.kind === "agent" ? "agent" : "user",
            id: message.author.id ?? null,
            name: message.author.name ?? "",
          }
        : null;
      const context: SearchContext = {
        kind: "comment",
        threadId: thread.id,
        messageId: message.id,
        pageId,
        artboardId: thread.artboardId ?? null,
        resolved: thread.status === "resolved",
      };
      const at = Number.isFinite(message.createdAt) ? message.createdAt : null;
      add("comment", `${thread.id}/${message.id}`, message.text, context, author, at);
    }
  }
  return out;
}

/**
 * The ops that can't change a document's entries: they touch only nodes inside boards, the
 * tokens, the notes, the icon or the scratch mark. A `name` op is not one, since naming a
 * board's root renames the board.
 */
export const SEARCH_IGNORED_OPS: readonly Op["op"][] = [
  "insert",
  "remove",
  "move",
  "style",
  "attrs",
  "children",
  "tokens",
  "note",
  "file.icon",
  "file.scratch",
];

const ignored = new Set<string>(SEARCH_IGNORED_OPS);
const ignorable = (op: Op): boolean =>
  op.op === "batch" ? op.ops.every(ignorable) : ignored.has(op.op);

/**
 * What a commit of `ops`, taking `before` to `after`, changes in the canvas's entries: the
 * entries that are new or differ in text, context, author or time, and the keys that are gone.
 * The two never share a key. Null when every op (through batches) is one of SEARCH_IGNORED_OPS,
 * which is almost every agent commit, so nothing needs writing.
 */
export function docSearchChanges(
  before: Doc,
  after: Doc,
  ops: readonly Op[],
): { upsert: SearchEntry[]; remove: { kind: SearchKind; ref: string }[] } | null {
  if (ops.every(ignorable)) return null;
  const key = (e: { kind: SearchKind; ref: string }) => `${e.kind}:${e.ref}`;
  const was = new Map(docSearchEntries(before).map((e) => [key(e), e]));
  const now = docSearchEntries(after);
  const kept = new Set(now.map(key));
  return {
    upsert: now.filter((e) => !sameEntry(was.get(key(e)), e)),
    remove: [...was.values()]
      .filter((e) => !kept.has(key(e)))
      .map(({ kind, ref }) => ({ kind, ref })),
  };
}

function sameEntry(a: SearchEntry | undefined, b: SearchEntry): boolean {
  return (
    a !== undefined &&
    a.text === b.text &&
    a.at === b.at &&
    JSON.stringify(a.context) === JSON.stringify(b.context) &&
    JSON.stringify(a.author) === JSON.stringify(b.author)
  );
}
