import { MAX_ID_LENGTH } from "./limits.ts";
import type { Dropped } from "./types.ts";

/**
 * What a design may hold, in one place. `parseHtml` applies these rules to HTML text as it
 * reads it; `sanitizeNode` and `sanitizeOp` apply them to node trees that never were HTML
 * text, such as an op a client posts to the API; `validateOp` uses the name rules.
 */

/**
 * The one script a design keeps: a scene (`<script type="ponzu/act">`), which
 * Ponzu reads as data and plays as animations (render/src/act.ts). A browser
 * never runs a script of a type it doesn't know, and this one is written out
 * with that type and nothing else whatever its node says, so no edit can make
 * it code. Every other script is dropped.
 */
export const ACT_SCRIPT_TYPE = "ponzu/act";

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

/** Attributes that hold one URL. */
export const URL_ATTRS = new Set([
  "href",
  "src",
  "xlink:href",
  "action",
  "formaction",
  "poster",
  "data",
]);

/** SVG animation values: an `<animate>` or `<set>` can put a script URL into an href. */
const ANIMATED_ATTRS = new Set(["to", "from", "by", "values"]);

/** Attributes a node keeps in fields of its own, so they never belong in `attrs`. */
const RESERVED_ATTRS = new Set(["style", "data-id", "data-name", "layer-name"]);

/**
 * Elements a parser reads as text up to their closing tag. An element inside one would be
 * written out as markup and read back as text, which lets an attribute's value close the
 * element early and become markup itself. So they hold text and nothing else, wherever they
 * are: an SVG `<title>` gives up the markup it could hold, for one rule that needs no context.
 */
const TEXT_ONLY = new Set([
  "script",
  "style",
  "title",
  "textarea",
  "xmp",
  "noembed",
  "noframes",
  "plaintext",
  // Blocked as well, and here so the serializer treats them the same.
  "iframe",
  "noscript",
]);

const ID = new RegExp(`^[A-Za-z0-9_-]{1,${MAX_ID_LENGTH}}$`);
const TAG_NAME = /^[A-Za-z][^\s/>\u0000-\u001f\u007f]*$/;
const ATTRIBUTE_NAME = /^[^\s"'<>/=\u0000-\u001f\u007f]+$/;
const STYLE_PROPERTY = /^[^\s:;"'(){}\u0000-\u001f\u007f]+$/;

/**
 * An id as it can be written anywhere one goes: an HTML attribute, a URL, a file name.
 * Every id Ponzu makes fits (`n_k3x9q`, `ab_1x2y3z4`).
 */
export function isId(value: string): boolean {
  return ID.test(value);
}

/** A tag that serializes as one tag: nothing in it can end the name or start an attribute. */
export function isTagName(tag: string): boolean {
  return TAG_NAME.test(tag);
}

/** An attribute name that serializes as one name. Framework spellings (`@click`, `:class`) fit. */
export function isAttributeName(name: string): boolean {
  return ATTRIBUTE_NAME.test(name) && name !== "__proto__";
}

/** A CSS property that serializes as one declaration's name. */
export function isStyleProperty(prop: string): boolean {
  return STYLE_PROPERTY.test(prop) && prop !== "__proto__";
}

export function isTextOnly(tag: string): boolean {
  return TEXT_ONLY.has(tag.toLowerCase());
}

/** An element as the rules see it: everything but its id, name and children. */
export interface Shell {
  tag: string;
  ns?: "svg" | "math";
  attrs: Record<string, string>;
  style: Record<string, string>;
}

/**
 * One element under the rules, its children aside: what stays of it, or null when the whole
 * element goes. A scene script comes back as exactly that, whatever else it carried.
 * What was removed is added to `dropped`.
 */
export function cleanShell(el: Shell, dropped: Dropped[]): Shell | null {
  const lower = el.tag.toLowerCase();
  const scene = lower === "script" && isActType(el.attrs);
  if (!isTagName(el.tag) || (BLOCKED_TAGS.has(lower) && !scene)) {
    dropped.push({ what: `<${el.tag}>` });
    return null;
  }
  const attrs = cleanAttrs(el.attrs, dropped, el.tag);
  if (scene) {
    // A scene: its text, and the type that keeps it data. src and the rest go.
    for (const name of Object.keys(attrs))
      if (name.toLowerCase() !== "type") dropped.push({ what: `${name} on <script>` });
    return { tag: "script", attrs: { type: ACT_SCRIPT_TYPE }, style: {} };
  }
  const shell: Shell = { tag: el.tag, attrs, style: cleanStyle(el.style, dropped, el.tag) };
  if (el.ns) shell.ns = el.ns;
  return shell;
}

/** The attributes that may stay, in their order. `tag` is only for saying where one was. */
export function cleanAttrs(
  attrs: Record<string, string>,
  dropped: Dropped[],
  tag?: string,
): Record<string, string> {
  const kept: [string, string][] = [];
  for (const [name, value] of Object.entries(attrs)) {
    const fault = attributeFault(name, value);
    if (fault === null) kept.push([name, value]);
    else dropped.push({ what: where(fault, tag) });
  }
  return Object.fromEntries(kept);
}

/** The declarations that may stay, in their order. */
export function cleanStyle(
  style: Record<string, string>,
  dropped: Dropped[],
  tag?: string,
): Record<string, string> {
  const kept: [string, string][] = [];
  for (const [prop, value] of Object.entries(style)) {
    if (!isStyleProperty(prop)) dropped.push({ what: where(`${prop} in style`, tag) });
    // A value with script in it goes whole: what's left of one would be a different value.
    else if (cleanCss(value) !== value) dropped.push({ what: where(`script in ${prop}`, tag) });
    else kept.push([prop, value]);
  }
  return Object.fromEntries(kept);
}

/**
 * CSS with nothing in it that an engine has ever run as script: `expression()`, and
 * `javascript:`, bare or as the scheme of a `url()` however it's spaced. For a style sheet's
 * text, the tokens, and (through `cleanStyle`) each inline value.
 */
export function cleanCss(css: string): string {
  let out = css;
  // Again until nothing changes: taking one out can join the text around it into another.
  for (;;) {
    const next = out
      .replace(/(?:java|vb)script:/gi, "")
      .replace(URL_START, (whole, open: string, url: string) => (isScriptUrl(url) ? open : whole))
      .replace(/expression\s*\(/gi, "x(");
    if (next === out) return out;
    out = next;
  }
}

/** A style sheet's text under the rules. */
export function cleanSheet(css: string, dropped: Dropped[]): string {
  const clean = cleanCss(css);
  if (clean !== css) dropped.push({ what: "script inside <style>" });
  return clean;
}

/** Where a `url()` opens, and what its URL starts with: enough to read the scheme. */
const URL_START = /(url\(\s*['"]?)([^'")]*)/gi;

function isActType(attrs: Record<string, string>): boolean {
  const name = Object.keys(attrs).find((k) => k.toLowerCase() === "type");
  return name !== undefined && attrs[name]!.trim().toLowerCase() === ACT_SCRIPT_TYPE;
}

/** Why an attribute can't stay, in the words a tool result uses, or null when it can. */
function attributeFault(name: string, value: string): string | null {
  const lower = name.toLowerCase();
  if (
    !isAttributeName(name) ||
    lower.startsWith("on") ||
    lower === "srcdoc" ||
    RESERVED_ATTRS.has(lower)
  )
    return name;
  const script = URL_ATTRS.has(lower)
    ? isScriptUrl(value)
    : ANIMATED_ATTRS.has(lower) && value.split(";").some(isScriptUrl);
  return script ? `javascript: URL in ${name}` : null;
}

function where(what: string, tag: string | undefined): string {
  return tag === undefined ? what : `${what} on <${tag}>`;
}

function isScriptUrl(value: string): boolean {
  // Browsers ignore control characters and whitespace in the scheme.
  const compact = value.replace(/[\u0000- ]/g, "").toLowerCase();
  return compact.startsWith("javascript:") || compact.startsWith("vbscript:");
}
