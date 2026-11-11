/*
 * The rules for Markdown nobody vouches for: the agent's replies, its plans, a pull request's
 * description and conversation from GitHub. prose.tsx draws it with react-markdown and GitHub's
 * flavour (tables, task lists, strikethrough, bare addresses); these keep it safe and bounded:
 *
 * - raw HTML stays text (react-markdown's default, with no rehype-raw), and HTML comments, which
 *   pull request templates are full of, are dropped;
 * - a link survives only to http, https or mailto;
 * - an image never loads by itself: it becomes a link to the picture, named by its alt text;
 * - quotes nest three deep and emphasis and links four, past which the markers read as written,
 *   so hostile text can't build a tree a thousand elements tall;
 * - past `PROSE_LIMIT` characters it is plain text.
 */

const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/** The address a link may go to, or null. Relative and scripted addresses never survive. */
export function safeHref(href: string): string | null {
  try {
    const url = new URL(href.trim());
    return SAFE_PROTOCOLS.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Longer than this is drawn as plain text, not parsed: well past any reply or pull request body
 * (GitHub allows 65,536), and short enough that the worst text that passes `parseable` still
 * draws quickly (markdown.test.tsx).
 */
export const PROSE_LIMIT = 32_768;

/** Markers that open something nested, and the dots of an address. */
const NESTING = new Set(["*", "_", "~", "[", "]", "!", "(", ")", ">", "#", ".", "`"]);

/**
 * Whether text is fit to parse, in one pass. micromark (under react-markdown) slows down with
 * the square of some shapes and, nested deep enough, runs out of stack; none of them is how
 * people write. Text with any of them is drawn as plain text instead:
 *
 * - a run of more than 16 nesting markers with nothing between them (`*_*_*_…`, `![![…`, a long
 *   row of dots in an address);
 * - a line that opens more than 4 quotes or lists before its text (`> > > > > …`,
 *   `- - - - - …`), or indents one past 64 spaces;
 * - more than 1,000 lines of quotes or lists, or 2,000 table cells;
 * - more than a quarter of a long text in emphasis and link markers.
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
  for (const line of source.split("\n")) {
    if (!CONTAINER.test(line)) continue;
    if (++containers > 1000 || OPENS_FIVE.test(line) || DEEP_INDENT.test(line)) return false;
  }
  return true;
}

const MARKER = String.raw`(?:>[ \t]*|(?:[*+-]|\d{1,9}[.)])(?:[ \t]+|$))`;
const CONTAINER = new RegExp(String.raw`^[ \t]*${MARKER}`);
const OPENS_FIVE = new RegExp(String.raw`^[ \t]*${MARKER}{5}`);
const DEEP_INDENT = new RegExp(String.raw`^[ \t]{65}[ \t]*${MARKER}`);

/** What prose.tsx parses: no HTML comments, one kind of line ending. */
export function prepare(source: string): string {
  return source.replace(/<!--[\s\S]*?(?:-->|$)/g, "").replace(/\r\n?/g, "\n");
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** A line after a blank one that may still belong to what came before: indented, or an item. */
const CONTINUES = /^(?:[ \t]|[*+-](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$))/;
/** What reaches across blocks: a link definition, a footnote, an HTML block that spans blanks. */
const GLOBAL = /^ {0,3}\[[^\]\n]+\]:|<(?:pre|script|style|textarea)[\s>]/im;

/**
 * Text cut into top-level blocks that draw the same apart as together, so each can be drawn on
 * its own and a reply streaming in redraws only its last. A cut falls only at a blank line
 * outside fenced code, before a line that can't continue what came before; text with a link
 * definition, a footnote or an HTML block isn't cut at all.
 */
export function blocks(source: string): string[] {
  if (GLOBAL.test(source)) return [source];
  const lines = source.split("\n");
  const out: string[] = [];
  let start = 0;
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const open = FENCE.exec(line);
    if (fence) {
      if (open && open[1]![0] === fence[0] && open[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (open) {
      fence = open[1]!;
      continue;
    }
    if (line.trim() || i === start) continue;
    let next = i + 1;
    while (next < lines.length && !lines[next]!.trim()) next++;
    if (next >= lines.length || CONTINUES.test(lines[next]!)) continue;
    out.push(lines.slice(start, i).join("\n"));
    start = next;
    i = next - 1;
  }
  out.push(lines.slice(start).join("\n"));
  return out.filter((block) => block.trim());
}

const MAX_QUOTES = 3;
const MAX_NESTING = 4;
const NESTS = new Set(["emphasis", "strong", "delete", "link", "linkReference"]);

interface Node {
  type: string;
  children?: Node[];
  value?: string;
  url?: string;
  alt?: string | null;
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/**
 * A remark plugin: images become links (or, inside a link, their alt text), and what nests past
 * its depth becomes the text it was written as.
 */
export function remarkUntrusted() {
  return (tree: Node, file: { value: unknown }) => {
    const source = String(file.value);
    const written = (node: Node) =>
      source.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? 0);
    const text = (value: string): Node => ({ type: "text", value });

    const walk = (node: Node, quotes: number, nesting: number, inLink: boolean) => {
      const children = node.children;
      if (!children) return;
      for (let i = 0; i < children.length; i++) {
        const child = children[i]!;
        if (child.type === "image" || child.type === "imageReference") {
          const label = child.alt || child.url || "";
          children[i] =
            inLink || child.type === "imageReference" || !child.url
              ? text(label)
              : { type: "link", url: child.url, children: [text(label)] };
          continue;
        }
        const q = child.type === "blockquote" ? quotes + 1 : quotes;
        const n = NESTS.has(child.type) ? nesting + 1 : nesting;
        if (q > MAX_QUOTES) {
          children[i] = { type: "paragraph", children: [text(written(child))] };
          continue;
        }
        if (n > MAX_NESTING) {
          children[i] = text(written(child));
          continue;
        }
        walk(child, q, n, inLink || child.type === "link" || child.type === "linkReference");
      }
    };
    walk(tree, 0, 0, false);
  };
}
