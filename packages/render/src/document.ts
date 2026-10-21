import { type Artboard, serializeArtboardElement } from "@ponzu/core";
import { googleFontLinks, googleFonts } from "./fonts.ts";

/**
 * Shared base styles for an artboard, in the canvas and in screenshots.
 * Artboards are flex columns by default, like Paper, and clip what overflows.
 */
export const ARTBOARD_BASE_CSS = `
[data-artboard] { display: flex; flex-direction: column; position: relative; overflow: hidden; box-sizing: border-box; background: #fff; }
[data-artboard] *, [data-artboard] *::before, [data-artboard] *::after { box-sizing: border-box; }
[data-artboard] img, [data-artboard] video, [data-artboard] svg { max-width: none; }
`;

export interface PageOptions {
  tokens: string;
  /** Base URL that relative asset paths resolve against. */
  assetBase?: string;
  /** Force a color scheme for light-dark() tokens. */
  colorScheme?: "light" | "dark";
}

/**
 * CSS to put inside a <style> element. A design's tokens are any CSS, and a
 * `</style` in them would end the element and go on as markup, script
 * handlers and all. CSS can't use the sequence, so escaping it changes nothing.
 */
export function styleText(css: string): string {
  return css.replace(/<\/(style)/gi, "<\\/$1");
}

/** A standalone HTML page that renders one artboard at the origin. */
export function artboardPage(ab: Artboard, opts: PageOptions): string {
  const body = serializeArtboardElement(ab, { rewriteUrl: (u) => resolveAsset(u, opts.assetBase) });
  const fonts = googleFontLinks(googleFonts(body, opts.tokens));
  const scheme = opts.colorScheme ? `:root{color-scheme:${opts.colorScheme}}` : "";
  return `<!doctype html><html><head><meta charset="utf-8">
${fonts}
<style>${styleText(opts.tokens)}</style>
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
