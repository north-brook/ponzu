import { type Artboard as AB, serializeArtboardElement } from "@ponzu/core";
import {
  ARTBOARD_BASE_CSS,
  fontFaceRules,
  type GoogleFontRequest,
  googleFontElement,
  googleFonts,
  originalUrl,
  pinColorScheme,
  resolveAsset,
  resolveTokenAssets,
  styleText,
} from "@ponzu/render";
import { memo, useLayoutEffect, useRef } from "react";
import type { Arrivals } from "./arrive.ts";
import { BoardImages, firstStep, markupUrl } from "./images.ts";
import { BoardDetail, type Detail, holdLoops, STILL_CSS } from "./lod.ts";
import { animationsOf, MOTION_CSS, Motion } from "./motion.ts";
import { watchVideos } from "./pacer.tsx";
import { useWindowStill } from "./still.ts";

interface Props {
  artboard: AB;
  tokens: string;
  assetBase?: string;
  /** The asset host makes smaller copies of images (CanvasSource.renditions). */
  renditions?: boolean;
  colorScheme?: "light" | "dark";
  /**
   * How much of the board the person can see. The canvas passes it; without
   * it everything renders and plays at full detail, and images load as they are.
   */
  detail?: Detail;
  /** An agent's new pieces, which arrive as they render. */
  arrivals?: Arrivals;
  /**
   * Nobody can see it move (off screen, tiny, window away), or the camera moves over a crowded
   * view: its loops hold.
   */
  hold?: boolean;
  /** Rounded as the canvas rounds its boards, by `--pz-board-radius` on a parent. */
  rounded?: boolean;
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
 * so its styles can't leak in or out. Re-renders its content only when the
 * artboard or tokens change; how it's drawn only changes its detail.
 */
export const ArtboardView = memo(function ArtboardView({
  artboard,
  tokens,
  assetBase,
  renditions,
  colorScheme,
  detail,
  arrivals,
  hold: held = false,
  rounded = false,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const last = useRef("");
  // Every board, the home screen's previews too, holds while nobody can be watching the window.
  const hold = useWindowStill() || held;
  const motion = useRef<Motion | null>(null);
  const lod = useRef<BoardDetail | null>(null);
  const images = useRef<BoardImages | null>(null);
  const videos = useRef<ReturnType<typeof watchVideos> | null>(null);
  const drawn = useRef(detail);
  drawn.current = detail;
  /** Whether the board was hidden at the last detail: the pacer looks again when that changes. */
  const wasHidden = useRef(detail?.hidden);
  const sized = !!detail && !!assetBase && !!renditions;
  // The canvas's boards (they have detail) are kept cheap: motion.ts, lod.ts, the pacer, and a
  // reset so they start from what the server's pictures of them do. A preview (the home screen,
  // /gh, the phone) renders the board as it is.
  const tracked = !!detail;

  // Playing videos set the canvas's frame rate; see pacer.tsx.
  useLayoutEffect(() => {
    const el = host.current;
    if (!el || !tracked) return;
    const w = watchVideos(el.shadowRoot ?? el.attachShadow({ mode: "open" }));
    videos.current = w;
    return () => {
      videos.current = null;
      w.stop();
    };
  }, [tracked]);

  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const root = el.shadowRoot ?? el.attachShadow({ mode: "open" });
    const resolve = (u: string) => resolveAsset(u, assetBase);
    // The page's media preference is the system's; a canvas in its own theme decides them here.
    const pin = (css: string) => (colorScheme ? pinColorScheme(css, colorScheme) : css);
    const scheme = colorScheme ? `:host{color-scheme:${colorScheme}}` : "";
    // The canvas rounds its boards a touch, over whatever radius the design gave its root: the
    // corners are the canvas's. Thumbnails, screenshots and exports keep the design's own.
    const round = rounded ? "[data-artboard]{border-radius:var(--pz-board-radius)!important}" : "";
    // Tokens' url()s resolve like the artboard's: an @font-face in tokens.css finds assets/ too.
    const resolved = resolveTokenAssets(tokens, assetBase);
    const canvas = tracked ? `${MOTION_CSS}${STILL_CSS}` : "";
    const head = `<style data-pz-base>${tracked ? HOST_RESET : ""}${styleText(pin(hostTokens(resolved)))}${scheme}${round}${ARTBOARD_BASE_CSS}${canvas}</style>`;
    const body = pin(serializeArtboardElement(artboard, { rewriteUrl: resolve }));
    // Sized images or not is part of the content: a board that learns how it's drawn renders again.
    const key = `${sized ? "sized" : ""}${head}${body}`;
    if (key === last.current) return;
    last.current = key;
    ensureFonts(googleFonts(body, tokens));
    ensureFaces(fontFaceRules(resolved));
    let html = head + body;
    const d = drawn.current;
    if (sized && d && assetBase) {
      // Images ask for copies: what they last showed, or small ones to start.
      const width = Number.parseFloat(artboard.root.style.width ?? "") || 1440;
      const first = firstStep(width, d.scale);
      const shown = images.current;
      html =
        head +
        pin(
          serializeArtboardElement(artboard, {
            rewriteUrl: (u, ctx) => {
              const url = resolve(u);
              const step = shown?.stepFor(originalUrl(url, assetBase)) ?? first;
              return markupUrl(url, assetBase, ctx, step);
            },
          }),
        );
    }
    root.innerHTML = html;
    // Before the first paint: decoding an image never holds up a frame.
    for (const img of root.querySelectorAll("img"))
      if (!img.hasAttribute("decoding")) img.decoding = "async";
    lod.current?.reset();
    if (tracked) {
      motion.current ??= new Motion(root);
      motion.current.reset();
    }
    if (sized && assetBase) {
      images.current ??= new BoardImages(root, assetBase);
      images.current.reset();
    }
    videos.current?.recount();
    // Motion has taken the board's animations; an agent's new pieces arrive on top.
    arrivals?.replay(root);
  }, [artboard, tokens, assetBase, colorScheme, sized, arrivals, rounded, tracked]);

  // After the content effect, so new content gets its detail at once.
  useLayoutEffect(() => {
    const root = host.current?.shadowRoot;
    if (!root || !motion.current || !detail) return;
    lod.current ??= new BoardDetail(root, motion.current);
    lod.current.update({ ...detail, hold });
    images.current?.update(detail);
    if (detail.hidden !== wasHidden.current) {
      wasHidden.current = detail.hidden;
      videos.current?.recount();
    }
  });

  // Loops hold while nobody can see them move. On the canvas the board's detail holds them, with
  // the rest of what it does (BoardDetail); a preview without detail holds them here. A loop that
  // starts later holds too: a hover's, a video that autoplays once it's loaded, an SVG loop that
  // begins after a delay. Media and SMIL events don't bubble, so capture them.
  useLayoutEffect(() => {
    const root = host.current?.shadowRoot;
    if (!root) return;
    if (!tracked) holdLoops(root, hold, root.getAnimations());
    if (!hold) return;
    // The CSS animations detail tracks are held as it takes them.
    const onStart = () =>
      holdLoops(root, true, tracked ? animationsOf(root) : root.getAnimations());
    if (!tracked) root.addEventListener("animationstart", onStart);
    root.addEventListener("play", onStart, true);
    root.addEventListener("beginEvent", onStart, true);
    return () => {
      root.removeEventListener("animationstart", onStart);
      root.removeEventListener("play", onStart, true);
      root.removeEventListener("beginEvent", onStart, true);
    };
  }, [hold, tracked, artboard, tokens, assetBase, colorScheme]);

  useLayoutEffect(
    () => () => {
      lod.current?.reset();
      motion.current?.dispose();
      images.current?.dispose();
      motion.current = null;
      lod.current = null;
      images.current = null;
      // Mounted again (strict mode), render afresh.
      last.current = "";
    },
    [],
  );

  return <div ref={host} data-artboard-host={artboard.id} style={{ display: "contents" }} />;
}, same);

function same(a: Props, b: Props) {
  return (
    a.artboard === b.artboard &&
    a.tokens === b.tokens &&
    a.assetBase === b.assetBase &&
    a.renditions === b.renditions &&
    a.colorScheme === b.colorScheme &&
    a.arrivals === b.arrivals &&
    a.hold === b.hold &&
    a.rounded === b.rounded &&
    !a.detail === !b.detail &&
    a.detail?.hidden === b.detail?.hidden &&
    a.detail?.scale === b.detail?.scale &&
    a.detail?.moving === b.detail?.moving &&
    a.detail?.visible?.y0 === b.detail?.visible?.y0 &&
    a.detail?.visible?.y1 === b.detail?.visible?.y1
  );
}

/**
 * Inherited properties cross into a shadow root, so without this an artboard
 * would inherit the canvas's own UI text (13px/1.5 Inter, antialiased,
 * no text selection) where a page, and the renderer's pictures of it, start
 * from the browser's defaults. Text then wraps differently, the board grows,
 * and everything below moves at the swap between picture and live DOM.
 * `all` leaves custom properties alone, and the host's inline display wins.
 * The canvas keeps its pointer: boards aren't text to select.
 */
const HOST_RESET =
  ":host{all:initial;cursor:inherit;user-select:inherit;-webkit-user-select:inherit}";

/** Custom properties declared on :root apply to :host inside a shadow root. */
function hostTokens(css: string): string {
  return css.replace(/:root\b/g, ":host");
}
