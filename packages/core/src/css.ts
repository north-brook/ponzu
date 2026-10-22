/**
 * Small, forgiving parser for inline style attributes. It splits on
 * semicolons that sit outside strings and parentheses, so values like
 * `url(data:image/png;base64,...)` survive. Bare numbers on properties that
 * need a length get px (see `cssValue`).
 */
export function parseStyle(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const decl of splitTopLevel(text, ";")) {
    const colon = indexOfTopLevel(decl, ":");
    if (colon < 0) continue;
    const prop = decl.slice(0, colon).trim();
    const value = decl.slice(colon + 1).trim();
    if (!prop || !value) continue;
    const key = prop.startsWith("--") ? prop : prop.toLowerCase();
    out[key] = cssValue(key, value);
  }
  return out;
}

export function serializeStyle(style: Record<string, string>): string {
  return Object.entries(style)
    .map(([k, v]) => `${k}:${v}`)
    .join(";");
}

/** camelCase or kebab-case in, kebab-case out. Custom properties pass through. */
export function toKebab(prop: string): string {
  if (prop.startsWith("--")) return prop;
  if (prop.includes("-")) return prop.toLowerCase();
  const kebab = prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  // WebkitFoo → -webkit-foo, msFoo → -ms-foo
  return /^(webkit|moz|ms|o)-/.test(kebab) ? `-${kebab}` : kebab;
}

export function toCamel(prop: string): string {
  if (prop.startsWith("--")) return prop;
  return prop
    .replace(/^-(webkit|moz|ms|o)-/, (_, v: string) => `${v}-`)
    .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Merge a patch into a style. Empty string or null removes a property. */
export function mergeStyle(
  base: Record<string, string>,
  patch: Record<string, string | number | null>,
): Record<string, string> {
  const out = { ...base };
  for (const [rawKey, rawValue] of Object.entries(patch)) {
    const key = toKebab(rawKey);
    if (rawValue === null || rawValue === "") {
      delete out[key];
      continue;
    }
    out[key] = cssValue(key, rawValue);
  }
  return out;
}

/** Properties where a bare number is valid CSS, so it never gets a unit. */
const UNITLESS = new Set([
  "opacity",
  "z-index",
  "font-weight",
  "line-height",
  "flex",
  "flex-grow",
  "flex-shrink",
  "order",
  "scale",
  "zoom",
  "aspect-ratio",
  "column-count",
  "columns",
  "fill-opacity",
  "stroke-opacity",
  "stop-opacity",
  "flood-opacity",
  "stroke-width",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-miterlimit",
  "animation-iteration-count",
  "border-image-outset",
  "border-image-slice",
  "border-image-width",
  "font-size-adjust",
  "grid-area",
  "grid-row",
  "grid-row-start",
  "grid-row-end",
  "grid-column",
  "grid-column-start",
  "grid-column-end",
  "initial-letter",
  "line-clamp",
  "box-flex",
  "box-flex-group",
  "box-ordinal-group",
  "flex-positive",
  "flex-negative",
  "flex-order",
  "counter-increment",
  "counter-reset",
  "counter-set",
  "hyphenate-limit-chars",
  "mask-border-outset",
  "mask-border-slice",
  "mask-border-width",
  "max-lines",
  "math-depth",
  "orphans",
  "widows",
  "shape-image-threshold",
  "tab-size",
]);

const BARE_NUMBER = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;

/**
 * One CSS value as Ponzu stores it. A bare number, given as a number or as a
 * string like "1440" or "16 24", gets px on properties that need a length,
 * because the browser drops `width:1440` entirely. Zero, custom properties
 * and the unitless properties above keep the number as is.
 */
export function cssValue(key: string, value: string | number): string {
  const text = String(value).trim();
  if (key.startsWith("--") || UNITLESS.has(key.replace(/^-(webkit|moz|ms|o)-/, ""))) return text;
  const parts = text.split(/\s+/);
  if (!parts.every((p) => BARE_NUMBER.test(p))) return text;
  return parts.map((p) => (Number(p) === 0 ? p : `${p}px`)).join(" ");
}

export function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === sep && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function indexOfTopLevel(text: string, ch: string): number {
  let depth = 0;
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === ch && depth === 0) return i;
  }
  return -1;
}

/** Colors that change with the theme: light-dark() or a prefers-color-scheme query. */
const THEMED = /light-dark\(|prefers-color-scheme/i;

/**
 * Whether a design changes with the theme, from its tokens and, given one, an
 * artboard's markup. Ones that don't look the same in light and dark, so they
 * render light everywhere.
 */
export function isThemed(tokens: string, artboard?: unknown): boolean {
  return THEMED.test(tokens) || (artboard !== undefined && THEMED.test(JSON.stringify(artboard)));
}

/** Custom properties declared in a tokens stylesheet, in order. */
export function parseTokens(css: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /(--[\w-]+)\s*:\s*([^;{}]+);?/g;
  for (let m = re.exec(stripped); m; m = re.exec(stripped)) {
    out.push({ name: m[1]!, value: m[2]!.trim() });
  }
  return out;
}

/** Set or remove custom properties in a tokens stylesheet, keeping everything else. */
export function setTokens(css: string, patch: Record<string, string | null>): string {
  let out = css.trim() ? css : ":root {\n}\n";
  for (const [name, value] of Object.entries(patch)) {
    const key = name.startsWith("--") ? name : `--${name}`;
    const re = new RegExp(`(^|[\\s;{])${escapeRe(key)}\\s*:[^;{}]*;?[ \\t]*\\n?`, "m");
    if (value === null) {
      out = out.replace(re, "$1");
      continue;
    }
    if (re.test(out)) {
      out = out.replace(re, (_m, pre: string) => `${pre}${key}: ${value};\n`);
    } else {
      const root = out.search(/:root\s*\{/);
      if (root >= 0) {
        const close = out.indexOf("}", root);
        out = `${out.slice(0, close)}  ${key}: ${value};\n${out.slice(close)}`;
      } else {
        out = `${out.trimEnd()}\n:root {\n  ${key}: ${value};\n}\n`;
      }
    }
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
