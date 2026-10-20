import { type DefaultTreeAdapterTypes as P5, parseFragment } from "parse5";
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
}

export interface ParseResult {
  nodes: PNode[];
  dropped: Dropped[];
}

/** Parse an HTML fragment into Ponzu nodes, removing anything executable. */
export function parseHtml(html: string, opts: ParseOptions = {}): ParseResult {
  const dropped: Dropped[] = [];
  const frag = parseFragment(html);
  const assign = opts.assignId ?? "random";
  const seen = new Set<string>();
  const nodes = convertChildren(frag.childNodes, [], assign, dropped, seen);
  return { nodes, dropped };
}

function convertChildren(
  list: P5.ChildNode[],
  path: number[],
  assign: NonNullable<ParseOptions["assignId"]>,
  dropped: Dropped[],
  seen: Set<string>,
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
    out.push(convertElement(el, childPath, assign, dropped, seen));
  }
  return out;
}

function convertElement(
  el: P5.Element,
  path: number[],
  assign: NonNullable<ParseOptions["assignId"]>,
  dropped: Dropped[],
  seen: Set<string>,
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
  if (!id || seen.has(id)) id = assign === "random" ? newId("n") : assign(path);
  seen.add(id);
  const ns = el.namespaceURI === NS_SVG ? "svg" : el.namespaceURI === NS_MATH ? "math" : undefined;
  const node: PElement = { kind: "el", id, tag: el.tagName, attrs, style, children: [] };
  if (ns) node.ns = ns;
  if (name !== undefined) node.name = name;
  node.children = convertChildren(el.childNodes, path, assign, dropped, seen);
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

export interface SerializeOptions {
  /** Rewrite relative URLs, for example to resolve assets while rendering. */
  rewriteUrl?: (url: string) => string;
  /** Leave out data-id attributes (cleaner HTML for agents that don't need them). */
  omitIds?: boolean;
}

export function serializeNodes(nodes: PNode[], opts: SerializeOptions = {}): string {
  let out = "";
  for (const n of nodes) out += serializeNode(n, opts, false);
  return out;
}

export function serializeNode(node: PNode, opts: SerializeOptions = {}, rawText = false): string {
  if (node.kind === "text") return rawText ? node.value : escapeText(node.value);
  let out = `<${node.tag}`;
  if (!opts.omitIds) out += ` data-id="${node.id}"`;
  if (node.name !== undefined) out += ` data-name="${escapeAttr(node.name)}"`;
  for (const [k, v] of Object.entries(node.attrs)) {
    const value = opts.rewriteUrl && URL_ATTRS.has(k.toLowerCase()) ? opts.rewriteUrl(v) : v;
    out += v === "" && isBooleanish(k) ? ` ${k}` : ` ${k}="${escapeAttr(value)}"`;
  }
  const style = serializeStyle(node.style);
  if (style)
    out += ` style="${escapeAttr(opts.rewriteUrl ? rewriteCssUrls(style, opts.rewriteUrl) : style)}"`;
  if (!node.ns && VOID.has(node.tag)) return `${out}>`;
  if (node.ns && node.children.length === 0) return `${out}/>`;
  out += ">";
  const raw = RAW_TEXT.has(node.tag);
  for (const c of node.children) {
    if (raw && c.kind === "text" && opts.rewriteUrl)
      out += rewriteCssUrls(c.value, opts.rewriteUrl);
    else out += serializeNode(c, opts, raw);
  }
  return `${out}</${node.tag}>`;
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

export function rewriteCssUrls(css: string, rewrite: (url: string) => string): string {
  return css.replace(
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/g,
    (_m, q: string, url: string) => `url(${q}${rewrite(url)}${q})`,
  );
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
  const s = `${seed}/${path.join(".")}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  const v = ((h1 >>> 0) * 0x100000 + ((h2 >>> 0) & 0xfffff)).toString(36);
  return `n_${v.slice(-7)}`;
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
): { artboard: Artboard; dropped: Dropped[] } {
  const seed = fallback.id;
  const { nodes, dropped } = parseHtml(html, { assignId: (p) => positionalId(seed, p) });
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
  return { artboard: { id: root.id, name, x, y, root }, dropped };
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
