import type { Nodes, RootContent } from "mdast";
import { Fragment, memo, type ReactNode, useMemo } from "react";
import { ScrollView, Text, type TextStyle, View } from "react-native";
import { parseProse } from "./prose";
import { useTheme } from "./theme";
import { font } from "./tokens";

/*
 * Ponzu's replies, drawn as React Native text (iPhone design §9): Markdown parsed by the Mac's
 * rules (lib/prose.ts) into our own elements and tokens. Nothing in it is ever read as markup
 * and nothing loads from it: no images, no HTML. A link is the only thing to press, and only one
 * prose.ts let through (http, https, mailto), handed to `onOpenLink`, which follows a page or
 * board of this canvas in place and opens anything else outside the app.
 */

const BODY: TextStyle = { fontFamily: font.sans, fontSize: 16, lineHeight: 23 };

/**
 * A reply's words. Memoized on its text, so the reply streaming in redraws alone; `streaming`
 * shows a link still being written at the end as its words alone.
 */
export const Markdown = memo(function Markdown({
  text,
  streaming = false,
  quiet = false,
  onOpenLink,
  testID,
}: {
  text: string;
  streaming?: boolean;
  /** An aside: quieter, in italics. */
  quiet?: boolean;
  onOpenLink: (url: string) => void;
  testID?: string;
}) {
  const { color } = useTheme();
  const tree = useMemo(() => parseProse(text, { streaming }), [text, streaming]);
  const ink = quiet ? color.muted : color.ink;
  const base: TextStyle = { ...BODY, color: ink, ...(quiet ? { fontStyle: "italic" } : {}) };
  if (!tree) {
    return (
      <Text testID={testID} style={base} selectable>
        {text}
      </Text>
    );
  }
  const ctx: Ctx = { base, color, onOpenLink };
  return (
    <View testID={testID} style={{ gap: 8, minWidth: 0 }}>
      {blocks(tree.children, ctx)}
    </View>
  );
});

interface Ctx {
  base: TextStyle;
  color: ReturnType<typeof useTheme>["color"];
  onOpenLink: (url: string) => void;
}

function blocks(nodes: readonly RootContent[], ctx: Ctx): ReactNode[] {
  return nodes.map((node, i) => block(node, ctx, i));
}

/** One block: a paragraph, heading, list, quote, code, rule or table. */
function block(node: RootContent, ctx: Ctx, key: number): ReactNode {
  const { base, color } = ctx;
  switch (node.type) {
    case "paragraph":
      return (
        <Text key={key} style={base} selectable>
          {inlines(node.children, ctx)}
        </Text>
      );
    case "heading":
      return (
        <Text key={key} style={[base, { fontWeight: "600" }]} accessibilityRole="header" selectable>
          {inlines(node.children, ctx)}
        </Text>
      );
    case "list":
      return (
        <View key={key} style={{ gap: 4 }}>
          {node.children.map((item, i) => {
            const mark =
              item.checked === true
                ? "☑"
                : item.checked === false
                  ? "☐"
                  : node.ordered
                    ? `${(node.start ?? 1) + i}.`
                    : "•";
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: list items have no identity but their place
              <View key={i} style={{ flexDirection: "row", gap: 8 }}>
                <Text style={[base, { color: color.faint, minWidth: 14 }]}>{mark}</Text>
                <View style={{ flex: 1, gap: 4, minWidth: 0 }}>{blocks(item.children, ctx)}</View>
              </View>
            );
          })}
        </View>
      );
    case "blockquote":
      return (
        <View
          key={key}
          style={{ borderLeftWidth: 2, borderLeftColor: color.chip, paddingLeft: 12, gap: 8 }}
        >
          {blocks(node.children, { ...ctx, base: { ...base, color: color.muted } })}
        </View>
      );
    case "code":
      // The text alone in a box that scrolls sideways, so a long line never widens the thread.
      return (
        <ScrollView
          key={key}
          horizontal
          style={{ borderRadius: 8, backgroundColor: color.chip }}
          contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 8 }}
        >
          <Text style={{ fontFamily: font.mono, fontSize: 13, lineHeight: 20, color: color.ink }}>
            {node.value}
          </Text>
        </ScrollView>
      );
    case "thematicBreak":
      return <View key={key} style={{ height: 1, backgroundColor: color.hairline }} />;
    case "table":
      return (
        <ScrollView key={key} horizontal contentContainerStyle={{ flexDirection: "column" }}>
          {node.children.map((row, r) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity but their place
            <View key={r} style={{ flexDirection: "row" }}>
              {row.children.map((cell, c) => (
                <Text
                  // biome-ignore lint/suspicious/noArrayIndexKey: cells have no identity but their place
                  key={c}
                  style={[
                    base,
                    {
                      fontSize: 14,
                      lineHeight: 20,
                      paddingVertical: 4,
                      paddingHorizontal: 8,
                      minWidth: 72,
                      borderBottomWidth: 1,
                      borderBottomColor: color.hairline,
                      ...(r === 0 ? { fontWeight: "600" as const } : {}),
                    },
                  ]}
                >
                  {inlines(cell.children, ctx)}
                </Text>
              ))}
            </View>
          ))}
        </ScrollView>
      );
    default:
      // Anything else that holds words (prose.ts turned HTML into text) reads as written.
      return "children" in node || "value" in node ? (
        <Text key={key} style={base} selectable>
          {inlines([node], ctx)}
        </Text>
      ) : null;
  }
}

/** Words inside a block: emphasis, strong, struck, code, links and breaks. */
function inlines(nodes: readonly Nodes[], ctx: Ctx): ReactNode[] {
  return nodes.map((node, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: words in a line have no identity but their place
    <Fragment key={i}>{inline(node, ctx)}</Fragment>
  ));
}

function inline(node: Nodes, ctx: Ctx): ReactNode {
  const { color, onOpenLink } = ctx;
  switch (node.type) {
    case "text":
      return node.value;
    case "emphasis":
      return <Text style={{ fontStyle: "italic" }}>{inlines(node.children, ctx)}</Text>;
    case "strong":
      return <Text style={{ fontWeight: "600" }}>{inlines(node.children, ctx)}</Text>;
    case "delete":
      return (
        <Text style={{ textDecorationLine: "line-through" }}>{inlines(node.children, ctx)}</Text>
      );
    case "inlineCode":
      return <Text style={{ fontFamily: font.mono, fontSize: 14 }}>{node.value}</Text>;
    case "break":
      return "\n";
    case "link": {
      const url = node.url;
      return (
        <Text
          accessibilityRole="link"
          onPress={() => onOpenLink(url)}
          style={{ color: color.ink, textDecorationLine: "underline" }}
        >
          {inlines(node.children, ctx)}
        </Text>
      );
    }
    default:
      return "children" in node
        ? inlines(node.children as Nodes[], ctx)
        : "value" in node
          ? String(node.value)
          : null;
  }
}
