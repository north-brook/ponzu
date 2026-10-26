import {
  defaultTreeAdapter,
  html as html5,
  type DefaultTreeAdapterTypes as P5,
  parseFragment,
} from "parse5";
import { parseStyle, serializeStyle } from "./css.ts";
import { newId } from "./ids.ts";
import type { Artboard, Dropped, PElement, PNode } from "./types.ts";

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

/** Elements that never make it into a design. */
const BLOCKED_TAGS = new Set([
  "script",
  "noscript",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "base",
  "meta",
  "template",
  "portal",
]);

const URL_ATTRS = new Set(["href", "src", "xlink:href", "action", "formaction", "poster", "data"]);

/** Raw-text elements whose content is serialized without escaping. */
const RAW_TEXT = new Set(["style"]);

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
}

export interface ParseResult {
  nodes: PNode[];
  dropped: Dropped[];
  /** Ids the parser made up, for elements that came without a usable data-id. */
  assigned: Set<string>;
}

/** Parse an HTML fragment into Ponzu nodes, removing anything executable. */
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
  const ids: IdState = { assign, seen, written, assigned };
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
}

function collectIds(list: P5.ChildNode[], out: Set<string>): void {
  for (const child of list) {
    const el = child as P5.Element;
    if (!el.attrs) continue;
    const id = el.attrs.find((a) => !a.prefix && a.name.toLowerCase() === "data-id")?.value.trim();
    if (id) out.add(id);
    collectIds(el.childNodes ?? [], out);
  }
}

function makeUpId(ids: IdState, path: number[]): string {
  const make = (n: number) =>
    ids.assign === "random" ? newId("n") : ids.assign(n ? [...path, -n] : path);
  let id = make(0);
  // Still derived from position on a clash, so it comes out the same next time.
  for (let n = 1; ids.seen.has(id) || ids.written.has(id); n++) id = make(n);
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
    const el = child as P5.Element;
    const tag = el.tagName;
    if (BLOCKED_TAGS.has(tag.toLowerCase())) {
      dropped.push({ what: `<${tag}>` });
      continue;
    }
    const childPath = [...path, elIndex++];
    out.push(convertElement(el, childPath, ids, dropped));
  }
  return out;
}

function convertElement(
  el: P5.Element,
  path: number[],
  ids: IdState,
  dropped: Dropped[],
): PElement {
  const attrs: Record<string, string> = {};
  let style: Record<string, string> = {};
  let id = "";
  let name: string | undefined;
  for (const a of el.attrs) {
    const key = a.prefix ? `${a.prefix}:${a.name}` : a.name;
    const lower = key.toLowerCase();
    if (lower.startsWith("on")) {
      dropped.push({ what: `${key} on <${el.tagName}>` });
      continue;
    }
    if (URL_ATTRS.has(lower) && isScriptUrl(a.value)) {
      dropped.push({ what: `javascript: URL in ${key} on <${el.tagName}>` });
      continue;
    }
    if (lower === "style") style = parseStyle(a.value);
    else if (lower === "data-id") id = a.value.trim();
    else if (lower === "data-name" || lower === "layer-name") name = a.value;
    else if (lower === "srcdoc") dropped.push({ what: `srcdoc on <${el.tagName}>` });
    else attrs[key] = a.value;
  }
  if (!id || ids.seen.has(id)) id = makeUpId(ids, path);
  ids.seen.add(id);
  const ns = el.namespaceURI === NS_SVG ? "svg" : el.namespaceURI === NS_MATH ? "math" : undefined;
  const node: PElement = { kind: "el", id, tag: el.tagName, attrs, style, children: [] };
  if (ns) node.ns = ns;
  if (name !== undefined) node.name = name;
  node.children = convertChildren(el.childNodes, path, ids, dropped);
  if (RAW_TEXT.has(el.tagName)) {
    for (const c of node.children)
      if (c.kind === "text") c.value = sanitizeCssText(c.value, dropped);
  }
  return node;
}

function isScriptUrl(value: string): boolean {
  // Browsers ignore control characters and whitespace in the scheme.
  const compact = value.replace(/[\u0000- ]/g, "").toLowerCase();
  return compact.startsWith("javascript:") || compact.startsWith("vbscript:");
}

function sanitizeCssText(css: string, dropped: Dropped[]): string {
  if (/expression\s*\(|javascript:/i.test(css)) {
    dropped.push({ what: "script inside <style>" });
    return css.replace(/expression\s*\(/gi, "x(").replace(/javascript:/gi, "");
  }
  return css;
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

export function serializeNodes(nodes: PNode[], opts: SerializeOptions = {}): string {
  let out = "";
  for (const n of nodes) out += serializeNode(n, opts, false, false);
  return out;
}

/**
 * `inForeign` says whether a parser reading this node will be in SVG/MathML
 * content, where `<x/>` closes itself. Undefined (a node serialized on its
 * own) assumes a foreign node sits inside its own namespace.
 */
export function serializeNode(
  node: PNode,
  opts: SerializeOptions = {},
  rawText = false,
  inForeign?: boolean,
): string {
  if (node.kind === "text") return rawText ? node.value : escapeText(node.value);
  let out = `<${node.tag}`;
  if (!opts.omitIds) out += ` data-id="${node.id}"`;
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
  if (!node.ns && VOID.has(node.tag)) return `${out}>`;
  // HTML parsers honor `/>` on <svg> and <math> anywhere, and on any element
  // inside foreign content. Elsewhere it would be ignored and the element
  // would swallow its next siblings, so close it explicitly.
  const parsedForeign =
    !!node.ns && (node.tag === "svg" || node.tag === "math" || (inForeign ?? true));
  if (node.ns && node.children.length === 0)
    return parsedForeign ? `${out}/>` : `${out}></${node.tag}>`;
  out += ">";
  const raw = RAW_TEXT.has(node.tag);
  const foreign = parsedForeign && childrenAreForeign(node);
  for (const c of node.children) {
    if (raw && c.kind === "text" && rewrite)
      out += rewriteCssUrls(c.value, (u) => rewrite(u, { tag: node.tag, attr: "style" }));
    else out += serializeNode(c, opts, raw, foreign);
  }
  return `${out}</${node.tag}>`;
}

/** SVG elements whose children parse as HTML. */
const SVG_HTML_INTEGRATION = new Set(["foreignObject", "desc", "title"]);
/** MathML elements whose children (mostly) parse as HTML. */
const MATHML_TEXT_INTEGRATION = new Set(["mi", "mo", "mn", "ms", "mtext"]);

/** Whether a parser reads this element's children as foreign (SVG/MathML) content. */
function childrenAreForeign(node: PElement): boolean {
  if (node.ns === "svg") return !SVG_HTML_INTEGRATION.has(node.tag);
  if (node.ns === "math") {
    if (MATHML_TEXT_INTEGRATION.has(node.tag)) return false;
    if (node.tag === "annotation-xml") {
      const encoding = (node.attrs.encoding ?? "").toLowerCase();
      return encoding !== "text/html" && encoding !== "application/xhtml+xml";
    }
    return true;
  }
  return false;
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
      if (c === '"' || c === "'") {
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

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/ /g, "&nbsp;");
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

export function serializeArtboardFile(ab: Artboard): string {
  const root = ab.root;
  let open = `<section data-artboard data-id="${ab.id}" data-name="${escapeAttr(ab.name)}" data-x="${fmt(ab.x)}" data-y="${fmt(ab.y)}"`;
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
