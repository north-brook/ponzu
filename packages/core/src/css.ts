/**
 * Small, forgiving parser for inline style attributes. It splits on
 * semicolons that sit outside strings and parentheses, so values like
 * `url(data:image/png;base64,...)` survive.
 */
export function parseStyle(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const decl of splitTopLevel(text, ";")) {
    const colon = indexOfTopLevel(decl, ":");
    if (colon < 0) continue;
    const prop = decl.slice(0, colon).trim();
    const value = decl.slice(colon + 1).trim();
    if (!prop || !value) continue;
    out[prop.startsWith("--") ? prop : prop.toLowerCase()] = value;
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
    out[key] = typeof rawValue === "number" ? numberToCss(key, rawValue) : String(rawValue).trim();
  }
  return out;
}

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
  "fill-opacity",
  "stroke-opacity",
]);

function numberToCss(key: string, n: number): string {
  return UNITLESS.has(key) || key.startsWith("--") || n === 0 ? String(n) : `${n}px`;
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
