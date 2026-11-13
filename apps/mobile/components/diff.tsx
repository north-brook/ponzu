import { type DiffRow, type PrDiff, parsePatch, type Span } from "@ponzu/client/model";
import { type ReactNode, useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import { PR } from "../lib/copy";
import { useTheme } from "../lib/theme";
import { font } from "../lib/tokens";

/**
 * The quiet diff colors of the Mac's pull request tab (apps/studio/src/cloud/styles/tokens.css,
 * `--c-diff-*`): a faint wash on a line added or removed, a stronger one on the words that changed.
 */
const DIFF = {
  light: {
    add: "rgba(63,138,74,0.07)",
    addWord: "rgba(63,138,74,0.16)",
    addSign: "#3f8a4a",
    del: "rgba(180,69,58,0.06)",
    delWord: "rgba(180,69,58,0.14)",
    delSign: "#b4453a",
  },
  dark: {
    add: "rgba(95,179,107,0.1)",
    addWord: "rgba(95,179,107,0.24)",
    addSign: "#5fb36b",
    del: "rgba(224,103,91,0.1)",
    delWord: "rgba(224,103,91,0.24)",
    delSign: "#e0675b",
  },
} as const;

const LINE = 18;
const MONO = { fontFamily: font.mono, fontSize: 12, lineHeight: LINE } as const;

/**
 * One file's unified diff (iPhone design §11): GitHub's patch read by the Mac's rules
 * (@ponzu/client/model `parsePatch`), each line with its sign, the words that changed marked,
 * the unchanged lines between hunks folded to a count. Mono, and it scrolls sideways: long lines
 * are never wrapped. A binary file, or one too large for GitHub to give, says so instead.
 */
export function Diff({ diff }: { diff: PrDiff }) {
  const { color } = useTheme();
  const rows = useMemo(() => (diff.kind === "text" ? parsePatch(diff.patch) : []), [diff]);
  if (diff.kind !== "text") {
    return (
      <Text
        testID="pr-diff-none"
        style={{ fontFamily: font.sans, fontSize: 14, lineHeight: 20, color: color.muted }}
      >
        {diff.kind === "binary" ? PR.binary : PR.tooLarge}
      </Text>
    );
  }
  return (
    <ScrollView
      horizontal
      testID="pr-diff"
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ flexDirection: "column", minWidth: "100%" }}
    >
      <View style={{ minWidth: "100%" }}>
        {rows.map((row, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a diff's rows have only their place
          <DiffLine key={i} row={row} />
        ))}
      </View>
    </ScrollView>
  );
}

function DiffLine({ row }: { row: DiffRow }) {
  const { color, scheme } = useTheme();
  const tone = DIFF[scheme];
  if (row.kind === "fold") {
    return (
      <Text style={{ ...MONO, color: color.faint, paddingVertical: 4 }}>
        {"  "}⋯ {row.lines === 1 ? "1 unchanged line" : `${row.lines} unchanged lines`}
      </Text>
    );
  }
  const add = row.type === "add";
  const del = row.type === "del";
  const sign = add ? "+" : del ? "−" : " ";
  const said = add ? "Added: " : del ? "Removed: " : "";
  return (
    <View
      accessible
      accessibilityLabel={`${said}${row.text}`}
      style={{
        flexDirection: "row",
        backgroundColor: add ? tone.add : del ? tone.del : "transparent",
        paddingRight: 12,
      }}
    >
      <Text
        style={{
          ...MONO,
          width: 18,
          textAlign: "center",
          color: add ? tone.addSign : del ? tone.delSign : color.faint,
        }}
      >
        {sign}
      </Text>
      <Text style={{ ...MONO, color: color.ink }}>
        {marked(row.text, row.changed, add ? tone.addWord : del ? tone.delWord : null)}
      </Text>
    </View>
  );
}

/** A line's text with its changed words on their wash; the whole line when none are marked. */
function marked(text: string, spans: Span[] | null, wash: string | null) {
  if (!spans?.length || !wash) return text || " ";
  const parts: ReactNode[] = [];
  let at = 0;
  spans.forEach(([from, to], i) => {
    if (from > at) parts.push(text.slice(at, from));
    parts.push(
      // biome-ignore lint/suspicious/noArrayIndexKey: spans are in order and never move
      <Text key={i} style={{ backgroundColor: wash }}>
        {text.slice(from, to)}
      </Text>,
    );
    at = to;
  });
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}
