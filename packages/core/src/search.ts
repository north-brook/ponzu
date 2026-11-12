import { type Doc, type Op, threadPage } from "./doc.ts";

/*
 * Search text, shared by the API, the database package, the studio and the phone: how text is
 * folded and matched, how a query becomes terms, how a hit is cut to a snippet, and which
 * searchable entries a canvas's document holds. Pure, with no clock and no I/O. docs/cloud.md
 * "Search" says what is searched and how the entries are kept.
 */

/** Bump when folding or extraction changes: that is what triggers a reindex. */
export const SEARCH_VERSION = 1;

/** UTF-16 code units stored, and searched, per entry. */
export const SEARCH_TEXT_MAX = 8_000;

/** Terms a query keeps. Past these, the rest of the query is ignored. */
export const SEARCH_TERMS_MAX = 8;

/** A one-word term with fewer code points than this is short: it matches only at a word start. */
export const SEARCH_SHORT_TERM = 3;

export const SEARCH_KINDS = [
  "canvas",
  "page",
  "board",
  "comment",
  "message",
  "pull_request",
] as const;

export type SearchKind = (typeof SEARCH_KINDS)[number];

/** A start of a match in a result's text, and its end (exclusive), in UTF-16 code units. */
export type Match = readonly [start: number, end: number];

/** One word, or a quoted phrase's words. Words hold only letters and digits. */
export interface SearchTerm {
  words: string[];
  short: boolean;
}

/* ------------------------------------------------------------------ */
/* Text                                                                */
/* ------------------------------------------------------------------ */

const isHigh = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLow = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

/** Whether `at` falls between the two halves of a surrogate pair, where no cut may go. */
function splitsPair(text: string, at: number): boolean {
  return (
    at > 0 && at < text.length && isHigh(text.charCodeAt(at - 1)) && isLow(text.charCodeAt(at))
  );
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * Text as it is stored and shown: NFC, with each lone surrogate made U+FFFD (Postgres refuses
 * one in text, which would fail the statement carrying it), clipped to SEARCH_TEXT_MAX without
 * splitting a pair.
 */
export function searchText(raw: string): string {
  const text = raw.normalize("NFC").replace(LONE_SURROGATE, "�");
  if (text.length <= SEARCH_TEXT_MAX) return text;
  const end = splitsPair(text, SEARCH_TEXT_MAX) ? SEARCH_TEXT_MAX - 1 : SEARCH_TEXT_MAX;
  return text.slice(0, end);
}

const WORD_CHAR = /^[\p{L}\p{N}]$/u;
const MARKS = /^\p{M}+$/u;
const WORD = /^[\p{L}\p{N}]+$/u;
/** What each character of the Basic Multilingual Plane past ASCII folds to, once worked out. */
const folds = new Map<string, string>();

/**
 * Text as it is matched: lowercase, with accents gone and everything that is not a letter or a
 * digit turned into spaces. The result has exactly the input's UTF-16 length, so an offset found
 * in it is an offset in the original.
 *
 * It goes code point by code point. A character that decomposes into a base and combining marks
 * becomes its base (é is e, İ is I), and then is lowercased, keeping the first unit when lowering
 * gives more than one. Final sigma folds to σ, which lowering one letter at a time never gives.
 * A letter or digit outside the Basic Multilingual Plane is lowercased when that keeps it one
 * code point, and kept otherwise; any other code point there (an emoji) becomes two spaces, so
 * the length holds though the code-point count then does not. A lone surrogate is one space.
 */
export function foldForSearch(text: string): string {
  let out = "";
  for (const ch of text) out += foldChar(ch);
  return out;
}

function foldChar(ch: string): string {
  const code = ch.charCodeAt(0);
  if (code < 0x80) {
    if (code >= 0x41 && code <= 0x5a) return String.fromCharCode(code + 32);
    if ((code >= 0x61 && code <= 0x7a) || (code >= 0x30 && code <= 0x39)) return ch;
    return " ";
  }
  if (ch.length === 2) return foldAstral(ch);
  const known = folds.get(ch);
  if (known !== undefined) return known;
  const folded = foldBasic(ch);
  folds.set(ch, folded);
  return folded;
}

function foldAstral(ch: string): string {
  if (!WORD_CHAR.test(ch)) return "  ";
  const lower = ch.toLowerCase();
  return lower.length === 2 && (lower.codePointAt(0) ?? 0) > 0xffff && WORD_CHAR.test(lower)
    ? lower
    : ch;
}

function foldBasic(ch: string): string {
  const parts = ch.normalize("NFD");
  const base = parts.length > 1 && MARKS.test(parts.slice(1)) ? parts[0]! : ch;
  let lower = base.toLowerCase();
  if (lower.length !== 1) lower = lower[0]!;
  if (lower === "ς") lower = "σ";
  return WORD_CHAR.test(lower) ? lower : " ";
}

const QUOTES = new Set(['"', "“", "”"]);

/**
 * A query's terms. A quoted phrase (straight or curly quotes; an unclosed one runs to the end)
 * is one term of its words; every other word is a term of its own. Everything is folded first,
 * so a term holds only letters, digits and the spaces between a phrase's words: `#412` is 412
 * and `100%` is 100. Empty terms and repeats are dropped, and the first SEARCH_TERMS_MAX kept.
 * A query of punctuation alone has no terms.
 */
export function searchTerms(query: string): SearchTerm[] {
  const groups: string[][] = [];
  const flush = (part: string, quoted: boolean) => {
    const words = foldForSearch(part).split(" ").filter(Boolean);
    if (quoted) groups.push(words);
    else for (const word of words) groups.push([word]);
  };
  let part = "";
  let quoted = false;
  for (const ch of query.normalize("NFC").trim()) {
    if (!QUOTES.has(ch)) {
      part += ch;
      continue;
    }
    flush(part, quoted);
    part = "";
    quoted = !quoted;
  }
  flush(part, quoted);

  const terms: SearchTerm[] = [];
  const seen = new Set<string>();
  for (const words of groups) {
    const key = words.join(" ");
    if (!words.length || seen.has(key)) continue;
    seen.add(key);
    const short = words.length === 1 && [...words[0]!].length < SEARCH_SHORT_TERM;
    terms.push({ words, short });
    if (terms.length === SEARCH_TERMS_MAX) break;
  }
  return terms;
}

/**
 * Throws unless every word of `term` is letters and digits only. What reaches SQL is checked
 * with this first, so no LIKE wildcard (`%`, `_`), escape (`\`) or regex metacharacter can.
 */
export function assertSearchTerm(term: SearchTerm): void {
  if (!term.words.length || !term.words.every((w) => WORD.test(w))) {
    throw new Error("A search term must be letters and digits only.");
  }
}

/**
 * Where `terms` match in `text`, sorted, with overlapping and touching matches merged. Matching
 * is on the folded text, whose offsets are the original's. A one-word term marks every
 * occurrence that doesn't overlap the one before, a short one only at a word start (the start
 * of the text, or after a space). A phrase marks its words in order, one or more spaces apart.
 */
export function findMatches(text: string, terms: readonly SearchTerm[]): Match[] {
  const folded = foldForSearch(text);
  const found: Match[] = [];
  for (const term of terms) {
    assertSearchTerm(term);
    if (term.words.length > 1) {
      // The words are letters and digits only, so they can go into a pattern as they are.
      for (const hit of folded.matchAll(new RegExp(term.words.join(" +"), "gu"))) {
        found.push([hit.index, hit.index + hit[0].length]);
      }
      continue;
    }
    const word = term.words[0]!;
    let at = folded.indexOf(word);
    while (at >= 0) {
      if (term.short && at > 0 && folded[at - 1] !== " ") {
        at = folded.indexOf(word, at + 1);
        continue;
      }
      found.push([at, at + word.length]);
      at = folded.indexOf(word, at + word.length);
    }
  }
  return merged(found);
}

function merged(matches: readonly Match[]): Match[] {
  const sorted = matches.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

/**
 * At most `width` characters of `text` around its first match, for a result's line. Line
 * breaks and tabs become spaces, which keeps the length. Text that fits is returned whole.
 * Otherwise the window starts 40 characters before the first match, moved forward to just
 * after a space (never past the match), and ends `width` later, moved back to a space unless
 * that would cut into the first match. Each cut end gets "…", the matches are moved with the text, and those
 * outside the window dropped. No cut splits a surrogate pair.
 */
export function snippet(
  text: string,
  matches: readonly Match[],
  width = 140,
): { text: string; matches: Match[] } {
  const flat = text.replace(/[\n\r\t]/g, " ");
  const sorted = matches
    .map(([s, e]): Match => [Math.max(0, s), Math.min(flat.length, e)])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (flat.length <= width) return { text: flat, matches: sorted };

  const first = sorted[0];
  let start = first ? Math.max(0, first[0] - 40) : 0;
  if (start > 0 && flat[start - 1] !== " ") {
    const space = flat.indexOf(" ", start);
    if (space >= 0 && first && space < first[0]) start = space + 1;
  }
  if (splitsPair(flat, start)) start -= 1;

  let end = Math.min(flat.length, start + width);
  if (end < flat.length && flat[end] !== " ") {
    const floor = first ? Math.min(first[1], end) : start + 1;
    const space = flat.lastIndexOf(" ", end - 1);
    if (space >= floor) end = space;
  }
  if (splitsPair(flat, end)) end -= 1;

  const lead = start > 0 ? "…" : "";
  const tail = end < flat.length ? "…" : "";
  const shift = lead.length - start;
  return {
    text: lead + flat.slice(start, end) + tail,
    matches: sorted
      .filter(([s, e]) => e > start && s < end)
      .map(([s, e]): Match => [Math.max(s, start) + shift, Math.min(e, end) + shift]),
  };
}

/** A piece of a result's text, and whether it is part of the match. */
export interface Segment {
  text: string;
  match: boolean;
}

/** Splits `text` at its matches. Overlapping or out-of-range matches are tolerated. */
export function segments(text: string, matches: readonly Match[]): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  for (const [rawStart, rawEnd] of matches.slice().sort((a, b) => a[0] - b[0])) {
    const start = Math.max(at, Math.min(rawStart, text.length));
    const end = Math.min(rawEnd, text.length);
    if (end <= start) continue;
    if (start > at) out.push({ text: text.slice(at, start), match: false });
    out.push({ text: text.slice(start, end), match: true });
    at = end;
  }
  if (at < text.length) out.push({ text: text.slice(at), match: false });
  return out;
}

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
  for (const thread of doc.threads) {
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
