/**
 * How a glass capsule's style splits between the glass and the clipped view
 * inside it (components/glass.tsx). The glass keeps its size and shape; the
 * inner view takes the layout and padding, so a row lays out across the whole
 * capsule. Plain objects in and out: the caller flattens the style first.
 */
export type Style = Record<string, unknown>;

const LAYOUT = [
  "alignItems",
  "flexDirection",
  "gap",
  "justifyContent",
  "padding",
  "paddingBottom",
  "paddingHorizontal",
  "paddingLeft",
  "paddingRight",
  "paddingTop",
  "paddingVertical",
] as const;

/**
 * The glass: the caller's style less the layout and padding its inner view
 * takes. Left on the glass, a row would shrink the inner view to its
 * content, and a spacer in it would have nothing to fill.
 */
export function outerStyle(flat: Style): Style {
  const rest: Style = { ...flat };
  for (const k of LAYOUT) delete rest[k];
  return rest;
}

/** What the glass holds is laid out as the caller asked, and clipped to its corners. */
export function innerStyle(flat: Style): Style {
  const out: Style = { borderRadius: flat.borderRadius };
  for (const k of LAYOUT) if (flat[k] !== undefined) out[k] = flat[k];
  if (flat.height !== undefined) out.height = "100%";
  // A capsule sized by min-height (the comment field) keeps its inner view at least as tall,
  // so children placed absolutely in it (the voice waveform) aren't clipped to nothing.
  if (flat.minHeight !== undefined) out.minHeight = flat.minHeight;
  return out;
}
