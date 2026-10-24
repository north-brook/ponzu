/**
 * The design's tokens (`tokens.css` in the iPhone design), for code that
 * needs a literal value: the status bar, SVG fills, the navigation theme,
 * shadows. Class names read the same values from `global.css`;
 * `tokens.test.ts` keeps the two equal.
 */

/** Brand colors, the same in light and dark. */
export const brand = {
  yuzu: "#ffc81e",
  ink: "#111110",
  rind: "#7a4f00",
  pith: "#fff4d1",
} as const;

/** App surfaces in light mode (`--c-*`). */
export const light = {
  bg: "#faf9f6",
  canvas: "#f4f3ef",
  card: "#ffffff",
  ink: "#111110",
  muted: "#5e5b54",
  faint: "#a9a59b",
  chip: "#e8e6e0",
  hairline: "rgba(17,17,16,0.08)",
  bar: "rgba(250,250,249,0.8)",
  pinSoft: "#fff4d1",
  yuzuText: "#7a4f00",
} as const;

export type Palette = { readonly [K in keyof typeof light]: string };

/** App surfaces in dark mode (`--c-*`). */
export const dark: Palette = {
  bg: "#0e0e0d",
  canvas: "#121211",
  card: "#1b1b1a",
  ink: "#f4f3ef",
  muted: "#a9a59b",
  faint: "#6b6862",
  chip: "#262523",
  hairline: "rgba(255,255,255,0.1)",
  bar: "rgba(28,28,28,0.8)",
  pinSoft: "#2e2a1c",
  yuzuText: "#ffc81e",
};

/** `--c-pop` and `--c-board`, as React Native `boxShadow` strings. */
export const shadow = {
  light: {
    pop: "0 1px 2px rgba(0,0,0,0.06), 0 8px 28px rgba(0,0,0,0.1)",
    board: "0 0 0 1px rgba(0,0,0,0.06)",
  },
  dark: {
    pop: "0 1px 2px rgba(0,0,0,0.4), 0 8px 28px rgba(0,0,0,0.5)",
    board: "0 0 0 1px rgba(255,255,255,0.06)",
  },
} as const;

/**
 * Font families, embedded in the app by the expo-font plugin (app.json), so
 * `fontWeight` picks the face. Inter 400 to 700, Funnel Display 700 (the
 * wordmark and display type, letter-spacing -0.05em), IBM Plex Mono 400 and 500.
 */
export const font = {
  sans: "Inter",
  display: "Funnel Display",
  mono: "IBM Plex Mono",
} as const;

/** `--ease-out`, the curve every Ponzu motion uses. */
export const EASE_OUT = [0.2, 0.8, 0.2, 1] as const;
