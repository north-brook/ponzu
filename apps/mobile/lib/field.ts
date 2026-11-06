/**
 * The comment field's measure (components/composer.tsx): lines of Inter 17
 * on a 22pt line, the padding that centres one line in the buttons' 44, and
 * the tallest it grows (five lines) before it scrolls in itself.
 */
export const FIELD_LINE = 22;
export const FIELD_PAD = (44 - FIELD_LINE) / 2;
export const FIELD_LINES = 5;
export const FIELD_MAX = FIELD_PAD * 2 + FIELD_LINE * FIELD_LINES;

/**
 * Whether the field scrolls in itself, from the content height iOS reports
 * each time the field changes size: only once it's as tall as it gets.
 * Growing, it never scrolls. A field that could scroll would scroll the
 * text up to the caret on a new line, before the field had caught up, then
 * back down as it grew: a jolt on every line. iOS reports a hair under the
 * sum of the lines at times, so a hair is allowed.
 */
export function fieldScrolls(contentHeight: number): boolean {
  return contentHeight >= FIELD_MAX - 1;
}
