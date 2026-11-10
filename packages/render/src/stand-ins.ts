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
 * `tolerance` is how far the width of a line set in the stand-in may be from
 * the same line on a Mac, as a fraction. It is what stand-ins.test.ts holds
 * each one to, against widths recorded on a Mac (scripts/font-widths.ts).
 * The fonts themselves are listed for the sandbox image in sandbox-fonts.json.
 */
export interface StandIn {
  /** The families designs name, as Chrome on a Mac knows them. */
  names: readonly string[];
  /** The installed family that draws them on Linux. */
  font: string;
  tolerance: number;
  /**
   * What differs, for a stand-in that isn't metric-compatible: lint says so
   * on a screenshot that used it. It finishes the sentence
   * `"<name>" draws in <font> in screenshots: `.
   */
  caveat?: string;
}

export const STAND_INS: readonly StandIn[] = [
  { names: ["Helvetica", "Arial"], font: "Liberation Sans", tolerance: 0.005 },
  {
    names: ["Helvetica Neue"],
    font: "Liberation Sans",
    tolerance: 0.015,
    caveat:
      "regular and bold set within 1% of its width, but its thin, light and medium weights draw as regular",
  },
  { names: ["Times", "Times New Roman"], font: "Liberation Serif", tolerance: 0.005 },
  { names: ["Georgia"], font: "Gelasio", tolerance: 0.005 },
  // Chrome's monospace is Courier on a Mac; on Linux it asks for "Monospace".
  {
    names: ["Courier", "Courier New", "Monaco", "monospace"],
    font: "Liberation Mono",
    tolerance: 0.005,
  },
  { names: ["Menlo"], font: "DejaVu Sans Mono", tolerance: 0.005 },
  // San Francisco tightens as it grows. Chrome on Linux can't follow: it
  // draws an installed variable font at one optical size, so Inter is true
  // at text sizes and wide in headings. Wide is the safe side to err on: a
  // line that fits in a screenshot fits for the person.
  {
    names: ["system-ui", "BlinkMacSystemFont"],
    font: "Inter Variable",
    tolerance: 0.12,
    caveat:
      "people see San Francisco on a Mac or iPhone, where text up to 16px sets within 5% of this width but headings up to 12% narrower, so a heading that wraps here may fit for them. A Google Font draws the same everywhere",
  },
  // Apple's emoji are 1.25em wide up to 16px and 1em from 24px; Noto's are 1.25em at every size.
  { names: ["Apple Color Emoji"], font: "Noto Color Emoji", tolerance: 0.26 },
  { names: ["PingFang SC"], font: "Noto Sans CJK SC", tolerance: 0.025 },
  { names: ["PingFang TC"], font: "Noto Sans CJK TC", tolerance: 0.025 },
  { names: ["PingFang HK"], font: "Noto Sans CJK HK", tolerance: 0.025 },
  {
    names: ["Hiragino Sans", "Hiragino Kaku Gothic ProN"],
    font: "Noto Sans CJK JP",
    tolerance: 0.02,
  },
  {
    names: ["Apple SD Gothic Neo"],
    font: "Noto Sans CJK KR",
    tolerance: 0.07,
    caveat: "Korean text sets about 6% wider here than people see",
  },
];

/** The stand-in for a family name, matched as CSS matches names: whatever the case. */
export function standInFor(name: string): StandIn | undefined {
  const key = name.toLowerCase();
  return STAND_INS.find((s) => s.names.some((n) => n.toLowerCase() === key));
}

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
