import { type Artboard, parseArtboardFile } from "@ponzu/core";
import { STAND_INS, type StandIn } from "../stand-ins.ts";

/**
 * Lines of text set in each system font that has a Linux stand-in, as one
 * artboard to measure. scripts/font-widths.ts measures it on a Mac and
 * stand-ins.test.ts measures it again where the stand-ins draw, so both see
 * exactly the same page.
 */
export interface FontCase {
  /** The node to measure, and the key its width is recorded under. */
  id: string;
  /** The family as a design names it. */
  name: string;
  standIn: StandIn;
  /** The CSS `font` value, with no family after `name` to fall back to. */
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

const SIZES = [12, 16, 24, 40];
const STYLES = ["400", "700", "italic 400"];

/** Generic keywords are written bare: quoted, they'd name a family instead. */
const family = (name: string) => (/^(system-ui|monospace)$/.test(name) ? name : `"${name}"`);

export function fontCases(): FontCase[] {
  const cases: FontCase[] = [];
  for (const standIn of STAND_INS) {
    const text = SAMPLES[standIn.font] ?? LATIN;
    // Emoji have one weight and no italic.
    const styles = standIn.font === "Noto Color Emoji" ? ["400"] : STYLES;
    for (const name of standIn.names)
      for (const style of styles)
        for (const size of SIZES)
          cases.push({
            id: `${name} ${style} ${size}px`.replace(/[^a-zA-Z0-9]+/g, "-"),
            name,
            standIn,
            font: `${style} ${size}px ${family(name)}`,
            text,
          });
  }
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
