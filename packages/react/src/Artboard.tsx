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
import type { Arrivals } from "./arrive.ts";

interface Props {
  artboard: AB;
  tokens: string;
  assetBase?: string;
  colorScheme?: "light" | "dark";
  /** An agent's new pieces, which arrive as they render. */
  arrivals?: Arrivals;
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
  arrivals,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const last = useRef("");

  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const root = el.shadowRoot ?? el.attachShadow({ mode: "open" });
    const { html, fonts, faces } = artboardMarkup(artboard, tokens, assetBase, colorScheme);
    if (html === last.current) return;
    last.current = html;
    ensureFonts(fonts);
    ensureFaces(faces);
    root.innerHTML = html;
    arrivals?.replay(root);
  }, [artboard, tokens, assetBase, colorScheme, arrivals]);

  return <div ref={host} data-artboard-host={artboard.id} style={{ display: "contents" }} />;
});

/**
 * What an artboard's shadow root holds: its styles and markup, and the Google
 * Fonts it needs. Shared with the timelapse film, which measures boards with it.
 */
export function artboardMarkup(
  artboard: AB,
  tokens: string,
  assetBase?: string,
  colorScheme?: "light" | "dark",
): { html: string; fonts: GoogleFontRequest[]; faces: string[] } {
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
  return { html, fonts: googleFonts(body, tokens), faces: fontFaceRules(resolved) };
}

/** Load these Google Fonts and the design's own @font-face rules in the page, once each. */
export function loadArtboardFonts(fonts: GoogleFontRequest[], faces: string[] = []) {
  ensureFonts(fonts);
  ensureFaces(faces);
}

/** Custom properties declared on :root apply to :host inside a shadow root. */
function hostTokens(css: string): string {
  return css.replace(/:root\b/g, ":host");
}
