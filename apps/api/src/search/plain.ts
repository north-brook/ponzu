import { fromMarkdown } from "mdast-util-from-markdown";
import { toString as textOf } from "mdast-util-to-string";

/*
 * The agent's answers are markdown. Search keeps and matches what a person reads: the words,
 * with the markup gone.
 */

/** Blocks whose text is one run of words: each becomes one line. */
const LEAF_BLOCKS = new Set(["paragraph", "heading", "tableCell", "code", "html"]);

/** A node of the syntax tree, as far as the walk needs it. */
type Node = Parameters<typeof textOf>[0] & { type: string; children?: Node[] };

/**
 * The words of `markdown` as a person reads them: each block of text (a paragraph, a heading,
 * a list item's paragraph, a table cell, a code block) on its own line, in order. Link targets
 * and image addresses are dropped; a link's text and an image's alt stay.
 *
 * Blocks are split down to these leaves rather than taken whole at the top level, because
 * `mdast-util-to-string` runs a container's children together with nothing between them, which
 * would make the last word of one list item and the first of the next one word.
 */
export function plainText(markdown: string): string {
  const lines: string[] = [];
  const walk = (node: Node) => {
    if (LEAF_BLOCKS.has(node.type)) {
      const text = textOf(node, { includeImageAlt: true });
      if (text.trim() !== "") lines.push(text);
      return;
    }
    if (node.type === "thematicBreak" || node.type === "definition") return;
    for (const child of node.children ?? []) walk(child);
  };
  walk(fromMarkdown(markdown) as Node);
  return lines.join("\n");
}
