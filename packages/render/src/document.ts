import { type Artboard, serializeArtboardElement } from "@ponzu/core";

/**
 * Shared base styles for an artboard, in the canvas and in screenshots.
 * Artboards are flex columns by default, like Paper, and clip what overflows.
 */
export const ARTBOARD_BASE_CSS = `
[data-artboard] { display: flex; flex-direction: column; position: relative; overflow: hidden; box-sizing: border-box; background: #fff; }
[data-artboard] *, [data-artboard] *::before, [data-artboard] *::after { box-sizing: border-box; }
[data-artboard] img, [data-artboard] video, [data-artboard] svg { max-width: none; }
`;

/** Google Fonts named in font-family declarations, so text renders the same everywhere. */
export function googleFontsLink(html: string, tokens: string): string {
  const families = new Set<string>();
  const add = (list: string) => {
    for (const raw of list.split(",")) {
      const name = raw.trim().replace(/^['"]|['"]$/g, "");
      if (
        name &&
        !GENERIC.has(name.toLowerCase()) &&
        !name.startsWith("var(") &&
        !SYSTEM.has(name.toLowerCase())
      )
        families.add(name);
    }
  };
  for (const src of [html.replace(/&quot;/g, "'"), tokens]) {
    // font-family: A, B
    for (const m of src.matchAll(/font-family\s*:\s*([^;"}]+)/gi)) add(m[1]!);
    // font: 600 40px/1 A, B  (the family list follows the size)
    for (const m of src.matchAll(
      /(?:^|[;"\s{])font\s*:\s*[^;"}]*?\d[\d.]*(?:px|em|rem|%|pt|vw|vh)(?:\s*\/\s*[\w.%-]+)?\s+([^;"}]+)/gi,
    ))
      add(m[1]!);
  }
  // Token values like --font-sans: "Inter Tight"
  for (const m of tokens.matchAll(/--font[\w-]*\s*:\s*([^;]+);/g)) {
    for (const raw of m[1]!.split(",")) {
      const name = raw.trim().replace(/^['"]|['"]$/g, "");
      if (name && !GENERIC.has(name.toLowerCase()) && !SYSTEM.has(name.toLowerCase()))
        families.add(name);
    }
  }
  if (!families.size) return "";
  const q = [...families]
    .slice(0, 12)
    .map(
      (f) => `family=${encodeURIComponent(f).replace(/%20/g, "+")}:ital,wght@0,100..900;1,100..900`,
    )
    .join("&");
  return `https://fonts.googleapis.com/css2?${q}&display=block`;
}

const GENERIC = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
  "inherit",
  "initial",
  "unset",
]);
const SYSTEM = new Set([
  "-apple-system",
  "blinkmacsystemfont",
  "segoe ui",
  "helvetica",
  "helvetica neue",
  "arial",
  "sf pro",
  "sf pro text",
  "sf pro display",
  "sf mono",
  "menlo",
  "monaco",
  "consolas",
  "times",
  "times new roman",
  "georgia",
  "courier",
  "courier new",
  "apple color emoji",
]);

export interface PageOptions {
  tokens: string;
  /** Base URL that relative asset paths resolve against. */
  assetBase?: string;
  /** Force a color scheme for light-dark() tokens. */
  colorScheme?: "light" | "dark";
}

/** A standalone HTML page that renders one artboard at the origin. */
export function artboardPage(ab: Artboard, opts: PageOptions): string {
  const body = serializeArtboardElement(ab, { rewriteUrl: (u) => resolveAsset(u, opts.assetBase) });
  const fonts = googleFontsLink(body, opts.tokens);
  const scheme = opts.colorScheme ? `:root{color-scheme:${opts.colorScheme}}` : "";
  return `<!doctype html><html><head><meta charset="utf-8">
${fonts ? `<link rel="stylesheet" href="${fonts}">` : ""}
<style>${opts.tokens}</style>
<style>html,body{margin:0;padding:0;background:transparent}${scheme}${ARTBOARD_BASE_CSS}</style>
</head><body>${body}</body></html>`;
}

export function resolveAsset(url: string, base?: string): string {
  if (!base) return url;
  if (/^(https?:|data:|blob:|#|\/\/)/i.test(url)) return url;
  const clean = url
    .replace(/^(\.\.\/)+/, "")
    .replace(/^\.\//, "")
    .replace(/^\//, "");
  return `${base.replace(/\/$/, "")}/${clean}`;
}
