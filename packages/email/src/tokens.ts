/*
 * The email's look as numbers (the email plan §4): the handoff page's colours
 * (packages/core/src/handoff.ts), every email link's landing, with the dark action in yuzu. The
 * light look is the real one; dark is added where a mail app honours `prefers-color-scheme`,
 * and the light one must survive a mail app that inverts it.
 */

export const LIGHT = {
  ground: "#ffffff",
  ink: "#111110",
  muted: "#5e5b54",
  faint: "#807c73",
  hairline: "#e7e5df",
  action: "#111110",
  actionInk: "#ffffff",
  yuzu: "#ffc81e",
} as const;

export const DARK = {
  ground: "#0e0e0d",
  ink: "#f4f3ef",
  muted: "#a9a59b",
  faint: "#807c73",
  hairline: "#2a2926",
  action: "#ffc81e",
  actionInk: "#111110",
  yuzu: "#ffc81e",
} as const;

export type Palette = { readonly [K in keyof typeof LIGHT]: string };

const SYSTEM =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export const FONT = {
  display: `'Funnel Display', ${SYSTEM}`,
  body: SYSTEM,
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
} as const;

/** Sizes in px as [font size, line height]. */
export const TYPE = {
  title: [26, 32],
  recapTitle: [30, 36],
  heading: [18, 24],
  body: [16, 24],
  muted: [14, 20],
  footer: [13, 20],
  mono: [13, 20],
  action: [15, 18],
} as const;

export const SPACE = {
  columnMax: 560,
  top: 40,
  side: 32,
  phoneTop: 28,
  phoneSide: 20,
  afterMark: 28,
  afterTitle: 16,
  afterParagraph: 16,
  afterContent: 28,
  afterAction: 32,
  afterHairline: 20,
  mark: 32,
  rowMin: 44,
} as const;
