/**
 * Level of detail inside a board: do less work for what the person can't
 * really see. snapshot.tsx decides whether a board renders at all; this
 * works within it, from the animations motion.ts keeps track of, so it never
 * asks the document for all of them mid-gesture.
 *
 * - A board that doesn't render (away or a picture) still runs its videos
 *   and its fields' images: they pause here, and go on in phase after.
 * - An animated element drawn smaller than {@link STILL_PX} device pixels
 *   stops animating: it shows its un-animated style, not a frozen frame.
 *   Pausing an animation keeps its composited layer, so it gets `animation:
 *   none` instead, through an attribute and one rule per board, and comes
 *   back at the phase it would have reached by then. Fields (SVGs drawn as an
 *   image of themselves) keep moving at any size: the image costs no layers.
 * - While the camera moves, every animation in a busy board stops the same
 *   way: with thousands of animated layers, Chromium re-layerizes all of them
 *   on every camera frame. Fields show their image.
 * - A tall board's top-level sections outside the visible band skip
 *   rendering.
 * - While nobody can see the board move (off screen, a thumbnail, mid-gesture,
 *   the window away: `hold`), its loops hold where they are (holdLoops).
 */

import { isCSSAnimation, type Motion, nameOf, STILL_PX } from "./motion.ts";

/** A held element goes again from this size: a zoom hovering at the line doesn't flip it. */
const RELEASE = STILL_PX / 0.8;

/**
 * Only a board with at least this many animations outside fields holds them
 * still while the camera moves. A few cost little, and a spinner that stops
 * whenever you scroll would look broken.
 */
const BUSY = 64;

/** Held elements let go per frame once the camera stops. */
const RELEASE_PER_FRAME = 400;

/** How far past the viewport, as a share of its size, boards keep rendering. */
const CULL_MARGIN = 0.5;

/** Marks an element whose animations are held still. */
const STILL = "data-pz-still";

/** Goes in every artboard's shadow root. */
export const STILL_CSS = `[${STILL}],[${STILL}]::before,[${STILL}]::after{animation:none!important}`;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** How far a world-space rect is from the viewport's centre, in screen px (0 when it covers it). */
export function centreDistance(
  r: Rect,
  cam: { x: number; y: number; zoom: number },
  vp: { w: number; h: number },
): number {
  const cx = (vp.w / 2 - cam.x) / cam.zoom;
  const cy = (vp.h / 2 - cam.y) / cam.zoom;
  const dx = Math.max(r.x - cx, 0, cx - r.x - r.w);
  const dy = Math.max(r.y - cy, 0, cy - r.y - r.h);
  return Math.hypot(dx, dy) * cam.zoom;
}

/** Whether a world-space rect is within the viewport, grown by `margin` of its size. */
export function onScreen(
  r: Rect,
  cam: { x: number; y: number; zoom: number },
  vp: { w: number; h: number },
  margin = CULL_MARGIN,
): boolean {
  const mx = vp.w * margin;
  const my = vp.h * margin;
  const x0 = r.x * cam.zoom + cam.x;
  const y0 = r.y * cam.zoom + cam.y;
  return (
    x0 + r.w * cam.zoom >= -mx && y0 + r.h * cam.zoom >= -my && x0 <= vp.w + mx && y0 <= vp.h + my
  );
}

/**
 * Device pixels per artboard pixel, in quarter-octave steps so a zoom gesture
 * only re-checks animations a few times per doubling.
 */
export function detailScale(zoom: number, dpr: number): number {
  return 2 ** (Math.round(Math.log2(zoom * dpr) * 4) / 4);
}

export interface Detail {
  /** The board's DOM isn't rendered: it's away, or a picture shows instead. */
  hidden: boolean;
  /** Device pixels per artboard pixel. */
  scale: number;
  /** The camera is mid-gesture. */
  moving: boolean;
  /**
   * The part of the board within the viewport and its margin, in artboard px,
   * rounded out to {@link BAND} so a pan doesn't change it every frame.
   */
  visible?: { y0: number; y1: number };
  /** Nobody can see it move: its loops hold where they are (holdLoops). */
  hold?: boolean;
}

/** Visible bands snap to this many artboard px. */
export const BAND = 512;

/** A board taller than this many viewports culls its sections one by one. */
const TALL = 1.5;

/** The part of a board within the viewport and its margin, in artboard px, or undefined when it's short. */
export function visibleBand(
  r: Rect,
  cam: { x: number; y: number; zoom: number },
  vp: { w: number; h: number },
  margin = CULL_MARGIN,
): { y0: number; y1: number } | undefined {
  if (r.h * cam.zoom < vp.h * (1 + 2 * margin) * TALL) return undefined;
  const my = vp.h * margin;
  const top = (-my - cam.y) / cam.zoom - r.y;
  const bottom = (vp.h + my - cam.y) / cam.zoom - r.y;
  return { y0: Math.floor(top / BAND) * BAND, y1: Math.ceil(bottom / BAND) * BAND };
}

type Phase = { start: number | null; current: number | null };

/**
 * Holds one shadow root's animations and videos still or lets them run as its
 * board's detail changes. `reset` after replacing the root's content.
 */
export class BoardDetail {
  /** Held elements, and their animations' phases by pseudo-element and name. */
  private still = new Map<Element, Map<string, Phase>>();
  /** Largest side in artboard px. */
  private sizes = new WeakMap<Element, number>();
  private videos = new Map<HTMLVideoElement, { at: number; time: number }>();
  /** Sections of a tall board that skip rendering. */
  private culled = new Set<HTMLElement>();
  /** Artboard px per CSS px on screen, for the current update. */
  private k = 0;
  /** Held elements waiting their turn to go. */
  private releasing = new Map<Element, Map<string, Phase>>();
  private frame = 0;
  private last: Detail | null = null;
  /** Its loops are held (holdLoops). */
  private held = false;

  constructor(
    private root: ShadowRoot,
    private motion: Motion,
  ) {
    // Animations that start later (a section or board coming back) get their detail too.
    motion.onStart = () => this.last && this.update(this.last);
  }

  /** The content was replaced: what was held is gone. */
  reset() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.releasing.clear();
    this.still.clear();
    this.sizes = new WeakMap();
    this.culled.clear();
    this.videos.clear();
    this.held = false;
  }

  update(d: Detail) {
    this.last = d;
    this.motion.calm(d.moving);
    this.motion.sleep(d.hidden);
    this.videos_(d.hidden);
    // Skipped content has no layers or ticks to save, and measuring it would lay it out.
    if (d.hidden) return;
    // Every update while held: animations that started since (motion's onStart) hold too.
    if (d.hold || this.held) holdLoops(this.root, !!d.hold, this.motion.running);
    // Fields' loops run in their images, which holdLoops can't reach.
    this.motion.hold(!!d.hold);
    this.held = !!d.hold;
    const section = this.root.querySelector<HTMLElement>("[data-artboard]");
    if (!section) return;
    this.cull(section, d.visible);
    this.k = 0;
    const k = () => (this.k ||= section.offsetWidth / (section.getBoundingClientRect().width || 1));
    const small = (t: Element, below = STILL_PX) => {
      let s = this.sizes.get(t);
      if (s === undefined) {
        const r = t.getBoundingClientRect();
        s = Math.max(r.width, r.height) * k();
        this.sizes.set(t, s);
      }
      return s * d.scale < below;
    };

    // Held ones count too: they're what would be running.
    let count = 0;
    for (const m of this.still.values()) count += m.size;
    for (const m of this.releasing.values()) count += m.size;
    for (const a of this.motion.running) if (a.playState !== "idle") count++;
    const freeze = d.moving && count >= BUSY;
    const hold = new Map<Element, Map<string, Phase>>();
    for (const a of this.motion.running) {
      const t = (a.effect as KeyframeEffect).target;
      if (!t || a.playState === "idle" || this.still.has(t) || this.releasing.has(t)) continue;
      // Too small to see stops anywhere; mid-gesture, everything in a busy board does.
      if (!freeze && !small(t)) continue;
      const m = hold.get(t) ?? new Map<string, Phase>();
      hold.set(t, m);
      m.set(nameOf(a), phase(a));
    }
    for (const [t, m] of hold) {
      t.setAttribute(STILL, "");
      this.still.set(t, m);
    }
    if (freeze) {
      // Moving again before they've all gone: hold the rest where they are.
      for (const [t, m] of this.releasing) this.still.set(t, m);
      this.releasing.clear();
      return;
    }

    // Let go of what's big enough to see now.
    const back = new Map<Element, Map<string, Phase>>();
    for (const [t, m] of this.still) {
      if (!t.isConnected) this.still.delete(t);
      else if (!small(t, RELEASE)) back.set(t, m);
    }
    for (const t of back.keys()) this.still.delete(t);
    this.release(back);
  }

  /**
   * Let held elements go a few hundred a frame: each running animation is a
   * layer to make again, and thousands at once is a long frame.
   */
  private release(back: Map<Element, Map<string, Phase>>) {
    if (!back.size) return;
    for (const [t, m] of back) this.releasing.set(t, m);
    if (this.frame) return;
    const step = () => {
      this.frame = 0;
      const now = new Map<Element, Map<string, Phase>>();
      for (const [t, m] of this.releasing) {
        if (now.size >= RELEASE_PER_FRAME) break;
        now.set(t, m);
        this.releasing.delete(t);
        t.removeAttribute(STILL);
      }
      // They restart as new animations: put each where it would be had it never stopped,
      // and hand them to motion now so their start events don't send it looking. One ask
      // for the root's: each element's would walk every animation in the document again.
      const back: CSSAnimation[] = [];
      for (const a of this.root.getAnimations()) {
        if (!isCSSAnimation(a)) continue;
        const effect = a.effect as KeyframeEffect;
        const was = effect.target && now.get(effect.target)?.get(nameOf(a));
        if (!was) continue;
        if (was.start !== null) a.startTime = was.start;
        else if (was.current !== null) a.currentTime = was.current;
        back.push(a);
      }
      this.motion.track(back);
      if (this.held) holdLoops(this.root, true, back);
      if (this.releasing.size) this.frame = requestAnimationFrame(step);
    };
    step();
  }

  /**
   * In a tall board, top-level sections outside the visible band skip
   * rendering, holding their size so nothing below them moves. A skipped
   * section still lays out when asked, so the board's fit-content height,
   * pins and outlines stay right.
   */
  private cull(section: HTMLElement, band: Detail["visible"]) {
    for (const c of section.children) {
      if (!(c instanceof HTMLElement || c instanceof SVGElement) || c.localName === "style")
        continue;
      const el = c as HTMLElement;
      const hidden = this.culled.has(el);
      let out = false;
      if (band) {
        // offsetTop and offsetHeight read the last layout, which a skipped section keeps.
        const top = el.offsetTop;
        out = top + el.offsetHeight < band.y0 || top > band.y1;
      }
      if (out === hidden) continue;
      if (out) {
        // Its own size, so the layout around it doesn't change while it's skipped. The
        // intrinsic size is the content box's: padding and borders still add to it.
        // From the computed (used, unrounded) size: offsetHeight rounds, and over a few dozen
        // skipped sections that moves everything below by several px.
        const cs = getComputedStyle(el);
        const px = (p: string) => Number.parseFloat(cs.getPropertyValue(p)) || 0;
        const border = cs.boxSizing === "border-box";
        const w =
          px("width") -
          (border
            ? px("padding-left") +
              px("padding-right") +
              px("border-left-width") +
              px("border-right-width")
            : 0);
        const h =
          px("height") -
          (border
            ? px("padding-top") +
              px("padding-bottom") +
              px("border-top-width") +
              px("border-bottom-width")
            : 0);
        el.style.setProperty("contain-intrinsic-size", `${Math.max(0, w)}px ${Math.max(0, h)}px`);
        el.style.setProperty("content-visibility", "hidden");
        this.culled.add(el);
      } else {
        el.style.removeProperty("content-visibility");
        el.style.removeProperty("contain-intrinsic-size");
        this.culled.delete(el);
      }
    }
  }

  /** Not rendered, videos pause; rendered again, they go on from where they'd be by now. */
  private videos_(hidden: boolean) {
    if (hidden) {
      for (const v of this.root.querySelectorAll("video")) {
        if (v.paused || this.videos.has(v)) continue;
        this.videos.set(v, { at: performance.now(), time: v.currentTime });
        v.pause();
      }
      return;
    }
    for (const [v, s] of this.videos) {
      this.videos.delete(v);
      if (!v.isConnected) continue;
      const len = v.duration;
      if (v.loop && Number.isFinite(len) && len > 0)
        v.currentTime = (s.time + (performance.now() - s.at) / 1000) % len;
      v.play().catch(() => {});
    }
  }
}

/**
 * Where an animation is: its start on the timeline while it plays, so it can
 * come back where it would be by then; how far in it is while paused. One
 * that's about to start (just rendered) starts now.
 */
function phase(a: Animation): Phase {
  // A held loop (playbackRate 0) has no start time to come back to: it's where it stopped.
  if (a.playState === "paused" || a.playbackRate === 0)
    return { start: null, current: a.currentTime as number | null };
  const start = (a.startTime as number | null) ?? (document.timeline.currentTime as number | null);
  return { start, current: null };
}

/**
 * Stop or restart a board's infinite animations where they stand. Each loop redraws its board
 * every frame, and a page of them, under backdrop blurs, kept a MacBook Air's GPU busy all
 * afternoon. One-off entrances play out, so a board that's held still shows its settled page.
 * The rate, not pause(): pausing from script overrides the design's own animation-play-state
 * from then on, and a loop meant to run on :hover would stop answering it. `anims` are the
 * board's CSS animations: on the canvas, the ones motion.ts tracks, so a hold never asks the
 * document for all of them.
 */
export function holdLoops(root: ShadowRoot, hold: boolean, anims: Iterable<Animation>) {
  const rate = hold ? 0 : 1;
  for (const a of anims) {
    if (a.playbackRate !== rate && a.effect?.getTiming().iterations === Number.POSITIVE_INFINITY)
      a.playbackRate = rate;
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

/** Whether a SMIL animation is playing now. One waiting on a click or a time holds when it begins. */
function smilActive(el: SVGAnimationElement): boolean {
  try {
    return el.getStartTime() <= el.getCurrentTime();
  } catch {
    return false;
  }
}
