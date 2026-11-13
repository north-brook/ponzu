import type { CheckRun, PrFile } from "./model.ts";

/*
 * Reading a pull request for the Mac's tab and the iPhone's sheet: a file's unified diff into
 * rows, the changed words of a changed line, and the order its checks are listed in.
 */

export type DiffRow =
  | {
      kind: "line";
      type: "context" | "add" | "del";
      /** The line's number before and after; null on the side it isn't on. */
      old: number | null;
      new: number | null;
      text: string;
      /** The words that changed on a changed line; null when all of it did. */
      changed: Span[] | null;
    }
  /** Unchanged lines GitHub left out between hunks, folded. */
  | { kind: "fold"; lines: number };

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * GitHub's `patch` for one file: its hunks, with the unchanged lines between them folded. What
 * comes before the first hunk isn't: its line numbers already say where it starts.
 */
export function parsePatch(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  /** Where the last hunk ended in the old file, to count what lies between it and the next. */
  let oldEnd: number | null = null;
  for (const line of patch.split("\n")) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      const skipped = oldEnd === null ? 0 : oldLine - oldEnd;
      if (skipped > 0) rows.push({ kind: "fold", lines: skipped });
      oldEnd = oldLine + Number(hunk[2] ?? 1);
      continue;
    }
    const sign = line[0];
    const text = line.slice(1);
    if (sign === "+") rows.push(row("add", null, newLine++, text));
    else if (sign === "-") rows.push(row("del", oldLine++, null, text));
    else if (sign === " ") rows.push(row("context", oldLine++, newLine++, text));
    // "\ No newline at end of file", and the empty line after a trailing newline: nothing to show.
  }
  markChanges(rows);
  return rows;
}

const row = (
  type: "context" | "add" | "del",
  old: number | null,
  next: number | null,
  text: string,
): DiffRow => ({ kind: "line", type, old, new: next, text, changed: null });

/**
 * Pairs each run of removed lines with the added lines after it, line for line, and marks the
 * words that changed between the two (changedSpans).
 */
function markChanges(rows: DiffRow[]) {
  for (let i = 0; i < rows.length; ) {
    const dels: number[] = [];
    while (isLine(rows[i], "del")) dels.push(i++);
    const adds: number[] = [];
    while (isLine(rows[i], "add")) adds.push(i++);
    if (!dels.length && !adds.length) i++;
    for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
      const a = rows[dels[k]!] as Extract<DiffRow, { kind: "line" }>;
      const b = rows[adds[k]!] as Extract<DiffRow, { kind: "line" }>;
      const marks = changedSpans(a.text, b.text);
      if (marks) [a.changed, b.changed] = marks;
    }
  }
}

const isLine = (r: DiffRow | undefined, type: "add" | "del") =>
  r?.kind === "line" && r.type === type;

/** A run of a line's text, start and end. */
export type Span = readonly [number, number];

/** A word, a run of spaces, or one mark of punctuation. */
const TOKEN = /\w+|\s+|[^\w\s]/g;
/** Past this many word pairs to weigh, the middle of the two lines is marked whole. */
const MAX_PAIRS = 10_000;

/**
 * The words that changed between two versions of a line, each version's as spans, or null when
 * the lines share too little: marking nearly all of a line says less than not marking it. The
 * words both keep, in order, are the longest run they have in common; the rest are marked, and
 * a space between two marked words is marked with them.
 */
export function changedSpans(a: string, b: string): [Span[], Span[]] | null {
  const ta = a.match(TOKEN) ?? [];
  const tb = b.match(TOKEN) ?? [];
  const keptA = new Array<boolean>(ta.length).fill(false);
  const keptB = new Array<boolean>(tb.length).fill(false);
  // What the two start and end with is kept; only the middle is weighed word by word.
  let start = 0;
  while (start < ta.length && start < tb.length && ta[start] === tb[start]) {
    keptA[start] = keptB[start] = true;
    start++;
  }
  let endA = ta.length;
  let endB = tb.length;
  while (endA > start && endB > start && ta[endA - 1] === tb[endB - 1]) {
    keptA[--endA] = keptB[--endB] = true;
  }
  if ((endA - start) * (endB - start) <= MAX_PAIRS) {
    keepCommon(ta.slice(start, endA), tb.slice(start, endB), (i, j) => {
      keptA[start + i] = keptB[start + j] = true;
    });
  }
  const shared = ta.reduce((sum, token, i) => sum + (keptA[i] ? token.length : 0), 0);
  if (shared < Math.min(a.length, b.length) * 0.3 || shared === Math.max(a.length, b.length)) {
    return null;
  }
  return [spansOf(ta, keptA), spansOf(tb, keptB)];
}

/** The longest common run of two token lists, each pair of kept tokens passed to `keep`. */
function keepCommon(a: string[], b: string[], keep: (i: number, j: number) => void) {
  const width = b.length + 1;
  // lengths[i * width + j]: the longest common run of a[i..] and b[j..].
  const lengths = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i * width + j] =
        a[i] === b[j]
          ? lengths[(i + 1) * width + j + 1]! + 1
          : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!);
    }
  }
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] === b[j]) {
      keep(i++, j++);
    } else if (lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!) i++;
    else j++;
  }
}

/**
 * The marked runs of a line: its changed tokens, joined across the spaces between them, without
 * the spaces at their edges (unless spacing is all that changed).
 */
function spansOf(tokens: string[], kept: boolean[]): Span[] {
  const marked = kept.map((k) => !k);
  for (let i = 1; i < tokens.length - 1; i++) {
    if (kept[i] && /^\s+$/.test(tokens[i]!) && marked[i - 1] && marked[i + 1]) marked[i] = true;
  }
  const spans: Span[] = [];
  let at = 0;
  tokens.forEach((token, i) => {
    if (marked[i]) {
      const last = spans.at(-1);
      if (last && last[1] === at) spans[spans.length - 1] = [last[0], at + token.length];
      else spans.push([at, at + token.length]);
    }
    at += token.length;
  });
  const text = tokens.join("");
  return spans.map(([from, to]) => {
    const run = text.slice(from, to);
    if (!run.trim()) return [from, to];
    return [from + run.length - run.trimStart().length, to - (run.length - run.trimEnd().length)];
  });
}

/** A file with more changed lines than this opens behind "Show diff". */
export const LARGE_DIFF = 400;

export const isLarge = (file: PrFile) => file.additions + file.deletions > LARGE_DIFF;

const CHECK_ORDER: Record<CheckRun["state"], number> = {
  failing: 0,
  running: 1,
  queued: 2,
  passing: 3,
  skipped: 4,
};

/**
 * Every check, never folded: what failed first, then what is still going, then what passed.
 * Each group keeps GitHub's order.
 */
export function orderChecks(checks: CheckRun[]): CheckRun[] {
  // A copy sorted in place: Hermes has no `toSorted`, and `sort` is stable.
  return checks.slice().sort((a, b) => CHECK_ORDER[a.state] - CHECK_ORDER[b.state]);
}
