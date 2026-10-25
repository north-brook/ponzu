import { type Artboard, rewriteCssUrls, serializeArtboardElement } from "@ponzu/core";
import { googleFontLinks, googleFonts } from "./fonts.ts";

/**
 * Shared base styles for an artboard, in the canvas and in screenshots.
 * Artboards are flex columns by default and clip what overflows. Plain CSS
 * makes display: flex a row, so lint flags a root that sets it with no direction.
 * Black on white unless the design says otherwise, in either theme: text left
 * to the page's default would turn white in dark mode, on the white artboard.
 */
export const ARTBOARD_BASE_CSS = `
[data-artboard] { display: flex; flex-direction: column; position: relative; overflow: hidden; box-sizing: border-box; background: #fff; color: #000; }
[data-artboard] *, [data-artboard] *::before, [data-artboard] *::after { box-sizing: border-box; }
[data-artboard] img, [data-artboard] video, [data-artboard] svg { max-width: none; }
`;

export interface PageOptions {
  tokens: string;
  /** Base URL that relative asset paths resolve against. */
  assetBase?: string;
  /** Force a color scheme for light-dark() tokens. */
  colorScheme?: "light" | "dark";
  /**
   * Device px per artboard px when the render is shown small, like a
   * thumbnail. The design's raster assets then load as copies no wider than
   * the board drawn at that scale. Leave it out for screenshots and exports:
   * they need the originals.
   */
  imageScale?: number;
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
  const base = opts.assetBase;
  const step =
    base && opts.imageScale
      ? renditionStep((Number.parseFloat(ab.root.style.width ?? "") || 1440) * opts.imageScale)
      : 0;
  const body = serializeArtboardElement(ab, {
    rewriteUrl: (u) => {
      const url = resolveAsset(u, base);
      // Only the design's own assets: a thumbnail render doesn't proxy remote images.
      if (!step || !base || !url.startsWith(`${base.replace(/\/$/, "")}/assets/`)) return url;
      if (!isRasterUrl(url)) return url;
      return renditionUrl(url, step, base) ?? url;
    },
  });
  const fonts = googleFontLinks(googleFonts(body, opts.tokens));
  const scheme = opts.colorScheme ? `:root{color-scheme:${opts.colorScheme}}` : "";
  return `<!doctype html><html><head><meta charset="utf-8">
${fonts}
<style>${styleText(resolveTokenAssets(opts.tokens, opts.assetBase))}</style>
<style>html,body{margin:0;padding:0;background:transparent}${scheme}${ARTBOARD_BASE_CSS}</style>
</head><body>${body}</body></html>`;
}

/**
 * CSS with every prefers-color-scheme condition decided for `scheme`, for a
 * place that can't change the media preference itself, like a shadow root
 * on a page in the other theme.
 */
export function pinColorScheme(css: string, scheme: "light" | "dark"): string {
  return css.replace(/\(\s*prefers-color-scheme\s*:\s*(light|dark)\s*\)/gi, (_, s: string) =>
    s.toLowerCase() === scheme ? "(min-width: 0px)" : "(not (min-width: 0px))",
  );
}

/**
 * Widths the server makes smaller copies of images at, for a canvas showing
 * them small (`?w=` on an asset, or /api/image for a remote one). A copy
 * keeps its original's natural size, so it drops in anywhere without moving
 * anything. Past the largest, the canvas holds there: a 12k px original
 * would take over half a gigabyte decoded.
 */
export const RENDITION_WIDTHS = [256, 512, 1024, 2048, 4096, 8192] as const;

/** The copy width that draws `px` device pixels wide sharp. */
export function renditionStep(px: number): number {
  for (const s of RENDITION_WIDTHS) if (s >= px) return s;
  return RENDITION_WIDTHS[RENDITION_WIDTHS.length - 1]!;
}

const IMAGE_PATH = /\.(jpe?g|png|webp|avif|bmp|gif)$/i;

/** Whether a URL's path looks like a raster image, which could have smaller copies. */
export function isRasterUrl(url: string): boolean {
  const path = url.replace(/[?#].*$/, "");
  return IMAGE_PATH.test(path);
}

/**
 * The URL of a copy of the image at `url` that's `w` px wide: `?w=` on one of
 * the design's assets (under `assetBase`), the server's /api/image for a
 * remote one. Null for anything else (data:, blob:, another server's path).
 */
export function renditionUrl(url: string, w: number, assetBase: string): string | null {
  const base = assetBase.replace(/\/$/, "");
  if (url.startsWith(`${base}/assets/`)) {
    const u = url.replace(/([?&])w=\d+(&|$)/, (_m, a: string, b: string) => (b ? a : ""));
    const hash = u.indexOf("#");
    const head = hash < 0 ? u : u.slice(0, hash);
    const tail = hash < 0 ? "" : u.slice(hash);
    return `${head}${head.includes("?") ? "&" : "?"}w=${w}${tail}`;
  }
  if (/^https?:\/\//i.test(url) && !url.startsWith(`${originOf(base)}/`)) {
    return `${originOf(base)}/api/image?w=${w}&url=${encodeURIComponent(url)}`;
  }
  return null;
}

/** The URL a copy's URL was made from (see {@link renditionUrl}); any other URL as it is. */
export function originalUrl(url: string, assetBase: string): string {
  const base = assetBase.replace(/\/$/, "");
  const proxy = `${originOf(base)}/api/image?`;
  if (url.startsWith(proxy)) return new URLSearchParams(url.slice(proxy.length)).get("url") ?? url;
  if (url.startsWith(`${base}/assets/`) && /[?&]w=\d+/.test(url))
    return url
      .replace(/([?&])w=\d+(&?)/, (_m, a: string, b: string) => (b ? a : ""))
      .replace(/[?&]$/, "");
  return url;
}

/**
 * Whether the canvas could show a smaller copy of the image at `url` (already
 * resolved against `assetBase`): a raster asset of the design, or a remote
 * image. `ctx` says where the URL sits; a remote URL without an image file
 * extension only counts where it can only be an image.
 */
export function resizableUrl(
  url: string,
  assetBase: string,
  ctx?: { tag: string; attr: string },
): boolean {
  const base = assetBase.replace(/\/$/, "");
  if (url.startsWith(`${base}/assets/`)) return isRasterUrl(url);
  if (!/^https?:\/\//i.test(url) || url.startsWith(`${originOf(base)}/`)) return false;
  if (isRasterUrl(url)) return true;
  const tag = ctx?.tag.toLowerCase();
  return (
    (tag === "img" && (ctx!.attr === "src" || ctx!.attr === "srcset")) ||
    (tag === "source" && ctx!.attr === "srcset") ||
    (tag === "image" && (ctx!.attr === "href" || ctx!.attr === "xlink:href"))
  );
}

function originOf(url: string): string {
  const m = /^(https?:\/\/[^/]+)/i.exec(url);
  return m ? m[1]! : "";
}

/**
 * Tokens with their relative url()s resolved against the design's assets, so an
 * `@font-face { src: url(assets/brand.woff2) }` in tokens.css loads wherever the
 * artboard renders, not only beside the files.
 */
export function resolveTokenAssets(tokens: string, base?: string): string {
  return base ? rewriteCssUrls(tokens, (u) => resolveAsset(u, base)) : tokens;
}

/**
 * The @font-face rules in a stylesheet. A face declared inside a shadow root
 * never loads in Chromium, so the canvas lifts these into its host document.
 */
export function fontFaceRules(css: string): string[] {
  return css.match(/@font-face\s*\{[^}]*\}/gi) ?? [];
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
