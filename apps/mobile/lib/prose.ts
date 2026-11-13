import type { Nodes, Root, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmAutolinkLiteralFromMarkdown } from "mdast-util-gfm-autolink-literal";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTaskListItemFromMarkdown } from "mdast-util-gfm-task-list-item";
import { gfmAutolinkLiteral } from "micromark-extension-gfm-autolink-literal";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmTaskListItem } from "micromark-extension-gfm-task-list-item";

/*
 * Markdown nobody vouches for (Ponzu's replies in the thread), parsed for lib/markdown.tsx to
 * draw as React Native text. The rules are the Mac's (apps/studio/src/cloud/ui/markdown.ts), so
 * the two apps let through the same things; prose.test.ts holds the phone to them:
 *
 * - the parser is the Mac's: micromark into mdast, with GitHub's flavour (tables, task lists,
 *   strikethrough, bare addresses) and no footnotes;
 * - raw HTML stays text, and HTML comments are dropped;
 * - a link survives only to http, https or mailto (lib/markdown.tsx also follows a link to a
 *   page or board of this canvas in place, through lib/links.ts `threadLink`);
 * - an image never loads: it becomes a link to the picture, named by its alt text;
 * - quotes nest three deep and emphasis and links four, past which the text reads as written;
 * - text the Mac would refuse to parse (too long, or shaped to be slow) is plain text.
 *
 * One difference, on purpose: the Mac reads an address with the browser's URL parser. React
 * Native's URL is a partial one, so here an address is matched whole by a pattern instead, which
 * takes a little less (`https:host` without its slashes is not a link here).
 */

/** Longer than this is drawn as plain text, not parsed: the Mac's limit. */
export const PROSE_LIMIT = 32_768;

const SAFE =
  /^(?:https?:\/\/[^\s<>"'`\\\u0000-\u001f\u007f]+|mailto:[^\s<>"'`\\/\u0000-\u001f\u007f]+)$/i;

/** The address a link may go to, or null. Relative, scripted and local addresses never survive. */
export function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (!SAFE.test(trimmed)) return null;
  // An address with no host (`https:///x`) goes nowhere.
  if (/^https?:\/\/(?:[/?#]|$)/i.test(trimmed)) return null;
  return trimmed;
}

/** Markers that open something nested, and the dots of an address. */
const NESTING = new Set(["*", "_", "~", "[", "]", "!", "(", ")", ">", "#", ".", "`"]);
const UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/;
const OPEN_FENCE = /^(?:(`{3,})[^`]*|(~{3,}).*)$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const MARKER = String.raw`(?:>[ \t]*|(?:[*+-]|\d{1,9}[.)])(?:[ \t]+|$))`;
const CONTAINER = new RegExp(String.raw`^[ \t]*${MARKER}`);
const OPENS_FIVE = new RegExp(String.raw`^[ \t]*${MARKER}{5}`);
const DEEP_INDENT = new RegExp(String.raw`^[ \t]{65}[ \t]*${MARKER}`);

/**
 * Whether text is fit to parse, in one pass: the Mac's `parseable`, line for line, so a reply
 * the Mac draws as plain text is plain text here too (prose.test.ts compares the two).
 */
export function parseable(source: string): boolean {
  if (source.length > PROSE_LIMIT) return false;
  let run = 0;
  let markers = 0;
  let cells = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (NESTING.has(c)) {
      if (++run > 16) return false;
      if (c === "*" || c === "_" || c === "~" || c === "[") markers++;
    } else {
      run = 0;
      if (c === "|" && ++cells > 2000) return false;
    }
  }
  if (source.length > 4096 && markers > source.length / 4) return false;
  let containers = 0;
  let underlines = 0;
  let unbroken = 0;
  let fence: string | null = null;
  const html = /^[ \t]*</m.test(source);
  for (const line of source.split("\n")) {
    if (fence) {
      const shut = FENCE.exec(line)?.[1];
      if (shut && shut[0] === fence[0] && shut.length >= fence.length) fence = null;
      continue;
    }
    const open = html ? null : OPEN_FENCE.exec(line);
    if (open) {
      fence = open[1] ?? open[2]!;
      unbroken = 0;
      continue;
    }
    if (!line.trim()) {
      unbroken = 0;
      continue;
    }
    if (unbroken > 0 && UNDERLINE.test(line) && ++underlines > 200) return false;
    if (++unbroken > 1000) return false;
    if (!CONTAINER.test(line)) continue;
    if (++containers > 1000 || OPENS_FIVE.test(line) || DEEP_INDENT.test(line)) return false;
  }
  return true;
}

/** What is parsed: no HTML comments, one kind of line ending. */
export function prepare(source: string): string {
  return source.replace(/<!--[\s\S]*?(?:-->|$)/g, "").replace(/\r\n?/g, "\n");
}

/** A link still being written at the end of a reply streaming in (the Mac's `settled`). */
const OPEN_LINK = /!?\[([^[\]\n]*)(?:\]\([^()\s]*(?:[ \t]+(?:"[^"\n]*"?|'[^'\n]*'?)?)?|\])?$/;

/**
 * Text streaming in, with a link it is still writing at its end shown as its words alone, so half
 * a link's syntax never flashes. In fenced code or a code span it is left as written.
 */
export function settled(source: string): string {
  const open = OPEN_LINK.exec(source);
  if (!open) return source;
  const before = source.slice(0, open.index);
  const fences = before.split("\n").filter((line) => FENCE.test(line)).length;
  if (fences % 2 === 1) return source;
  const line = before.slice(before.lastIndexOf("\n") + 1);
  if ((line.match(/`/g)?.length ?? 0) % 2 === 1) return source;
  return before + open[1];
}

const MAX_QUOTES = 3;
const MAX_NESTING = 4;
const NESTS = new Set(["emphasis", "strong", "delete", "link", "linkReference"]);

const EXTENSIONS = [gfmAutolinkLiteral(), gfmStrikethrough(), gfmTable(), gfmTaskListItem()];
const MDAST_EXTENSIONS = [
  gfmAutolinkLiteralFromMarkdown(),
  gfmStrikethroughFromMarkdown(),
  gfmTableFromMarkdown(),
  gfmTaskListItemFromMarkdown(),
];

type Parent = Extract<Nodes, { children: unknown[] }>;
const text = (value: string) => ({ type: "text", value }) as RootContent;

/**
 * The tree lib/markdown.tsx draws, or null for plain text (text `parseable` refuses). Images
 * become links, or their alt text inside a link; what nests past its depth becomes the text it
 * was written as; a link that isn't safe becomes its words; HTML is its own text.
 */
export function parseProse(source: string, opts: { streaming?: boolean } = {}): Root | null {
  const prepared = prepare(source);
  const input = opts.streaming ? settled(prepared) : prepared;
  if (!parseable(input)) return null;
  const tree = fromMarkdown(input, { extensions: EXTENSIONS, mdastExtensions: MDAST_EXTENSIONS });
  const written = (node: Nodes) =>
    input.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? 0);
  // `[words][name]` links take their address from a `[name]: …` line anywhere in the text.
  const definitions = new Map<string, string>();
  for (const node of tree.children) {
    if (node.type === "definition") definitions.set(node.identifier, node.url);
  }
  const walk = (node: Parent, quotes: number, nesting: number, inLink: boolean) => {
    const children = node.children as RootContent[];
    for (let i = 0; i < children.length; i++) {
      let child = children[i]!;
      if (child.type === "definition") {
        children.splice(i, 1);
        i--;
        continue;
      }
      if (child.type === "linkReference") {
        const url = definitions.get(child.identifier);
        child = children[i] = url
          ? ({
              type: "link",
              url,
              children: child.children,
              position: child.position,
            } as RootContent)
          : text(written(child));
        if (child.type === "text") continue;
      }
      if (child.type === "image" || child.type === "imageReference") {
        const label = child.alt || (child.type === "image" ? child.url : "") || "";
        const href = child.type === "image" ? safeHref(child.url) : null;
        children[i] =
          inLink || !href
            ? text(label)
            : ({ type: "link", url: href, children: [text(label)] } as RootContent);
        continue;
      }
      if (child.type === "html") {
        children[i] = text(child.value);
        continue;
      }
      const q = child.type === "blockquote" ? quotes + 1 : quotes;
      const n = NESTS.has(child.type) ? nesting + 1 : nesting;
      if (q > MAX_QUOTES) {
        children[i] = { type: "paragraph", children: [text(written(child))] } as RootContent;
        continue;
      }
      if (n > MAX_NESTING) {
        children[i] = text(written(child));
        continue;
      }
      if (child.type === "link") {
        const href = safeHref(child.url);
        if (!href) {
          // Its words stay, as text, with nothing to press.
          children.splice(i, 1, ...(child.children as RootContent[]));
          i--;
          continue;
        }
        child.url = href;
      }
      if ("children" in child) {
        walk(child as Parent, q, n, inLink || child.type === "link");
      }
    }
  };
  walk(tree, 0, 0, false);
  return tree;
}

/** The plain words of a tree, for VoiceOver and for a line too long to draw. */
export function plainText(node: Nodes): string {
  if ("value" in node && typeof node.value === "string") return node.value;
  if ("children" in node) return (node.children as Nodes[]).map(plainText).join("");
  return "";
}
