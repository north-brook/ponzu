import {
  defaultTreeAdapter,
  html as html5,
  type DefaultTreeAdapterTypes as P5,
  parseFragment,
} from "parse5";
import { parseStyle, serializeStyle } from "./css.ts";
import { newId } from "./ids.ts";
import { ACT_SCRIPT_TYPE, cleanSheet, cleanShell, isId, isTextOnly, URL_ATTRS } from "./rules.ts";
import type { Artboard, Dropped, PElement, PNode } from "./types.ts";

export { ACT_SCRIPT_TYPE };

const NS_SVG = "http://www.w3.org/2000/svg";
const NS_MATH = "http://www.w3.org/1998/Math/MathML";

const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

/**
 * Elements a parser doesn't read as ordinary HTML inside: foreign content, and the modes
 * where it skips tags. A `<style>` or a scene below one may not be read as raw text.
 */
const NOT_PLAIN = new Set(["svg", "math", "select", "frameset"]);

export interface ParseOptions {
  /**
   * Assign ids to elements that have none. `random` for new content,
   * or a function for stable ids derived from position (used when loading files).
   */
  assignId?: "random" | ((path: number[]) => string);
  /**
   * The element the fragment goes into. Inside SVG or MathML the fragment is
   * parsed as foreign content, as a browser's innerHTML would, so `<path/>`
   * closes itself instead of swallowing its siblings. HTML parents (or none)
   * parse as before.
   */
  parent?: Pick<PElement, "tag" | "ns" | "attrs">;
  /**
   * Ids already in the design the fragment goes into. A made-up id never takes one: five
   * random characters clash, now and then, with one of a large design's thousands.
   */
  taken?: ReadonlySet<string>;
}

export interface ParseResult {
  nodes: PNode[];
  dropped: Dropped[];
  /** Ids the parser made up, for elements that came without a usable data-id. */
  assigned: Set<string>;
}

/** Parse an HTML fragment into Ponzu nodes, removing what the rules forbid (rules.ts). */
export function parseHtml(html: string, opts: ParseOptions = {}): ParseResult {
  const dropped: Dropped[] = [];
  const context = opts.parent ? foreignContext(opts.parent) : null;
  const frag = context ? parseFragment(context, html, {}) : parseFragment(html);
  const assign = opts.assignId ?? "random";
  // Ids written in the file are claimed up front, so a made-up id never takes one.
  const seen = new Set<string>();
  const written = new Set<string>();
  collectIds(frag.childNodes, written);
  const assigned = new Set<string>();
  const ids: IdState = { assign, seen, written, assigned, taken: opts.taken ?? new Set() };
  const nodes = convertChildren(frag.childNodes, [], ids, dropped);
  return { nodes, dropped, assigned };
}

interface IdState {
  assign: NonNullable<ParseOptions["assignId"]>;
  /** Ids given out so far. */
  seen: Set<string>;
  /** Every data-id in the fragment. */
  written: Set<string>;
  /** Ids made up for elements without a usable data-id. */
  assigned: Set<string>;
  /** Ids in the design already. */
  taken: ReadonlySet<string>;
}

function collectIds(list: P5.ChildNode[], out: Set<string>): void {
  for (const child of list) {
    const el = child as P5.Element;
    if (!el.attrs) continue;
    const id = el.attrs.find((a) => !a.prefix && a.name.toLowerCase() === "data-id")?.value.trim();
    if (id && isId(id)) out.add(id);
    collectIds(el.childNodes ?? [], out);
  }
}

function makeUpId(ids: IdState, path: number[]): string {
  const make = (n: number) =>
    ids.assign === "random" ? newId("n") : ids.assign(n ? [...path, -n] : path);
  let id = make(0);
  // Still derived from position on a clash, so it comes out the same next time.
  for (let n = 1; ids.seen.has(id) || ids.written.has(id) || ids.taken.has(id); n++) id = make(n);
  ids.assigned.add(id);
  return id;
}

/** A parse5 context element for an SVG or MathML parent; null for HTML. */
function foreignContext(parent: Pick<PElement, "tag" | "ns" | "attrs">): P5.Element | null {
  if (!parent.ns) return null;
  const ns = parent.ns === "svg" ? html5.NS.SVG : html5.NS.MATHML;
  const attrs = Object.entries(parent.attrs).map(([name, value]) => ({ name, value }));
  return defaultTreeAdapter.createElement(parent.tag, ns, attrs);
}

function convertChildren(
  list: P5.ChildNode[],
  path: number[],
  ids: IdState,
  dropped: Dropped[],
): PNode[] {
  const out: PNode[] = [];
  let elIndex = 0;
  for (const child of list) {
    if (child.nodeName === "#text") {
      const value = (child as P5.TextNode).value;
      const prev = out[out.length - 1];
      if (prev?.kind === "text") prev.value += value;
      else out.push({ kind: "text", value });
      continue;
    }
    if (child.nodeName === "#comment" || child.nodeName === "#documentType") continue;
    // A dropped element takes no place among its siblings, so the ids after it stay the same.
    const node = convertElement(child as P5.Element, [...path, elIndex], ids, dropped);
    if (!node) continue;
    elIndex++;
    out.push(node);
  }
  return out;
}

/** The element as a node, or null when the rules drop it. */
function convertElement(
  el: P5.Element,
  path: number[],
  ids: IdState,
  dropped: Dropped[],
): PElement | null {
  const attrs: Record<string, string> = {};
  let style: Record<string, string> = {};
  let id = "";
  let name: string | undefined;
  for (const a of el.attrs) {
    const key = a.prefix ? `${a.prefix}:${a.name}` : a.name;
    const lower = key.toLowerCase();
    if (lower === "style") style = parseStyle(a.value);
    else if (lower === "data-id") id = a.value.trim();
    else if (lower === "data-name" || lower === "layer-name") name = a.value;
    else attrs[key] = a.value;
  }
  const ns = el.namespaceURI === NS_SVG ? "svg" : el.namespaceURI === NS_MATH ? "math" : undefined;
  const shell = cleanShell({ tag: el.tagName, ns, attrs, style }, dropped);
  if (!shell) return null;
  // An id that couldn't be written back into an attribute as it is counts as none.
  if (!isId(id) || ids.seen.has(id)) id = makeUpId(ids, path);
  ids.seen.add(id);
  const { tag } = shell;
  const node: PElement = {
    kind: "el",
    id,
    tag,
    attrs: shell.attrs,
    style: shell.style,
    children: [],
  };
  if (shell.ns) node.ns = shell.ns;
  if (name !== undefined) node.name = name;
  if (!isTextOnly(tag)) {
    node.children = convertChildren(el.childNodes, path, ids, dropped);
    return node;
  }
  let text = "";
  for (const c of el.childNodes) {
    if (c.nodeName === "#text") text += (c as P5.TextNode).value;
    else if ("tagName" in c) dropped.push({ what: `<${c.tagName}> inside <${tag}>` });
  }
  if (tag === "style") text = cleanSheet(text, dropped);
  if (text) node.children.push({ kind: "text", value: text });
  return node;
}

/** Where a URL being rewritten sits: an element's attribute, or CSS (`attr` "style"). */
export interface UrlContext {
  /** The element's tag, or "style" for a style sheet's text. */
  tag: string;
  /** The attribute, lowercased: src, href, srcset, style... */
  attr: string;
}

export interface SerializeOptions {
  /**
   * Rewrite URLs, for example to resolve assets while rendering: attribute
   * URLs, each candidate of a srcset, and every url() or image-set() string
   * in CSS.
   */
  rewriteUrl?: (url: string, ctx: UrlContext) => string;
  /** Leave out data-id attributes (cleaner HTML for agents that don't need them). */
  omitIds?: boolean;
}

/**
 * Nodes as HTML that reads back as the same nodes, and as nothing more: whatever a tree
 * holds, no text or attribute in it comes out as markup of its own.
 *
 * That has to hold for trees no parser would produce (an element that claims a namespace it
 * can't have, an attribute changed after the fact), because an op can make any of them and a
 * browser reads the result. So the output doesn't lean on knowing where the parser will be.
 * Every element but an HTML void is closed with an end tag, which reads the same in HTML,
 * SVG and MathML. Text and attribute values are escaped, so they stay inert even inside an
 * element the parser reads as raw text. A style sheet and a scene are the two things that
 * must be written raw, and `writeNode` only does so where it is safe.
 *
 * The random trees in sanitize.test.ts check this against a parser with none of Ponzu's
 * rules, as a browser reads the HTML. Change how anything here is written and run them over
 * many more seeds than the suite does.
 */
export function serializeNodes(nodes: PNode[], opts: SerializeOptions = {}): string {
  let out = "";
  for (const n of nodes) out += writeNode(n, opts, true);
  return out;
}

export function serializeNode(node: PNode, opts: SerializeOptions = {}): string {
  return writeNode(node, opts, true);
}

/**
 * `plain` is whether the parser is certainly reading ordinary HTML here, so a `<style>` or a
 * scene is raw text to it: nothing above it is, or claims to be, SVG, MathML or a `<select>`.
 * Where that isn't certain, their text is written so it's inert as markup.
 */
function writeNode(node: PNode, opts: SerializeOptions, plain: boolean): string {
  if (node.kind === "text") return escapeText(node.value);
  const lower = node.tag.toLowerCase();
  if (lower === "script") return serializeActScript(node, opts, plain);
  let out = `<${node.tag}`;
  if (!opts.omitIds) out += ` data-id="${escapeAttr(node.id)}"`;
  if (node.name !== undefined) out += ` data-name="${escapeAttr(node.name)}"`;
  const rewrite = opts.rewriteUrl;
  for (const [k, v] of Object.entries(node.attrs)) {
    const attr = k.toLowerCase();
    let value = v;
    if (rewrite && URL_ATTRS.has(attr)) value = rewrite(v, { tag: node.tag, attr });
    else if (rewrite && SRCSET_ATTRS.has(attr))
      value = rewriteSrcset(v, (u) => rewrite(u, { tag: node.tag, attr }));
    out += v === "" && isBooleanish(k) ? ` ${k}` : ` ${k}="${escapeAttr(value)}"`;
  }
  const style = serializeStyle(node.style);
  if (style)
    out += ` style="${escapeAttr(
      rewrite ? rewriteCssUrls(style, (u) => rewrite(u, { tag: node.tag, attr: "style" })) : style,
    )}"`;
  if (!node.ns && VOID.has(lower)) return `${out}>`;
  // Never `<x/>`. A parser honors that only in SVG and MathML, and whether it is there
  // depends on more than a tree shows: `<p>` and `<font color>` leave SVG, an attribute makes
  // `<annotation-xml>` hold HTML. Where `/>` is ignored the element stays open and swallows
  // what follows, and a `<textarea/>` turns the rest of the artboard into its text.
  out += ">";
  if (isTextOnly(lower)) {
    // Read back as text, so written as text: an element here could close its parent early.
    for (const c of node.children) {
      if (c.kind !== "text") continue;
      if (lower !== "style") out += escapeText(c.value);
      else {
        const css = rewrite
          ? rewriteCssUrls(c.value, (u) => rewrite(u, { tag: node.tag, attr: "style" }))
          : c.value;
        out += rawCss(css, plain);
      }
    }
    return `${out}</${node.tag}>`;
  }
  const inside = plain && !node.ns && !NOT_PLAIN.has(lower);
  for (const c of node.children) out += writeNode(c, opts, inside);
  return `${out}</${node.tag}>`;
}

/**
 * A style sheet's text, unescaped as a parser expects it in `<style>`. A CSS escape stands in
 * for a `<` that could be read as markup: in ordinary HTML only `</style` can be, and
 * anywhere else (inside `<svg>`, say, where a style sheet is parsed as markup) any tag can.
 * The escape means the same in a CSS string, which is where CSS has such a `<`.
 */
function rawCss(css: string, plain: boolean): string {
  return css.replace(plain ? /<(?=\/style)/gi : /<(?=[a-z/!?])/gi, "\\3c ");
}

/**
 * A scene script, always as data: type ponzu/act whatever its node says, and text that can't
 * end the element early. Where a parser may not read a script as raw text, the text is
 * escaped as any other text is.
 */
function serializeActScript(node: PElement, opts: SerializeOptions, plain: boolean): string {
  let out = "<script";
  if (!opts.omitIds) out += ` data-id="${escapeAttr(node.id)}"`;
  if (node.name !== undefined) out += ` data-name="${escapeAttr(node.name)}"`;
  out += ` type="${ACT_SCRIPT_TYPE}">`;
  for (const c of node.children) {
    if (c.kind !== "text") continue;
    out += plain ? c.value.replace(/<(\/script|!--)/gi, "<\\$1") : escapeText(c.value);
  }
  return `${out}</script>`;
}

function isBooleanish(attr: string): boolean {
  return [
    "hidden",
    "disabled",
    "checked",
    "selected",
    "readonly",
    "required",
    "open",
    "autoplay",
    "muted",
    "loop",
    "playsinline",
    "controls",
    "multiple",
    "inert",
  ].includes(attr);
}

/** Every url() in CSS, and every bare string image in an image-set(). */
export function rewriteCssUrls(css: string, rewrite: (url: string) => string): string {
  const urls = css.replace(
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/g,
    (_m, q: string, url: string) => `url(${q}${rewrite(url)}${q})`,
  );
  if (!/image-set\(/i.test(urls)) return urls;
  // image-set("a.png" 1x, "b.png" 2x) names images by bare strings too: a
  // string that starts a candidate. One in a url() (rewritten above) or a
  // type("image/avif") doesn't, and every image-set() in the CSS counts.
  const open = /(?:-webkit-)?image-set\(/gi;
  let out = "";
  let from = 0;
  for (let m = open.exec(urls); m; m = open.exec(urls)) {
    let depth = 1;
    let candidate = true;
    let i = m.index + m[0].length;
    for (; i < urls.length && depth > 0; i++) {
      const c = urls[i]!;
      // A comment changes nothing: the candidate's string may still come after it.
      if (c === "/" && urls[i + 1] === "*") {
        const close = urls.indexOf("*/", i + 2);
        if (close < 0) break;
        i = close + 1;
      } else if (c === '"' || c === "'") {
        const close = urls.indexOf(c, i + 1);
        if (close < 0) break;
        if (candidate && depth === 1 && close > i + 1) {
          out += urls.slice(from, i + 1) + rewrite(urls.slice(i + 1, close));
          from = close;
        }
        i = close;
        candidate = false;
      } else if (c === "(") {
        depth++;
        candidate = false;
      } else if (c === ")") depth--;
      else if (c === "," && depth === 1) candidate = true;
      else if (c === ";" || c === "{" || c === "}") break;
      else if (!/\s/.test(c)) candidate = false;
    }
    open.lastIndex = i;
  }
  return out + urls.slice(from);
}

/** Attributes holding a list of image candidates. */
const SRCSET_ATTRS = new Set(["srcset", "imagesrcset"]);

/** Rewrite each candidate URL in a srcset, keeping its descriptors. */
export function rewriteSrcset(srcset: string, rewrite: (url: string) => string): string {
  return parseSrcset(srcset)
    .map((c) => (c.descriptor ? `${rewrite(c.url)} ${c.descriptor}` : rewrite(c.url)))
    .join(", ");
}

/** The candidates of a srcset, as the HTML spec splits them. */
export function parseSrcset(srcset: string): { url: string; descriptor: string }[] {
  const out: { url: string; descriptor: string }[] = [];
  let i = 0;
  const n = srcset.length;
  while (i < n) {
    while (i < n && (/\s/.test(srcset[i]!) || srcset[i] === ",")) i++;
    if (i >= n) break;
    let j = i;
    while (j < n && !/\s/.test(srcset[j]!)) j++;
    let url = srcset.slice(i, j);
    let descriptor = "";
    if (url.endsWith(",")) {
      url = url.replace(/,+$/, "");
      i = j;
    } else {
      let k = j;
      let paren = false;
      while (k < n && (paren || srcset[k] !== ",")) {
        if (srcset[k] === "(") paren = true;
        else if (srcset[k] === ")") paren = false;
        k++;
      }
      descriptor = srcset.slice(j, k).trim();
      i = k + 1;
    }
    if (url) out.push({ url, descriptor });
  }
  return out;
}

function escapeText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/ /g, "&nbsp;");
}

/**
 * `<` and `>` mean nothing inside a quoted value and are escaped all the same, as browsers
 * do when they serialize: a value that ends up read as the text of an element left open then
 * holds nothing that could close it and start a tag.
 */
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/ /g, "&nbsp;");
}

/** Deterministic id from a seed and position, so unchanged files keep the same ids across reloads. */
export function positionalId(seed: string, path: number[]): string {
  return hashedId("n", `${seed}/${path.join(".")}`);
}

/** A short id derived from `key`: the same key always gives the same id. */
export function hashedId(prefix: "n" | "ab", key: string): string {
  const s = key;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  const v = ((h1 >>> 0) * 0x100000 + ((h2 >>> 0) & 0xfffff)).toString(36);
  return `${prefix}_${v.slice(-7)}`;
}

/* ------------------------------------------------------------------ */
/* Artboard files                                                      */
/* ------------------------------------------------------------------ */

/**
 * An artboard file holds one `<section data-artboard>`. Anything outside it
 * is ignored. A file with no section is treated as the artboard's content.
 */
export function parseArtboardFile(
  html: string,
  fallback: { id: string; name: string },
): { artboard: Artboard; dropped: Dropped[]; assigned: Set<string> } {
  const seed = fallback.id;
  const { nodes, dropped, assigned } = parseHtml(html, { assignId: (p) => positionalId(seed, p) });
  const section = nodes.find(
    (n): n is PElement => n.kind === "el" && ("data-artboard" in n.attrs || n.tag === "section"),
  );
  let root: PElement;
  if (section && "data-artboard" in section.attrs) {
    root = section;
  } else {
    root = {
      kind: "el",
      id: fallback.id,
      tag: "section",
      attrs: { "data-artboard": "" },
      style: { width: "1440px", height: "900px" },
      children: nodes,
    };
  }
  const x = Number.parseFloat(root.attrs["data-x"] ?? "0") || 0;
  const y = Number.parseFloat(root.attrs["data-y"] ?? "0") || 0;
  delete root.attrs["data-x"];
  delete root.attrs["data-y"];
  delete root.attrs["data-artboard"];
  if (root.id.startsWith("n_") && section && !html.includes(`data-id="${root.id}"`))
    root.id = fallback.id;
  const name = root.name ?? fallback.name;
  root.name = name;
  return { artboard: { id: root.id, name, x, y, root }, dropped, assigned };
}

/**
 * Whether an artboard file reads as written to the end: its `<section data-artboard>`
 * opens and every section in it closes. A file read while something is still writing
 * it (emptied, or cut off partway) doesn't, so it isn't the artboard yet.
 */
export function artboardFileComplete(html: string): boolean {
  // A comment still being written runs to the end: nothing in it counts yet.
  const text = html.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  const open = /<section\b[^>]*\bdata-artboard\b[^>]*>/i.exec(text);
  if (!open) return false;
  let depth = 0;
  for (const m of text.slice(open.index).matchAll(/<(\/?)section\b[^>]*>/gi)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return true;
  }
  return false;
}

export function serializeArtboardFile(ab: Artboard): string {
  const root = ab.root;
  let open = `<section data-artboard data-id="${escapeAttr(ab.id)}" data-name="${escapeAttr(ab.name)}" data-x="${fmt(ab.x)}" data-y="${fmt(ab.y)}"`;
  for (const [k, v] of Object.entries(root.attrs)) open += ` ${k}="${escapeAttr(v)}"`;
  const style = serializeStyle(root.style);
  if (style) open += ` style="${escapeAttr(style)}"`;
  open += ">";
  const body = serializeNodes(root.children);
  const needsBreak = !body.startsWith("\n");
  return `${open}${needsBreak ? "\n" : ""}${body}${body.endsWith("\n") ? "" : "\n"}</section>\n`;
}

/** The artboard as a standalone element, for rendering. */
export function serializeArtboardElement(ab: Artboard, opts: SerializeOptions = {}): string {
  const root: PElement = {
    ...ab.root,
    attrs: { "data-artboard": "", ...ab.root.attrs },
    name: ab.name,
  };
  return serializeNode(root, opts);
}

function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}
