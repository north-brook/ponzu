import { type Artboard, parseArtboardFile } from "@ponzu/core";
import { STAND_INS, type StandIn, standInFor } from "../stand-ins.ts";

/**
 * Lines of text set in each system font that has a Linux stand-in, as one
 * artboard to measure. scripts/font-reference.ts measures it on a Mac and
 * stand-ins.test.ts measures it again where the stand-ins draw, so both see
 * exactly the same page.
 */
export interface FontCase {
  /** The node to measure, and the key its size is recorded under. */
  id: string;
  /** The family as a canvas names it, or a few words for a line that names none. */
  name: string;
  standIn: StandIn;
  /** The CSS `font` value, with no family after it to fall back to. */
  font: string;
  text: string;
}

const LATIN =
  "The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs! 0123456789 $1,240.00 (42%)";

/** Text in the script a stand-in is for; Latin unless listed here. */
const SAMPLES: Record<string, string> = {
  "Noto Color Emoji": "🍊🎨✅🚀😀👍🎉🔥✨🌱",
  "Noto Sans CJK SC": "敏捷的棕色狐狸跳过了懒狗，设置与账户",
  "Noto Sans CJK TC": "敏捷的棕色狐狸跳過了懶狗，設定與帳戶",
  "Noto Sans CJK HK": "敏捷的棕色狐狸跳過了懶狗，設定與帳戶",
  "Noto Sans CJK JP": "いろはにほへと ちりぬるを 設定とアカウント",
  "Noto Sans CJK KR": "다람쥐 헌 쳇바퀴에 타고파 설정 및 계정",
};

/**
 * Lines a stand-in draws without being the first name in the stack, each
 * held to the stand-in for `as`. The generic sans-serif and serif are
 * Helvetica and Times on a Mac, and reach their stand-ins on Linux by another
 * road (see stand-ins.ts). An emoji is drawn by fallback in a line of any
 * font. Chinese, Japanese and Korean after a Latin font is how a stack names
 * a font for them.
 */
const UNNAMED: { name: string; family: string; as: string; text: string }[] = [
  { name: "sans-serif", family: "sans-serif", as: "Helvetica", text: LATIN },
  { name: "serif", family: "serif", as: "Times", text: LATIN },
  {
    name: "emoji in Helvetica",
    family: '"Helvetica"',
    as: "Apple Color Emoji",
    text: "Shipped 🚀 and checked ✅ by the whole team 🎉",
  },
  ...["PingFang SC", "Hiragino Sans", "Apple SD Gothic Neo"].map((as) => ({
    name: `${as} after Helvetica`,
    family: `"Helvetica", "${as}"`,
    as,
    text: `Settings ${SAMPLES[standInFor(as)!.font]}`,
  })),
];

const SIZES = [12, 16, 24, 40];
const STYLES = ["400", "700", "italic 400"];

/** Generic keywords are written bare: quoted, they'd name a family instead. */
const family = (name: string) => (/^(system-ui|monospace)$/.test(name) ? name : `"${name}"`);

export function fontCases(): FontCase[] {
  const cases: FontCase[] = [];
  const add = (name: string, standIn: StandIn, families: string, text: string) => {
    // Emoji have one weight and no italic.
    const styles = standIn.font === "Noto Color Emoji" ? ["400"] : STYLES;
    for (const style of styles)
      for (const size of SIZES)
        cases.push({
          id: `${name} ${style} ${size}px`.replace(/[^a-zA-Z0-9]+/g, "-"),
          name,
          standIn,
          font: `${style} ${size}px ${families}`,
          text,
        });
  };
  for (const standIn of STAND_INS)
    for (const name of standIn.names)
      add(name, standIn, family(name), SAMPLES[standIn.font] ?? LATIN);
  for (const line of UNNAMED) add(line.name, standInFor(line.as)!, line.family, line.text);
  return cases;
}

export function fontCasesBoard(cases: FontCase[]): Artboard {
  const lines = cases
    .map(
      (c) =>
        `<span data-id="${c.id}" style="font:${c.font.replace(/"/g, "'")};white-space:nowrap;align-self:flex-start">${c.text}</span>`,
    )
    .join("\n");
  return parseArtboardFile(
    `<section data-artboard data-id="ab_fonts" data-name="Fonts" style="width:4000px;height:fit-content">${lines}</section>`,
    { id: "ab_fonts", name: "Fonts" },
  ).artboard;
}
