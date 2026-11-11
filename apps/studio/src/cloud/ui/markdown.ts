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

const startsBlock = (line: string) =>
  FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line);

export function parseMarkdown(source: string): Block[] {
  // HTML comments (pull request templates are full of them) say nothing to a reader.
  const text = source.replace(/<!--[\s\S]*?(?:-->|$)/g, "").replace(/\r\n?/g, "\n");
  return parseBlocks(text.split("\n"));
}

function parseBlocks(lines: string[]): Block[] {
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
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      for (; i < lines.length && QUOTE.test(lines[i]!); i++)
        quoted.push(QUOTE.exec(lines[i]!)![1]!);
      blocks.push({ kind: "quote", children: parseBlocks(quoted) });
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
    for (; i < lines.length && lines[i]!.trim() && !startsBlock(lines[i]!); i++) {
      paragraph.push(lines[i]!.trim());
    }
    blocks.push({ kind: "paragraph", children: parseInline(paragraph.join("\n")) });
  }
  return blocks;
}

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!~<>|"']/;
const AUTOLINK = /^https?:\/\/[^\s<>]+/;

/** Reads emphasis, code, links and line breaks out of one block's text. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let plain = "";
  const flush = () => {
    if (plain) out.push({ kind: "text", text: plain });
    plain = "";
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    const rest = text.slice(i);

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
      const ticks = /^`+/.exec(rest)![0];
      const end = text.indexOf(ticks, i + ticks.length);
      if (end > 0) {
        flush();
        out.push({ kind: "code", text: text.slice(i + ticks.length, end).trim() || " " });
        i = end + ticks.length;
        continue;
      }
      plain += ticks;
      i += ticks.length;
      continue;
    }
    const link = c === "[" || (c === "!" && text[i + 1] === "[") ? readLink(text, i) : null;
    if (link) {
      flush();
      const href = safeHref(link.href);
      // An image is never drawn: it would load from wherever its address says, as the reader
      // reads. It becomes a link to the picture, named by its alt text.
      const label = link.image && !link.label ? link.href : link.label;
      const children = link.image ? [{ kind: "text" as const, text: label }] : parseInline(label);
      if (href) out.push({ kind: "link", href, children });
      else out.push(...children);
      i = link.end;
      continue;
    }
    if (c === "<") {
      const auto = /^<(https?:\/\/[^\s<>]+|mailto:[^\s<>]+)>/.exec(rest);
      const href = auto ? safeHref(auto[1]!) : null;
      if (auto && href) {
        flush();
        out.push({ kind: "link", href, children: [{ kind: "text", text: auto[1]! }] });
        i += auto[0].length;
        continue;
      }
    }
    // A bare address starts a line or follows a space or a bracket (not a quote: that is markup).
    if (c === "h" && /^$|[\s(]/.test(text[i - 1] ?? "")) {
      const auto = AUTOLINK.exec(rest);
      if (auto) {
        // Sentence punctuation after an address belongs to the sentence.
        const url = auto[0].replace(/[.,:;!?'")\]]+$/, "");
        const href = safeHref(url);
        if (href) {
          flush();
          out.push({ kind: "link", href, children: [{ kind: "text", text: url }] });
          i += url.length;
          continue;
        }
      }
    }
    const marker = /^(\*\*|__|~~|\*|_)/.exec(rest)?.[0];
    if (marker) {
      const span = readSpan(text, i, marker);
      if (span) {
        flush();
        const kind = marker === "~~" ? "del" : marker.length === 2 ? "strong" : "em";
        out.push({ kind, children: parseInline(span.inner) });
        i = span.end;
        continue;
      }
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

/** `[label](href)` or `![alt](src)` starting at `at`, with balanced brackets. */
function readLink(
  text: string,
  at: number,
): { label: string; href: string; image: boolean; end: number } | null {
  const image = text[at] === "!";
  const open = image ? at + 1 : at;
  let depth = 0;
  let close = -1;
  for (let j = open; j < text.length; j++) {
    if (text[j] === "\\") j++;
    else if (text[j] === "[") depth++;
    else if (text[j] === "]" && --depth === 0) {
      close = j;
      break;
    }
  }
  if (close < 0 || text[close + 1] !== "(") return null;
  const target = /^\(\s*<?([^\s()<>]*(?:\([^\s()]*\)[^\s()<>]*)*)>?(?:\s+"[^"]*")?\s*\)/.exec(
    text.slice(close + 1),
  );
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
 * underscore must stand at a word's edge, so snake_case and 2 * 3 * 4 stay as they are.
 */
function readSpan(text: string, at: number, marker: string): { inner: string; end: number } | null {
  const from = at + marker.length;
  if (/\s/.test(text[from] ?? " ")) return null;
  if (marker[0] === "_" && /\w/.test(text[at - 1] ?? "")) return null;
  let j = from;
  for (;;) {
    j = text.indexOf(marker, j + 1);
    if (j < 0) return null;
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
