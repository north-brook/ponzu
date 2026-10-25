import { parseSrcset, rewriteCssUrls, rewriteSrcset, type UrlContext } from "@ponzu/core";
import {
  originalUrl,
  RENDITION_WIDTHS,
  renditionStep,
  renditionUrl,
  resizableUrl,
} from "@ponzu/render";
import type { Detail } from "./lod.ts";

/**
 * Images on the canvas load as copies sized to how they're drawn.
 *
 * A design's images are often far bigger than they're shown (a 4000 px photo
 * in a 300 px slot), and a board zoomed out shows them smaller still. Decoded
 * at full size they stall the canvas for seconds and take gigabytes. So each
 * image asks Ponzu's server for a copy (`?w=`, or /api/image for a remote
 * one) one of RENDITION_WIDTHS wide, just above the device pixels it's drawn
 * at. A copy keeps the original's natural size, so it drops in for the
 * original without moving anything.
 *
 * - A board's markup asks for small copies (at most {@link FIRST_MAX} px), so
 *   a page shows at once and fills in.
 * - Once the camera stops, each image on screen drawn bigger than its copy
 *   loads a bigger one, decodes it, and only then swaps it in: never a blank
 *   frame. One drawn much smaller swaps down the same way, freeing memory.
 * - While the camera moves, the copies a stop would want are fetched and
 *   decoded a few times a second, so they're ready when it stops.
 * - It covers `<img>` with its srcset and `<picture>` sources, SVG `<image>`,
 *   inline styles' url() and image-set(), and a board's style sheets (sized
 *   to the board: their rules don't say where they apply).
 * - GIFs keep their originals: swapping one would restart it.
 *
 * Only the canvas does this: screenshots, exports and agents' tools load the
 * originals.
 */

/** The widest copy a board's markup asks for before anything is measured. */
export const FIRST_MAX = 512;

/** A copy is swapped down only once the image is drawn this much smaller than it. */
const DOWN = 1.5;

/**
 * The server sends the original for a copy at least this share of its width
 * (packages/server/src/renditions.ts): asking wider changes nothing.
 */
const ORIGINAL = 0.8;

/** Copies loading ahead at once, canvas-wide. */
const MAX_LOADS = 8;

/** How far past the viewport, as a share of its size, images count as on screen. */
const MARGIN = 0.5;

/** The copy a board's markup asks for first: as wide as the board is drawn, at most {@link FIRST_MAX}. */
export function firstStep(boardWidth: number, scale: number): number {
  return renditionStep(Math.min(boardWidth * scale, FIRST_MAX));
}

/** A URL as a board's markup has it: a copy `step` wide when it's an image that has them. */
export function markupUrl(url: string, assetBase: string, ctx: UrlContext, step: number): string {
  if (!step || !resizable(url, assetBase, ctx)) return url;
  return renditionUrl(url, step, assetBase) ?? url;
}

function resizable(url: string, assetBase: string, ctx?: UrlContext): boolean {
  // A GIF may animate, and swapping copies would restart it.
  if (/\.gif$/i.test(url.replace(/[?#].*$/, ""))) return false;
  // A remote image in CSS stays as written: a background fires no error to fall back on, so one
  // the proxy can't fetch (a dev server, a referrer-locked CDN) would show nothing.
  if (ctx?.attr === "style" && !url.startsWith(`${assetBase.replace(/\/$/, "")}/assets/`))
    return false;
  return resizableUrl(url, assetBase, ctx);
}

/** The copy width a URL asks for, or 0 when it isn't a copy's URL. */
export function copyStep(url: string, assetBase: string): number {
  if (originalUrl(url, assetBase) === url) return 0;
  const w = Number(/[?&]w=(\d+)/.exec(url)?.[1]);
  return (RENDITION_WIDTHS as readonly number[]).includes(w) ? w : 0;
}

/**
 * The copy to show for an image drawn `need` device px wide that's showing
 * `current`: bigger as soon as it's drawn bigger than its copy, smaller only
 * once it's drawn well under it, so a zoom resting near a step doesn't flip it.
 */
export function chooseStep(need: number, current: number): number {
  if (!(need > 0)) return current;
  const up = renditionStep(need);
  if (up > current) return up;
  if (renditionStep(need * DOWN) < current) return up;
  return current;
}

/**
 * Device px across an `<img>`'s content: its box is `w`×`h` device px, its
 * natural size `nw`×`nh` (0 when unknown), `natural` that width in device px.
 * cover and fill can draw it wider than the box; fill stretches each axis on
 * its own, and the more stretched one sets the detail needed.
 */
export function contentWidth(
  w: number,
  h: number,
  nw: number,
  nh: number,
  fit: string,
  natural = Number.POSITIVE_INFINITY,
): number {
  if (!(nw > 0 && nh > 0)) return w;
  const cover = Math.max(w / nw, h / nh) * nw;
  const contain = Math.min(w / nw, h / nh) * nw;
  if (fit === "contain") return contain;
  if (fit === "none") return Number.isFinite(natural) ? natural : cover;
  if (fit === "scale-down") return Math.min(contain, natural);
  return cover;
}

/**
 * Device px across a CSS background image in a box `w`×`h` device px, from
 * the first layer's background-size. `aspect` is the image's width over its
 * height and `natural` its natural width in device px, when known; `k` is
 * device px per CSS px. Infinity when only the image's own size would say.
 */
export function backgroundWidth(
  w: number,
  h: number,
  size: string,
  aspect?: number,
  natural?: number,
  k = 1,
): number {
  const [a = "auto", b = "auto"] = (size.split(",")[0] ?? "").trim().split(/\s+/);
  const len = (v: string, of: number) =>
    v.endsWith("%")
      ? (Number.parseFloat(v) / 100) * of
      : v.endsWith("px")
        ? Number.parseFloat(v) * k
        : Number.NaN;
  if (a === "cover") return aspect ? Math.max(w, h * aspect) : Number.POSITIVE_INFINITY;
  if (a === "contain") return aspect ? Math.min(w, h * aspect) : w;
  const x = len(a, w);
  if (Number.isFinite(x)) return x;
  const y = len(b, h);
  if (Number.isFinite(y) && aspect) return y * aspect;
  return natural ?? Number.POSITIVE_INFINITY;
}

type Target = (
  | {
      kind: "img";
      el: HTMLImageElement;
      /** Original URLs: src, srcset, and the srcsets of its <picture>'s sources. */
      src?: string;
      srcset?: string;
      sources: { el: Element; srcset: string }[];
      fit?: string;
      step: number;
      want?: number;
    }
  | { kind: "svg"; el: SVGImageElement; attr: string; url: string; step: number; want?: number }
  | {
      kind: "style";
      el: HTMLElement | SVGElement;
      style: string;
      urls: string[];
      size?: string;
      step: number;
      want?: number;
    }
  | {
      kind: "sheet";
      el: HTMLStyleElement;
      text: string;
      urls: string[];
      step: number;
      want?: number;
    }
) & {
  /** A copy wouldn't load: it keeps its original from then on. */
  failed?: boolean;
};

/** Natural sizes of originals, learned from the copies loaded so far. */
const naturals = new Map<string, { w: number; h: number }>();

/**
 * Sizes one artboard's images to how they're drawn. `reset` after replacing
 * the board's content, `update` when how it's drawn changes.
 */
export class BoardImages {
  private targets: Target[] = [];
  /** Copy widths swapped in, by original URL: an edit's new markup starts from them. */
  private steps = new Map<string, number>();
  private detail: Detail | null = null;
  private generation = 0;
  private recheck = 0;
  private readonly onLoad = () => this.soon();
  /** A copy that won't load (no such host, or the server can't make it): back to the original. */
  private readonly onError = (e: Event) => {
    const el = e.target;
    const t = this.targets.find(
      (x) => x.el === el || (x.kind === "img" && x.sources.some((s) => s.el === el)),
    );
    if (t && t.step) {
      this.apply(t, 0);
      t.step = 0;
      t.failed = true;
    }
  };

  constructor(
    private root: ShadowRoot,
    private assetBase: string,
  ) {
    // An image's natural size comes with it, and can change what it needs.
    root.addEventListener("load", this.onLoad, true);
    root.addEventListener("error", this.onError, true);
  }

  /** The copy width last swapped in for an original URL, for markup made again. */
  stepFor(original: string): number | undefined {
    return this.steps.get(original);
  }

  /** The content was replaced: find its images again. */
  reset() {
    this.generation++;
    this.targets = [];
    const base = this.assetBase;
    const orig = (u: string) => originalUrl(u, base);
    const stepOf = (urls: (string | undefined)[]) => {
      let step = 0;
      for (const u of urls) if (u) step = Math.max(step, copyStep(u, base));
      return step;
    };
    for (const el of this.root.querySelectorAll<HTMLElement | SVGElement>("*")) {
      const tag = el.localName;
      if (tag === "img") {
        const img = el as HTMLImageElement;
        const src = img.getAttribute("src") ?? undefined;
        const srcset = img.getAttribute("srcset") ?? undefined;
        const sources =
          img.parentElement?.localName === "picture"
            ? [...img.parentElement.children]
                .filter((s) => s.localName === "source" && s.hasAttribute("srcset"))
                .map((s) => ({ el: s, srcset: s.getAttribute("srcset")! }))
            : [];
        const step = stepOf([
          src,
          ...srcsetUrls(srcset),
          ...sources.flatMap((s) => srcsetUrls(s.srcset)),
        ]);
        if (step)
          this.targets.push({
            kind: "img",
            el: img,
            src: src && orig(src),
            srcset: srcset && rewriteSrcset(srcset, orig),
            sources: sources.map((s) => ({ el: s.el, srcset: rewriteSrcset(s.srcset, orig) })),
            step,
          });
      } else if (tag === "image" && el instanceof SVGElement) {
        const attr = el.hasAttribute("href") ? "href" : "xlink:href";
        const url = el.getAttribute(attr) ?? "";
        const step = copyStep(url, base);
        if (step)
          this.targets.push({ kind: "svg", el: el as SVGImageElement, attr, url: orig(url), step });
      } else if (tag === "style") {
        const text = el.textContent ?? "";
        const step = stepOf(cssUrls(text));
        if (step) {
          const original = rewriteCssUrls(text, orig);
          this.targets.push({
            kind: "sheet",
            el: el as HTMLStyleElement,
            text: original,
            urls: cssUrls(original),
            step,
          });
        }
      }
      const style = el.getAttribute("style");
      if (style && /url\(|image-set\(/i.test(style)) {
        const step = stepOf(cssUrls(style));
        if (step) {
          const original = rewriteCssUrls(style, orig);
          this.targets.push({ kind: "style", el, style: original, urls: cssUrls(original), step });
        }
      }
    }
    const d = this.detail;
    if (d && !d.moving && !d.hidden) this.soon();
  }

  update(detail: Detail) {
    const was = this.detail;
    this.detail = detail;
    if (detail.hidden || !this.targets.length) {
      moving.delete(this);
      return;
    }
    if (detail.moving) {
      // Nothing per frame: a ticker looks ahead a few times a second.
      moving.add(this);
      ensureTicker();
      return;
    }
    moving.delete(this);
    if (was && !was.moving && !was.hidden && was.scale === detail.scale) return;
    this.size(false);
  }

  /** Size every image on screen; `ahead` (mid-gesture) only loads bigger copies, without swapping. */
  size(ahead: boolean) {
    const view = viewBox();
    const board = this.root.querySelector("[data-artboard]");
    if (!board || !intersects(board.getBoundingClientRect(), view)) return;
    const dpr = window.devicePixelRatio || 1;
    const gen = this.generation;
    for (const t of this.targets) {
      if (!t.el.isConnected || t.failed) continue;
      // A <style> has no box: its images are sized by the board's.
      const r = (t.kind === "sheet" ? board : t.el).getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0) || !intersects(r, view)) continue;
      const need = this.need(t, r, dpr);
      if (need === null) continue;
      const want = chooseStep(need, t.step);
      // Already the original (the server sends it for a copy about as big, or one
      // that's animated): a new URL would load it again and restart an animation.
      const ow = this.originalWidth(t);
      if (ow && want > t.step && t.step >= ow * ORIGINAL) continue;
      // Smaller copies wait for a stop: mid-gesture they could be wasted.
      if (want === t.step || want === t.want || (ahead && want < t.step)) continue;
      t.want = want;
      const urls = this.urlsFor(t, want);
      void Promise.all(urls.map((u) => preload(u, originalUrl(u, this.assetBase)))).then((ok) => {
        if (gen !== this.generation || t.want !== want) return;
        t.want = undefined;
        // Swapped only at rest: a stop sizes again and finds it loaded.
        if (ok.every(Boolean) && !this.detail?.moving) this.apply(t, want);
      });
    }
  }

  /** Device px the target's image needs across, or null when it can't tell yet. */
  private need(t: Target, r: DOMRect, dpr: number): number | null {
    const w = r.width * dpr;
    const h = r.height * dpr;
    if (t.kind === "img") {
      const img = t.el;
      // Not in yet: what it needs depends on its natural size, which comes with it.
      if (!img.complete || !img.naturalWidth) return null;
      t.fit ??= getComputedStyle(img).objectFit;
      const k = img.offsetWidth ? r.width / img.offsetWidth : 1;
      return contentWidth(
        w,
        h,
        img.naturalWidth,
        img.naturalHeight,
        t.fit,
        img.naturalWidth * k * dpr,
      );
    }
    if (t.kind === "svg") {
      const n = naturals.get(t.url);
      const slice = /slice/.test(t.el.getAttribute("preserveAspectRatio") ?? "");
      if (!slice) return w;
      if (n) return Math.max(w, h * (n.w / n.h));
      void this.learn(t);
      return null;
    }
    if (t.kind === "style") {
      const el = t.el as HTMLElement;
      t.size ??= getComputedStyle(el).backgroundSize || "auto";
      const n = naturals.get(t.urls[0] ?? "");
      const k = el.offsetWidth ? r.width / el.offsetWidth : 1;
      const out = backgroundWidth(w, h, t.size, n && n.w / n.h, n && n.w * k * dpr, k * dpr);
      if (Number.isFinite(out)) return out;
      // Its own size decides: learn it from the copy it shows, then size again.
      if (!n) void this.learn(t);
      return null;
    }
    // A style sheet's images: as wide as the board, whose box `r` is.
    return w;
  }

  /** The copies a target shows at `step`: what to load ahead. */
  private urlsFor(t: Target, step: number): string[] {
    const at = (u: string) =>
      markupUrl(u, this.assetBase, { tag: t.el.localName, attr: "src" }, step);
    if (t.kind === "img") {
      // The candidate the browser picked, at the new width.
      const current = t.el.currentSrc;
      const chosen = current ? originalUrl(current, this.assetBase) : t.src;
      return chosen ? [at(chosen)] : [];
    }
    if (t.kind === "svg") return [at(t.url)];
    return t.urls.map(at);
  }

  private apply(t: Target, step: number) {
    t.step = step;
    for (const u of originals(t)) this.steps.set(u, step);
    const base = this.assetBase;
    const at = (attr: string) => (u: string) =>
      markupUrl(u, base, { tag: t.el.localName, attr }, step);
    if (t.kind === "img") {
      // Sources first: the img picks again when its own attributes change.
      for (const s of t.sources) s.el.setAttribute("srcset", rewriteSrcset(s.srcset, at("srcset")));
      if (t.srcset !== undefined)
        t.el.setAttribute("srcset", rewriteSrcset(t.srcset, at("srcset")));
      if (t.src !== undefined) t.el.setAttribute("src", at("src")(t.src));
    } else if (t.kind === "svg") t.el.setAttribute(t.attr, at(t.attr)(t.url));
    else if (t.kind === "style") t.el.setAttribute("style", rewriteCssUrls(t.style, at("style")));
    else t.el.textContent = rewriteCssUrls(t.text, at("style"));
  }

  /** The original's width, when known: learned from a copy, or what a lone src shows. */
  private originalWidth(t: Target): number | undefined {
    if (t.kind === "img") {
      const chosen = t.el.currentSrc ? originalUrl(t.el.currentSrc, this.assetBase) : t.src;
      const n = chosen ? naturals.get(chosen) : undefined;
      if (n) return n.w;
      // Without a srcset, its natural size is the original's (a copy carries it).
      return !t.srcset && !t.sources.length ? t.el.naturalWidth || undefined : undefined;
    }
    if (t.kind === "svg") return naturals.get(t.url)?.w;
    if (t.kind === "style") return naturals.get(t.urls[0] ?? "")?.w;
    return undefined;
  }

  /** Load the copy an SVG image or background shows, to learn its natural size. */
  private async learn(t: Target) {
    const url = t.kind === "style" ? t.urls[0] : t.kind === "svg" ? t.url : undefined;
    if (!url || naturals.has(url) || learning.has(url)) return;
    learning.add(url);
    await preload(
      markupUrl(url, this.assetBase, { tag: t.el.localName, attr: "src" }, t.step),
      url,
    );
    this.soon();
  }

  /** Size again shortly, once a burst of loads is over. */
  private soon() {
    if (this.recheck) return;
    this.recheck = window.setTimeout(() => {
      this.recheck = 0;
      const d = this.detail;
      if (d && !d.moving && !d.hidden) this.size(false);
    }, 120);
  }

  dispose() {
    this.generation++;
    moving.delete(this);
    clearTimeout(this.recheck);
    this.root.removeEventListener("load", this.onLoad, true);
    this.root.removeEventListener("error", this.onError, true);
  }
}

function originals(t: Target): string[] {
  if (t.kind === "img")
    return [
      t.src,
      ...srcsetUrls(t.srcset),
      ...t.sources.flatMap((s) => srcsetUrls(s.srcset)),
    ].filter((u): u is string => !!u);
  if (t.kind === "svg") return [t.url];
  return t.urls;
}

function srcsetUrls(srcset: string | undefined): string[] {
  return srcset ? parseSrcset(srcset).map((c) => c.url) : [];
}

function cssUrls(css: string): string[] {
  const out = new Set<string>();
  rewriteCssUrls(css, (u) => {
    out.add(u);
    return u;
  });
  return [...out];
}

function viewBox() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  return { x0: -w * MARGIN, y0: -h * MARGIN, x1: w * (1 + MARGIN), y1: h * (1 + MARGIN) };
}

function intersects(r: DOMRect, v: ReturnType<typeof viewBox>) {
  return r.right > v.x0 && r.left < v.x1 && r.bottom > v.y0 && r.top < v.y1;
}

/** Boards whose camera is moving; the ticker loads ahead for them. */
const moving = new Set<BoardImages>();
let ticker = 0;

function ensureTicker() {
  if (ticker) return;
  ticker = window.setInterval(() => {
    if (!moving.size) {
      clearInterval(ticker);
      ticker = 0;
      return;
    }
    for (const b of moving) b.size(true);
  }, 200);
}

/** Copies loading or loaded, by URL: true once decoded. */
const loads = new Map<string, Promise<boolean>>();
/** Background images being loaded to learn their size. */
const learning = new Set<string>();
let active = 0;
const queue: (() => void)[] = [];

/**
 * Fetch and decode a copy ahead of showing it. True once it's ready to draw.
 * `original` is the URL its natural size is remembered under.
 */
function preload(url: string, original: string): Promise<boolean> {
  let p = loads.get(url);
  if (p) return p;
  p = (async () => {
    if (active >= MAX_LOADS) await new Promise<void>((r) => queue.push(r));
    active++;
    try {
      const img = new Image();
      img.decoding = "async";
      img.src = url;
      await img.decode();
      if (img.naturalWidth) naturals.set(original, { w: img.naturalWidth, h: img.naturalHeight });
      return true;
    } catch {
      return false;
    } finally {
      active--;
      queue.shift()?.();
    }
  })();
  loads.set(url, p);
  if (loads.size > 4000) loads.delete(loads.keys().next().value!);
  return p;
}
