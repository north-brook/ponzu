/*
 * The icon ladder: the few steps every icon in the canvas and the studio is drawn at, each a size
 * and a stroke that move together. Hugeicons draw on a 24-unit grid, so a stroke of `s` at `size`
 * px paints `s × size / 24` px; each step's stroke is chosen so every step paints about the same
 * line (1.0–1.1 px), and a small icon reads at the same weight as a large one. The studio names
 * these in apps/studio/src/cloud/ui/ladder.ts, beside its text steps.
 */
export const ICON = {
  /** An icon alone in a control (a 24–28px button, a canvas tool), or leading a menu's, a nav's or a list's row. */
  control: { size: 16, stroke: 1.7 },
  /** Beside 13px text inside a compact control: a page tab, a chip, a check in a menu, a field's glyph. */
  inline: { size: 14, stroke: 1.9 },
  /** Beside 12px text: a quiet button's chevron, the action button, a status beside a 12px line. */
  small: { size: 12, stroke: 2 },
  /** Beside 11px text: a meta line's repo, branch and pull request; a header's disclosure chevron. */
  meta: { size: 11, stroke: 2.2 },
  /** The smallest mark inside a dense control: a check that passed, a menu's tick, a remove ✕. */
  tick: { size: 10, stroke: 2.4 },
} as const;

export type IconStep = keyof typeof ICON;

/**
 * An icon on a solid fill (a send arrow on yuzu or ink, the action button's glyph) is drawn this
 * much heavier than its step: a light line on a solid ground reads thinner than ink on paper.
 */
export const ON_FILL = 0.4;
