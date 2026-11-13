/*
 * Making a name safe to put in an email: on one line, without the characters that steer or hide
 * text, and clipped without splitting a character a person sees. The same rules as the pings'
 * (apps/api/src/notifications/copy.ts), which this package may not import.
 */

/** How many characters of a name a subject carries. */
export const SUBJECT_NAME_MAX = 40;
/** How many characters of a name a body carries: a ping title's length. */
export const BODY_NAME_MAX = 60;

// C0 and C1 controls (newlines, tabs, escapes) and the bidirectional overrides, embeddings,
// isolates and marks. A right-to-left name still reads right to left: its letters carry their
// own direction, and the spans that hold names say `dir="auto"`.
const UNSHOWN = /[\p{Cc}؜‎‏‪-‮⁦-⁩]/gu;

const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

/** Text on one line: controls dropped, spaces folded. */
export function oneLine(text: string): string {
  return text.replace(UNSHOWN, " ").replace(/\s+/gu, " ").trim();
}

/**
 * `text` in at most `max` characters, counted as code points, cut with "…" when longer. A cut
 * never splits a grapheme (an emoji with its modifiers, a letter with its accents).
 */
export function clip(text: string, max: number): string {
  if ([...text].length <= max) return text;
  let kept = "";
  let length = 0;
  for (const { segment } of graphemes.segment(text)) {
    const size = [...segment].length;
    if (length + size > max - 1) break;
    kept += segment;
    length += size;
  }
  return `${kept.trimEnd()}…`;
}

/** A canvas's, workspace's or person's name, as an email shows it. */
export function nameOf(name: string, max = BODY_NAME_MAX): string {
  return clip(oneLine(name), max) || "Untitled";
}

/** A sentence without its full stop, for a subject. */
export function withoutStop(sentence: string): string {
  return sentence.replace(/\.$/u, "");
}

/** "1 canvas", "3 canvases". */
export function count(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** "A", "A and B", "A, B and C". */
export function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
