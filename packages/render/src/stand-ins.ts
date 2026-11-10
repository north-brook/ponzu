/**
 * System fonts, and the font that draws in each one's place on Linux.
 *
 * Designs name the fonts of the devices people see them on: Helvetica,
 * Menlo, system-ui. A Mac has them. A Linux sandbox can't: they are Apple's
 * and Microsoft's to ship. So a screenshot taken there draws each name in a
 * free font picked for its widths, and text wraps where it does for the
 * person looking at the canvas.
 *
 * The reference is Chrome on a Mac, which is what the Mac app's canvas is.
 * A name Chrome on a Mac doesn't resolve either (-apple-system, "SF Pro",
 * "Segoe UI", Consolas, ui-monospace) has no stand-in: there it falls through
 * to the next family in the stack, and so it does here. The generic
 * sans-serif and serif need no entry: Chrome on Linux reads them as Arial
 * and Times New Roman, which is Helvetica and Times in all but name.
 *
 * Two things carry a stand-in to the page. A fontconfig file (`fontconfig`)
 * resolves every name, the generic keywords and per-glyph fallback included.
 * Widths are then right, but a line is as tall as the stand-in's own ascent
 * and descent make it, which is not what the Mac's font makes it: Georgia's
 * lines are a tenth shorter than Gelasio's. So a name whose Mac font has
 * other `metrics` is also declared to the page as an @font-face over the
 * stand-in that carries them (`fontFaces`). A face can't take over a generic
 * keyword or the font a missing glyph falls back to; where that leaves a
 * line's height off, the stand-in has a `caveat`.
 *
 * Not matched: Chinese, Japanese or Korean text in a stack that names no
 * font for it. Fallback draws it in whichever font fontconfig's own order
 * puts first for the character (Noto Sans CJK JP when the machine holds only
 * the fonts in sandbox-fonts.json), under that font's metrics. There its
 * widths are the named stand-ins', but a line with no line-height set is 24px tall
 * at 16px where a Mac's is 18 to 24. With a line-height set the two agree,
 * and so they do when the stack names PingFang, Hiragino or Apple SD Gothic
 * Neo after its own font. Lint says so (`UNNAMED_CJK`).
 *
 * stand-ins.test.ts holds each stand-in to widths and line heights recorded
 * on a Mac (scripts/font-reference.ts). The fonts themselves are listed for
 * the sandbox image in sandbox-fonts.json.
 */
export interface StandIn {
  /** The families designs name, as Chrome on a Mac knows them. */
  names: readonly string[];
  /** The installed family that draws them on Linux. */
  font: string;
  /**
   * How far the width of a line set in the stand-in may be from the same
   * line on a Mac, as a fraction.
   */
  tolerance: number;
  /**
   * The Mac font's ascent, descent and line gap, where the stand-in's own
   * differ. Not for a generic keyword, which a face can't replace.
   */
  metrics?: Metrics;
  /**
   * How far the height of a line at `line-height: normal` may be from a
   * Mac's, as a fraction, where neither the stand-in's metrics nor a face
   * gets it there. Without it the two agree to a pixel, which is as close as
   * they come: Chrome rounds a font's ascent and descent to whole pixels, and
   * on a Mac it pads Helvetica, Times and Courier before it does.
   */
  leading?: number;
  /**
   * What differs, for a stand-in that isn't metric-compatible: lint says so
   * on a screenshot that used it. It finishes the sentence
   * `"<name>" draws in <font> in screenshots: `.
   */
  caveat?: string;
}

/** A font's vertical metrics as Chrome reads them, each a fraction of the font size. */
export interface Metrics {
  ascent: number;
  descent: number;
  lineGap: number;
}

/**
 * Past this in width, or with any `leading`, a stand-in sets text visibly
 * differently from the Mac's font and has to say so in a `caveat`.
 */
export const CLOSE_ENOUGH = 0.03;

const SAN_FRANCISCO = "people see San Francisco on a Mac or iPhone";

export const STAND_INS: readonly StandIn[] = [
  { names: ["Helvetica", "Arial"], font: "Liberation Sans", tolerance: 0.005 },
  {
    names: ["Helvetica Neue"],
    font: "Liberation Sans",
    tolerance: 0.015,
    metrics: { ascent: 0.952, descent: 0.213, lineGap: 0.028 },
    caveat:
      "regular and bold set within 1% of its width, but its thin, light and medium weights draw as regular",
  },
  { names: ["Times", "Times New Roman"], font: "Liberation Serif", tolerance: 0.005 },
  {
    names: ["Georgia"],
    font: "Gelasio",
    tolerance: 0.005,
    metrics: { ascent: 0.917, descent: 0.2192, lineGap: 0 },
  },
  // Chrome's monospace is Courier on a Mac; on Linux it asks for "Monospace".
  {
    names: ["Courier", "Courier New", "monospace"],
    font: "Liberation Mono",
    tolerance: 0.005,
  },
  {
    names: ["Monaco"],
    font: "Liberation Mono",
    tolerance: 0.005,
    metrics: { ascent: 1, descent: 0.25, lineGap: 0.0835 },
  },
  { names: ["Menlo"], font: "DejaVu Sans Mono", tolerance: 0.005 },
  // San Francisco tightens as it grows. Chrome on Linux draws an installed
  // variable font at one optical size, so behind the keyword Inter is true at
  // text sizes and wide in headings. Wide is the safe side to err on: a line
  // that fits in a screenshot fits for the person.
  {
    names: ["system-ui"],
    font: "Inter Variable",
    tolerance: 0.12,
    leading: 0.12,
    caveat: `${SAN_FRANCISCO}, where text up to 16px sets within 5% of this width but headings up to 12% narrower, so a heading that wraps here may fit for them, and a line with no line-height set is up to 2px shorter. A Google Font draws the same everywhere`,
  },
  // Through a face Chrome does set Inter's optical size from the font size,
  // so the name comes much closer than the keyword, and to the pixel in height.
  {
    names: ["BlinkMacSystemFont"],
    font: "Inter Variable",
    tolerance: 0.055,
    metrics: { ascent: 0.9668, descent: 0.2109, lineGap: 0 },
    caveat: `${SAN_FRANCISCO}, which sets within about 5% of this width. A Google Font draws the same everywhere`,
  },
  // Apple's emoji are 1.25em wide up to 16px and 1em from 24px; Noto's are
  // 1.25em at every size. Apple's also stand taller than the text around
  // them, and nearly every emoji is drawn by fallback, where no face reaches.
  {
    names: ["Apple Color Emoji"],
    font: "Noto Color Emoji",
    tolerance: 0.26,
    leading: 0.33,
    caveat:
      "emoji are Apple's on a Mac or iPhone, where they are a fifth narrower from 24px up, and a line holding one with no line-height set is 4 to 7px taller",
  },
  {
    names: ["PingFang SC"],
    font: "Noto Sans CJK SC",
    tolerance: 0.025,
    metrics: { ascent: 1.06, descent: 0.34, lineGap: 0 },
  },
  {
    names: ["PingFang TC"],
    font: "Noto Sans CJK TC",
    tolerance: 0.025,
    metrics: { ascent: 1.06, descent: 0.34, lineGap: 0 },
  },
  {
    names: ["PingFang HK"],
    font: "Noto Sans CJK HK",
    tolerance: 0.025,
    metrics: { ascent: 1.06, descent: 0.34, lineGap: 0 },
  },
  {
    names: ["Hiragino Sans", "Hiragino Kaku Gothic ProN"],
    font: "Noto Sans CJK JP",
    tolerance: 0.02,
    metrics: { ascent: 0.88, descent: 0.12, lineGap: 0.5 },
  },
  {
    names: ["Apple SD Gothic Neo"],
    font: "Noto Sans CJK KR",
    tolerance: 0.07,
    metrics: { ascent: 0.9, descent: 0.3, lineGap: 0 },
    caveat: "Korean text sets about 6% wider here than people see",
  },
];

/** The stand-in for a family name, matched as CSS matches names: whatever the case. */
export function standInFor(name: string): StandIn | undefined {
  const key = name.toLowerCase();
  return STAND_INS.find((s) => s.names.some((n) => n.toLowerCase() === key));
}

/** The names that draw Chinese, Japanese or Korean text in a stand-in held to the Mac's font. */
export const CJK_NAMES: readonly string[] = STAND_INS.filter((s) =>
  s.font.startsWith("Noto Sans CJK"),
).flatMap((s) => s.names);

/**
 * What lint says of such text in a stack of system fonts that names none of
 * them, where the line height is left to the font: fallback draws it, and no
 * face reaches a fallback.
 */
export const UNNAMED_CJK =
  'Chinese, Japanese or Korean text with no font named for it is drawn by a fallback font in screenshots, where a line with no line-height set can be a third taller than people see. Set a line-height, or name "PingFang SC", "Hiragino Sans" or "Apple SD Gothic Neo" in the stack.';

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * A fontconfig file that resolves every name to its stand-in, then reads the
 * machine's own configuration (`system`). Each rule replaces the name
 * outright rather than adding an alternative after it: Chrome takes
 * fontconfig's answer for a family only when the font that comes back is the
 * first one the rules left in the request, and treats anything else as "not
 * installed". A stand-in that isn't installed therefore falls through to the
 * next family in the design's stack, as a missing font should.
 *
 * system-ui isn't a family Chrome asks fontconfig for; a command-line switch
 * names its font instead (see linux-fonts.ts).
 */
export function fontconfig(system: string): string {
  const rules = STAND_INS.flatMap((s) =>
    s.names
      .filter((name) => name !== "system-ui")
      .map(
        (name) =>
          `  <match target="pattern"><test qual="any" name="family"><string>${xml(name)}</string></test><edit name="family" mode="assign" binding="same"><string>${xml(s.font)}</string></edit></match>`,
      ),
  );
  return `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
${rules.join("\n")}
  <include ignore_missing="yes">${xml(system)}</include>
</fontconfig>
`;
}

/** One installed face of a stand-in, as @font-face describes it. */
interface Face {
  /** The face's full name, which is what local() finds an installed font by; a family name alone finds nothing. */
  local: string;
  weight: string;
  style: "normal" | "italic";
}

/** A family's regular, bold, italic and bold italic, named as Liberation's are. */
const fourStyles = (family: string, regular = family): Face[] => [
  { local: regular, weight: "400", style: "normal" },
  { local: `${family} Bold`, weight: "700", style: "normal" },
  { local: `${family} Italic`, weight: "400", style: "italic" },
  { local: `${family} Bold Italic`, weight: "700", style: "italic" },
];

/** The two weights fonts-noto-cjk installs; Chrome slants them for italic, as it does a Mac's. */
const twoWeights = (family: string): Face[] => [
  { local: family, weight: "400", style: "normal" },
  { local: `${family} Bold`, weight: "700", style: "normal" },
];

/** The installed faces of each stand-in that draws under another font's metrics. */
const FACES: Record<string, readonly Face[]> = {
  "Liberation Sans": fourStyles("Liberation Sans"),
  "Liberation Mono": fourStyles("Liberation Mono"),
  Gelasio: fourStyles("Gelasio", "Gelasio Regular"),
  // One file with a weight axis, and an optical size Chrome sets from the font size.
  "Inter Variable": [{ local: "Inter Variable", weight: "100 900", style: "normal" }],
  "Noto Sans CJK SC": twoWeights("Noto Sans CJK SC"),
  "Noto Sans CJK TC": twoWeights("Noto Sans CJK TC"),
  "Noto Sans CJK HK": twoWeights("Noto Sans CJK HK"),
  "Noto Sans CJK JP": twoWeights("Noto Sans CJK JP"),
  "Noto Sans CJK KR": twoWeights("Noto Sans CJK KR"),
};

const percent = (fraction: number) => `${+(fraction * 100).toFixed(2)}%`;

/**
 * @font-face rules that declare each name with `metrics` as its stand-in
 * under the Mac font's ascent, descent and line gap, so a line is as tall
 * and its baseline sits where they are on a Mac. A stand-in that isn't
 * installed leaves its faces with nothing to load, and the name falls through
 * to fontconfig and the rest of the stack as it would without them.
 */
export function fontFaces(): string {
  return STAND_INS.flatMap((s) => {
    const { metrics } = s;
    if (!metrics) return [];
    const overrides = `ascent-override:${percent(metrics.ascent)};descent-override:${percent(metrics.descent)};line-gap-override:${percent(metrics.lineGap)}`;
    return s.names.flatMap((name) =>
      (FACES[s.font] ?? []).map(
        (face) =>
          `@font-face{font-family:"${name}";src:local("${face.local}");font-weight:${face.weight};font-style:${face.style};${overrides}}`,
      ),
    );
  }).join("\n");
}
