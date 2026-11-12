import type { Match, SearchResults } from "./model.ts";

/** A piece of a result's text, and whether it is part of the match. */
export interface Segment {
  text: string;
  match: boolean;
}

/** Splits `text` at its matches. Overlapping or out-of-range matches are tolerated. */
export function segments(text: string, matches: readonly Match[]): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  for (const [rawStart, rawEnd] of matches.toSorted((a, b) => a[0] - b[0])) {
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

export type ResultKey = `canvas:${string}` | `board:${string}` | `comment:${string}`;

/** Every result in the order the list shows them, for moving through with the keyboard. */
export function resultKeys(results: SearchResults): ResultKey[] {
  return [
    ...results.canvases.map((h) => `canvas:${h.canvas.id}` as const),
    ...results.boards.map((h) => `board:${h.id}` as const),
    ...results.comments.map((h) => `comment:${h.id}` as const),
  ];
}

/**
 * Where the selection goes on an arrow key. It stops at the ends rather than wrapping, as a Mac
 * list does. Null for a key that doesn't move it: Home and End stay the field's, for the caret.
 */
export function moveSelection(count: number, index: number, key: string): number | null {
  if (count === 0) return null;
  if (key === "ArrowDown") return Math.min(count - 1, index + 1);
  if (key === "ArrowUp") return Math.max(0, index - 1);
  return null;
}
