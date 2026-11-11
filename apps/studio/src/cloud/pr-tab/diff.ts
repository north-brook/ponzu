import type { CheckRun, PrFile } from "../model.ts";

/*
 * Reading a pull request for its tab: a file's unified diff into rows, the changed words of a
 * changed line, and the order its checks are listed in.
 */

export type DiffRow =
  | {
      kind: "line";
      type: "context" | "add" | "del";
      /** The line's number before and after; null on the side it isn't on. */
      old: number | null;
      new: number | null;
      text: string;
      /** The changed part of a changed line, start and end; null when all of it changed. */
      changed: readonly [number, number] | null;
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
 * Pairs each run of removed lines with the added lines after it, line for line, and marks what
 * changed between the two: what lies between their shared start and shared end, widened to
 * whole words. Lines with too little in common are left whole: marking nearly all of a line
 * says less than not marking it.
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

/** The changed spans of two versions of a line, or null when they share too little. */
export function changedSpans(
  a: string,
  b: string,
): [readonly [number, number], readonly [number, number]] | null {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  ) {
    end++;
  }
  const shared = start + end;
  if (shared < Math.min(a.length, b.length) * 0.3 || shared === Math.max(a.length, b.length)) {
    return null;
  }
  while (start > 0 && isWord(a[start - 1]) && (isWord(a[start]) || isWord(b[start]))) start--;
  const span = (text: string): readonly [number, number] => {
    let to = text.length - end;
    while (to < text.length && isWord(text[to]) && isWord(text[to - 1])) to++;
    return [start, Math.max(start, to)];
  };
  return [span(a), span(b)];
}

const isWord = (ch: string | undefined) => ch !== undefined && /\w/.test(ch);

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
  return checks.toSorted((a, b) => CHECK_ORDER[a.state] - CHECK_ORDER[b.state]);
}
