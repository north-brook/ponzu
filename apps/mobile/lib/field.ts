/**
 * The comment field's measure (components/composer.tsx). The field is
 * SwiftUI's own, growing a line at a time up to FIELD_LINES and then
 * scrolling in itself; these only set its type on the design's grid.
 *
 * SwiftUI sets Inter on its own line, ascender to descender (1984 and 494 of
 * its 2048 units, no gap): 20.57pt at 17. The design's lines are 22pt apart,
 * and one line sits centred in the buttons' 44.
 */
export const FIELD_SIZE = 17;
export const FIELD_LINES = 5;
export const FIELD_LINE = 22;
/** Inter's own line at FIELD_SIZE. */
export const INTER_LINE = (FIELD_SIZE * (1984 + 494)) / 2048;
/** What SwiftUI adds between lines to bring them 22pt apart. */
export const FIELD_SPACING = FIELD_LINE - INTER_LINE;
/** Above and below the text, so one line fills the buttons' 44. */
export const FIELD_PAD = (44 - INTER_LINE) / 2;
