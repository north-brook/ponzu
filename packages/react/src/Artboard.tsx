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
import { useWindowStill } from "./still.ts";

interface Props {
  artboard: AB;
  tokens: string;
  assetBase?: string;
  colorScheme?: "light" | "dark";
  /** An agent's new pieces, which arrive as they render. */
  arrivals?: Arrivals;
  /** Nobody can see it move (off screen, tiny, mid-gesture, window away): its loops hold. */
  hold?: boolean;
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
  hold: held = false,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const last = useRef("");
  // Every board, the home screen's previews too, holds while nobody can be watching the window.
  const hold = useWindowStill() || held;

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

  // After the markup above: a re-render brings fresh loops, held again here.
  useLayoutEffect(() => {
    const root = host.current?.shadowRoot;
    if (!root) return;
    holdLoops(root, hold);
    if (!hold) return;
    // A loop that starts later holds too: a hover's, or a video that autoplays once it's loaded.
    const onStart = () => holdLoops(root, true);
    root.addEventListener("animationstart", onStart);
    root.addEventListener("play", onStart, true);
    return () => {
      root.removeEventListener("animationstart", onStart);
      root.removeEventListener("play", onStart, true);
    };
  }, [hold, artboard, tokens, assetBase, colorScheme]);

  return <div ref={host} data-artboard-host={artboard.id} style={{ display: "contents" }} />;
});

/**
 * Stop or restart a board's infinite animations where they stand. Each loop redraws its board
 * every frame, and a page of them, under backdrop blurs, kept a MacBook Air's GPU busy all
 * afternoon. One-off entrances play out, so a board that's held still shows its settled page.
 * The rate, not pause(): pausing from script overrides the design's own animation-play-state
 * from then on, and a loop meant to run on :hover would stop answering it.
 */
function holdLoops(root: ShadowRoot, hold: boolean) {
  for (const a of root.getAnimations()) {
    if (a.effect?.getTiming().iterations === Number.POSITIVE_INFINITY)
      a.playbackRate = hold ? 0 : 1;
  }
  // SVG's own loops, and looping videos: only the ones that loop, and only what this held.
  // Each SMIL loop on its own: pausing its <svg> would stop a one-off entrance in it too.
  for (const el of root.querySelectorAll<SVGAnimationElement>(LOOPING_SMIL)) {
    if (hold && !heldSmil.has(el) && smilActive(el)) {
      el.endElement();
      heldSmil.add(el);
    } else if (!hold && heldSmil.delete(el)) el.beginElement();
  }
  for (const v of root.querySelectorAll("video")) {
    if (hold && v.loop && !v.paused) {
      v.pause();
      heldVideos.add(v);
    } else if (!hold && heldVideos.delete(v)) void v.play().catch(() => {});
  }
}

const LOOPING_SMIL = '[repeatCount="indefinite"], [repeatDur="indefinite"]';
const heldVideos = new WeakSet<HTMLVideoElement>();
const heldSmil = new WeakSet<SVGAnimationElement>();

/** Whether a SMIL animation is playing now: one waiting on a click or a time is left to it. */
function smilActive(el: SVGAnimationElement): boolean {
  try {
    return el.getStartTime() <= el.getCurrentTime();
  } catch {
    return false;
  }
}

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
