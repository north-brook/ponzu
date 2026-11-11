/*
 * The ladder: the few named steps every icon and every piece of interface text is set from, so a
 * call site says what a thing is (a control's icon, a meta line) rather than how big it is. The
 * README's "The ladder" says why each step is what it is, and the gallery's `?ladder` draws them.
 *
 * Icons: `ICON`'s steps live with the canvas (@ponzu/canvas/ladder), so the canvas's tools and
 * zoom and the studio's controls are drawn from one table. `Icon` (icon.tsx) takes a step's name.
 */
export { ICON, type IconStep, ON_FILL } from "@ponzu/canvas/ladder";

/**
 * Text: each step is a size, a weight and, where the step is defined by being quiet, its colour.
 * Otherwise colour is the role's, from the colour ladder (README): `text-ink` what is read or
 * chosen, `text-muted` a control at rest or a secondary line, `text-faint` quiet text,
 * `text-icon-soft` a quiet icon standing alone.
 */
export const TEXT = {
  /** What a person reads: messages, a dialog's words, a row's own text. */
  body: "text-13",
  /** A name: a design's, a page tab's, a setting's. */
  name: "text-13 font-medium",
  /** The heading of a small surface: the workspace, a dialog's row. (Share's heading is 14, as drawn.) */
  title: "text-13 font-semibold",
  /** A control's words: a quiet button, a chip, a raised button. */
  control: "text-12 font-medium",
  /** A line under a name or a field: what a setting does, who opened it and when. */
  secondary: "text-12",
  /** The meta line: repo, branch, pull request, counts, ages. Deliberately the faintest text. */
  meta: "font-mono text-11 text-faint",
  /** A section's label in a menu, Settings or the pull request tab. */
  label: "font-semibold text-11 text-faint",
} as const;
