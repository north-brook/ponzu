import { type Artboard as AB, serializeArtboardElement } from "@ponzu/core";
import {
  ARTBOARD_BASE_CSS,
  fontFaceRules,
  type GoogleFontRequest,
  googleFontElement,
  googleFonts,
  pinColorScheme,
  resolveAsset,
  resolveTokenAssets,
  styleText,
} from "@ponzu/render";
import { memo, useLayoutEffect, useRef } from "react";

interface Props {
  artboard: AB;
  tokens: string;
  assetBase?: string;
  colorScheme?: "light" | "dark";
}

const loadedFonts = new Set<string>();

/**
 * Load Google Fonts in the host document; shadow roots inherit @font-face.
 * One stylesheet per family, the same ones screenshots use, so a family
 * Google rejects can't take the others down with it.
 */
function ensureFonts(fonts: GoogleFontRequest[]) {
  for (const f of fonts) {
    if (loadedFonts.has(f.href)) continue;
    loadedFonts.add(f.href);
    document.head.appendChild(googleFontElement(document, f));
  }
}

const loadedFaces = new Set<string>();

/**
 * Declare a design's own @font-face rules (from tokens.css) in the host
 * document: inside a shadow root Chromium ignores them, and the artboard's
 * text falls back to the next family.
 */
function ensureFaces(rules: string[]) {
  const fresh = rules.filter((r) => !loadedFaces.has(r));
  if (!fresh.length) return;
  for (const r of fresh) loadedFaces.add(r);
  const style = document.createElement("style");
  style.dataset.ponzuFaces = "";
  style.textContent = fresh.join("\n");
  document.head.appendChild(style);
}

/**
 * One artboard, rendered by the host page's own engine inside a shadow root
 * so its styles can't leak in or out. Re-renders only when the artboard or
 * tokens change.
 */
export const ArtboardView = memo(function ArtboardView({
  artboard,
  tokens,
  assetBase,
  colorScheme,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const last = useRef("");

  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const root = el.shadowRoot ?? el.attachShadow({ mode: "open" });
    const markup = serializeArtboardElement(artboard, {
      rewriteUrl: (u) => resolveAsset(u, assetBase),
    });
    // The page's media preference is the system's; a canvas in its own theme decides them here.
    const pin = (css: string) => (colorScheme ? pinColorScheme(css, colorScheme) : css);
    const body = pin(markup);
    const scheme = colorScheme ? `:host{color-scheme:${colorScheme}}` : "";
    // Tokens' url()s resolve like the artboard's: an @font-face in tokens.css finds assets/ too.
    const resolved = resolveTokenAssets(tokens, assetBase);
    const html = `<style>${styleText(pin(hostTokens(resolved)))}${scheme}${ARTBOARD_BASE_CSS}</style>${body}`;
    if (html === last.current) return;
    last.current = html;
    ensureFonts(googleFonts(body, tokens));
    ensureFaces(fontFaceRules(resolved));
    root.innerHTML = html;
  }, [artboard, tokens, assetBase, colorScheme]);

  return <div ref={host} data-artboard-host={artboard.id} style={{ display: "contents" }} />;
});

/** Custom properties declared on :root apply to :host inside a shadow root. */
function hostTokens(css: string): string {
  return css.replace(/:root\b/g, ":host");
}
