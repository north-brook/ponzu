/*
 * Search text, shared by the API, the database package, the studio and the phone: how text is
 * folded and matched, how a query becomes terms, and how a hit is cut to a snippet and split at
 * its matches. Pure, with no clock, no I/O and no imports, so a client's shared rules can take
 * it (`@ponzu/core/search-text`) without the rest of core. search.ts adds a canvas's entries and
 * exports this too. docs/cloud.md "Search" says what is searched and how the entries are kept.
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

/** One word, or a quoted phrase's words. Words hold only letters, digits and combining marks. */
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
const MARK = /^\p{M}$/u;
const MARKS = /^\p{M}+$/u;
/** A folded word: a letter or digit, then letters, digits and the marks that belong to them. */
const WORD = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}]*$/u;
/** What each character of the Basic Multilingual Plane past ASCII folds to, once worked out. */
const folds = new Map<string, string>();

/**
 * Text as it is matched: lowercase, with accents gone and everything that is not a letter, a
 * digit or a mark inside a word turned into spaces. The result has exactly the input's UTF-16
 * length, so an offset found in it is an offset in the original.
 *
 * It goes code point by code point. A character that decomposes into a base and combining marks
 * becomes its base (é is e, İ is I), and then is lowercased, keeping the first unit when lowering
 * gives more than one. Final sigma folds to σ, which lowering one letter at a time never gives.
 * A letter or digit outside the Basic Multilingual Plane is lowercased when that keeps it one
 * code point, and kept otherwise; any other code point there (an emoji) becomes two spaces, so
 * the length holds though the code-point count then does not. A lone surrogate is one space.
 *
 * A combining mark that follows a letter, a digit or a mark kept so is kept as it is: in
 * Devanagari, Bengali, Tamil and the other scripts written this way the vowel signs are marks,
 * and turning them into spaces would cut every word into letters. A mark with nothing to sit on
 * becomes a space (two for one outside the Basic Multilingual Plane). Folded text therefore
 * holds letters, digits, spaces and marks, and no word starts with a mark.
 */
export function foldForSearch(text: string): string {
  let out = "";
  let inWord = false;
  for (const ch of text) {
    // Every combining mark is at U+0300 or above.
    if (ch.charCodeAt(0) >= 0x300 && MARK.test(ch)) {
      out += inWord ? ch : ch.length === 2 ? "  " : " ";
      continue;
    }
    const folded = foldChar(ch);
    out += folded;
    inWord = folded.charCodeAt(0) !== 0x20;
  }
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
 * so a term's words hold only letters, digits and combining marks: `#412` is 412
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
 * Throws unless every word of `term` is a folded word: a letter or digit, then letters, digits
 * and combining marks. What reaches SQL is checked with this first, so no LIKE wildcard (`%`,
 * `_`), escape (`\`) or regex metacharacter can. Callers use this rather than a pattern of their
 * own, since folded words may hold marks.
 */
export function assertSearchTerm(term: SearchTerm): void {
  if (!term.words.length || !term.words.every((w) => WORD.test(w))) {
    throw new Error("A search term must be letters, digits and marks only.");
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
      // The words are letters, digits and marks only, so they can go into a pattern as they are.
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
