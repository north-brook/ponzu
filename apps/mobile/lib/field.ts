/**
 * The comment field's measure (components/composer.tsx): lines of Inter 17
 * on a 22pt line, the padding that centres one line in the buttons' 44, and
 * the tallest it grows (five lines) before it scrolls in itself.
 */
export const FIELD_LINE = 22;
export const FIELD_PAD = (44 - FIELD_LINE) / 2;
export const FIELD_LINES = 5;
export const FIELD_MAX = FIELD_PAD * 2 + FIELD_LINE * FIELD_LINES;
