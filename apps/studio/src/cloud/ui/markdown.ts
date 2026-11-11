/*
 * A small Markdown reader for text nobody vouches for: the agent's replies, its plans, a pull
 * request's description and conversation from GitHub. It reads the few things those use
 * (paragraphs, short lists, quotes, fenced code, headings, inline code, emphasis, links) into a
 * tree of plain strings, and nothing else: raw HTML stays text, an image becomes a link to it
 * (so nothing loads by itself), and a link survives only to http, https or mailto.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong" | "em" | "del"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[] }
  | { kind: "break" };

export type Block =
  | { kind: "paragraph"; children: Inline[] }
  | { kind: "heading"; children: Inline[] }
  | { kind: "list"; ordered: boolean; start: number; items: Inline[][] }
  | { kind: "code"; text: string }
  | { kind: "quote"; children: Block[] }
  | { kind: "rule" };

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

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}#{1,6}(?:\s+|$)(.*?)(?:\s+#+\s*)?$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const ITEM = /^\s{0,8}(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/;

/** How deep quotes nest: a `>` past the third is text in the third. */
const MAX_QUOTES = 3;

const startsBlock = (line: string, quotes: number) =>
  FENCE.test(line) ||
  HEADING.test(line) ||
  RULE.test(line) ||
  (quotes < MAX_QUOTES && QUOTE.test(line)) ||
  ITEM.test(line);

export function parseMarkdown(source: string): Block[] {
  // HTML comments (pull request templates are full of them) say nothing to a reader.
  const text = source.replace(/<!--[\s\S]*?(?:-->|$)/g, "").replace(/\r\n?/g, "\n");
  return parseBlocks(text.split("\n"), 0);
}

function parseBlocks(lines: string[], quotes: number): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence[1]![0]}{${fence[1]!.length},}\\s*$`);
      const body: string[] = [];
      for (i++; i < lines.length && !close.test(lines[i]!); i++) body.push(lines[i]!);
      i++;
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", children: parseInline(heading[1]!) });
      i++;
      continue;
    }
    if (quotes < MAX_QUOTES && QUOTE.test(line)) {
      const quoted: string[] = [];
      for (; i < lines.length && QUOTE.test(lines[i]!); i++)
        quoted.push(QUOTE.exec(lines[i]!)![1]!);
      blocks.push({ kind: "quote", children: parseBlocks(quoted, quotes + 1) });
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      const ordered = !item[1];
      const items: string[] = [];
      while (i < lines.length) {
        const next = ITEM.exec(lines[i]!);
        if (next && (next[1] === undefined) === ordered) {
          items.push(next[3]!);
          i++;
        } else if (lines[i]!.trim() && /^\s/.test(lines[i]!) && items.length) {
          // A continuation, or a nested item: short lists stay one level deep.
          items[items.length - 1] += `\n${lines[i]!.trim()}`;
          i++;
        } else if (!lines[i]!.trim() && ITEM.exec(lines[i + 1] ?? "")) {
          i++;
        } else break;
      }
      blocks.push({
        kind: "list",
        ordered,
        start: ordered ? Number(item[2]) : 1,
        items: items.map(parseInline),
      });
      continue;
    }
    const paragraph: string[] = [];
    for (; i < lines.length && lines[i]!.trim() && !startsBlock(lines[i]!, quotes); i++) {
      paragraph.push(lines[i]!.trim());
    }
    blocks.push({ kind: "paragraph", children: parseInline(paragraph.join("\n")) });
  }
  return blocks;
}

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!~<>|"']/;
const AUTOLINK = /https?:\/\/[^\s<>]+/y;
const ANGLE_LINK = /<(https?:\/\/[^\s<>]+|mailto:[^\s<>]+)>/y;
const LINK_TARGET = /\(\s*<?([^\s()<>]*(?:\([^\s()]*\)[^\s()<>]*)*)>?(?:\s+"[^"]*")?\s*\)/y;
/** Sentence punctuation after a bare address belongs to the sentence. */
const TRAILING = new Set([".", ",", ":", ";", "!", "?", "'", '"', ")", "]"]);

/**
 * How deep emphasis and links nest in each other. Past it, markers read as written: prose never
 * goes this deep, and hostile text can't build a tree a thousand elements tall.
 */
const MAX_NESTING = 4;

/** Reads emphasis, code, links and line breaks out of one block's text. */
export function parseInline(text: string): Inline[] {
  return readInline(text, 0, true);
}

/**
 * One pass over the text. Every search ahead (a closing marker, a closing bracket) is made once
 * for the whole text or remembered when it fails, so hostile text full of lone markers reads in
 * linear time, not a pass per marker. A link's label never holds another link.
 */
function readInline(text: string, depth: number, links: boolean): Inline[] {
  const out: Inline[] = [];
  let plain = "";
  const flush = () => {
    if (plain) out.push({ kind: "text", text: plain });
    plain = "";
  };
  const nest = depth < MAX_NESTING;
  const brackets = nest && links && text.includes("[") ? matchBrackets(text) : null;
  // A marker, or a run of backticks, that found no closer from one place finds none later on.
  const unclosed = new Set<string>();
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;

    if (c === "\\" && ESCAPABLE.test(text[i + 1] ?? "")) {
      plain += text[i + 1];
      i += 2;
      continue;
    }
    if (c === "\n") {
      flush();
      out.push({ kind: "break" });
      i++;
      continue;
    }
    if (c === "`") {
      let n = i;
      while (text[n] === "`") n++;
      const ticks = text.slice(i, n);
      const end = unclosed.has(ticks) ? -1 : text.indexOf(ticks, n);
      if (end > 0) {
        flush();
        out.push({ kind: "code", text: text.slice(n, end).trim() || " " });
        i = end + ticks.length;
        continue;
      }
      unclosed.add(ticks);
      plain += ticks;
      i = n;
      continue;
    }
    const link =
      brackets && (c === "[" || (c === "!" && text[i + 1] === "["))
        ? readLink(text, i, brackets)
        : null;
    if (link) {
      flush();
      const href = safeHref(link.href);
      // An image is never drawn: it would load from wherever its address says, as the reader
      // reads. It becomes a link to the picture, named by its alt text.
      const label = link.image && !link.label ? link.href : link.label;
      const children = link.image
        ? [{ kind: "text" as const, text: label }]
        : readInline(label, depth + 1, false);
      if (href) out.push({ kind: "link", href, children });
      else out.push(...children);
      i = link.end;
      continue;
    }
    if (c === "<" && links) {
      ANGLE_LINK.lastIndex = i;
      const auto = ANGLE_LINK.exec(text);
      const href = auto ? safeHref(auto[1]!) : null;
      if (auto && href) {
        flush();
        out.push({ kind: "link", href, children: [{ kind: "text", text: auto[1]! }] });
        i += auto[0].length;
        continue;
      }
    }
    // A bare address starts a line or follows a space or a bracket (not a quote: that is markup).
    if (c === "h" && links && /^$|[\s(]/.test(text[i - 1] ?? "")) {
      AUTOLINK.lastIndex = i;
      const auto = AUTOLINK.exec(text);
      if (auto) {
        let end = auto[0].length;
        while (end > 0 && TRAILING.has(auto[0][end - 1]!)) end--;
        const url = auto[0].slice(0, end);
        const href = safeHref(url);
        if (href) {
          flush();
          out.push({ kind: "link", href, children: [{ kind: "text", text: url }] });
          i += url.length;
          continue;
        }
      }
    }
    const marker = nest ? markerAt(text, i) : null;
    if (marker) {
      const span = unclosed.has(marker) ? undefined : readSpan(text, i, marker);
      if (span) {
        flush();
        const kind = marker === "~~" ? "del" : marker.length === 2 ? "strong" : "em";
        out.push({ kind, children: readInline(span.inner, depth + 1, links) });
        i = span.end;
        continue;
      }
      // A marker that can't open (a space after it) says nothing of the ones after it; one that
      // opened and found no closer does.
      if (span === undefined) unclosed.add(marker);
      plain += marker;
      i += marker.length;
      continue;
    }
    plain += c;
    i++;
  }
  flush();
  return out;
}

function markerAt(text: string, at: number): string | null {
  const two = text.slice(at, at + 2);
  if (two === "**" || two === "__" || two === "~~") return two;
  return text[at] === "*" || text[at] === "_" ? text[at]! : null;
}

/** Where each `[` closes, or -1 where it never does: one pass, with a stack. */
function matchBrackets(text: string): Int32Array {
  const close = new Int32Array(text.length).fill(-1);
  const open: number[] = [];
  for (let j = 0; j < text.length; j++) {
    if (text[j] === "\\") j++;
    else if (text[j] === "[") open.push(j);
    else if (text[j] === "]" && open.length) close[open.pop()!] = j;
  }
  return close;
}

/** `[label](href)` or `![alt](src)` starting at `at`. */
function readLink(
  text: string,
  at: number,
  brackets: Int32Array,
): { label: string; href: string; image: boolean; end: number } | null {
  const image = text[at] === "!";
  const open = image ? at + 1 : at;
  const close = brackets[open]!;
  if (close < 0 || text[close + 1] !== "(") return null;
  LINK_TARGET.lastIndex = close + 1;
  const target = LINK_TARGET.exec(text);
  if (!target) return null;
  return {
    label: text.slice(open + 1, close),
    href: target[1]!,
    image,
    end: close + 1 + target[0].length,
  };
}

/**
 * An emphasis span opened by `marker` at `at`: it must hug its text on both sides, and an
 * underscore must stand at a word's edge, so snake_case and 2 * 3 * 4 stay as they are. Null
 * when the marker can't open a span here; undefined when it could but nothing closes it.
 */
function readSpan(
  text: string,
  at: number,
  marker: string,
): { inner: string; end: number } | null | undefined {
  const from = at + marker.length;
  if (/\s/.test(text[from] ?? " ")) return null;
  if (marker[0] === "_" && /\w/.test(text[at - 1] ?? "")) return null;
  let j = from;
  for (;;) {
    j = text.indexOf(marker, j + 1);
    if (j < 0) return undefined;
    // `*a **b** c*`: a single marker skips over a double one.
    if (marker.length === 1 && text[j + 1] === marker) {
      j++;
      continue;
    }
    if (text[j - 1] === "\\" || /\s/.test(text[j - 1]!)) continue;
    if (marker[0] === "_" && /\w/.test(text[j + marker.length] ?? "")) continue;
    return { inner: text.slice(from, j), end: j + marker.length };
  }
}
