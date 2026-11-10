/**
 * Cold open: what a board shows before its picture exists. Pictures are made
 * by the server's renderer and cached on disk, so the second open of a design
 * is all pictures; the first can't wait for them (a page of 40 photo boards
 * takes 10+ s to draw). A board cheap enough to render live goes live at
 * once; the rest show a placeholder, the board's own background, until their
 * picture comes. "Cheap" is judged from the artboard's model, before any of
 * it is in the DOM: few elements, no media (each image or video is a fetch,
 * a decode and a texture), and no looping animation (a layer per element).
 */

import type { Artboard, PElement, PNode } from "@ponzu/core";

/** A board is cheap to show live with at most this many elements... */
const CHEAP_ELEMENTS = 1500;
/** ...and at most this many images, videos and CSS background images. */
const CHEAP_MEDIA = 2;
/** Elements cheap boards may add up to on a cold page; past it, placeholders. */
const COLD_LIVE_BUDGET = 20_000;

export interface BoardCost {
  elements: number;
  media: number;
  /** Has an animation that runs forever. */
  loops: boolean;
  cheap: boolean;
}

const costs = new WeakMap<Artboard, BoardCost>();

/** What a board costs to show live, from its model. Cached per artboard object. */
export function boardCost(ab: Artboard): BoardCost {
  const hit = costs.get(ab);
  if (hit) return hit;
  let elements = 0;
  let media = 0;
  let loops = false;
  const walk = (n: PNode, inStyle: boolean) => {
    if (n.kind === "text") {
      if (inStyle) {
        if (/\binfinite\b/.test(n.value)) loops = true;
        media += (n.value.match(/url\(\s*["']?(?!#|data:)/g) ?? []).length;
      }
      return;
    }
    const el = n as PElement;
    elements++;
    const tag = el.tag.toLowerCase();
    if (tag === "img" || tag === "video" || tag === "image" || tag === "picture") media++;
    if (tag === "animate" || tag === "animatetransform" || tag === "animatemotion") {
      if (el.attrs.repeatCount === "indefinite" || el.attrs.repeatcount === "indefinite")
        loops = true;
    }
    const style = Object.entries(el.style);
    for (const [k, v] of style) {
      if (/^animation/.test(k) && /\binfinite\b/.test(v)) loops = true;
      if (/background/.test(k) && /url\(\s*["']?(?!#|data:)/.test(v)) media++;
    }
    for (const c of el.children) walk(c, tag === "style");
  };
  walk(ab.root, false);
  const cost = {
    elements,
    media,
    loops,
    cheap: elements <= CHEAP_ELEMENTS && media <= CHEAP_MEDIA && !loops,
  };
  costs.set(ab, cost);
  return cost;
}

/**
 * Which boards may go live while their picture is missing: cheap ones, in
 * page order, until their elements reach the page budget.
 */
export function coldLive(boards: Artboard[]): Set<string> {
  const out = new Set<string>();
  let spent = 0;
  for (const ab of boards) {
    const c = boardCost(ab);
    if (!c.cheap || spent + c.elements > COLD_LIVE_BUDGET) continue;
    spent += c.elements;
    out.add(ab.id);
  }
  return out;
}

/** The colour a placeholder fills with: the board's own background, or white. */
export function placeholderFill(ab: Artboard): string {
  const s = ab.root.style;
  const bg = s["background-color"] ?? s.background ?? "";
  // A plain colour only: gradients and images are what the picture is for.
  if (/^(#[0-9a-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|[a-z]+)$/i.test(bg.trim())) return bg.trim();
  return "#fff";
}

/** Elements skeletons may add up to on a cold page, after the cheap boards. */
const COLD_SKELETON_BUDGET = 80_000;

/**
 * Boards that aren't cheap but may show as a skeleton while their picture is
 * made: their live DOM with media hidden and animation, transitions and
 * filters off. Text, layout and colour show at once; images and motion come
 * with the picture. Page order, until the element budget is spent.
 */
export function coldSkeleton(boards: Artboard[]): Set<string> {
  const out = new Set<string>();
  let spent = 0;
  for (const ab of boards) {
    const c = boardCost(ab);
    if (c.cheap || spent + c.elements > COLD_SKELETON_BUDGET) continue;
    spent += c.elements;
    out.add(ab.id);
  }
  return out;
}

/**
 * The skeleton's style, added to a board's shadow root. Hidden images still
 * load but never decode or raster; no animation means no layers.
 */
export const SKELETON_CSS = `img,video,image,picture,canvas{visibility:hidden!important}
*,*::before,*::after{animation:none!important;transition:none!important;filter:none!important;backdrop-filter:none!important}`;
