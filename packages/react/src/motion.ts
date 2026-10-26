/**
 * Keeps a design's CSS animations cheap to show on the canvas without
 * changing what they look like, and keeps the list of them that the level of
 * detail (lod.ts) works from.
 *
 * Chromium gives every element with a running transform or opacity animation
 * its own composited layer. A grid of a few thousand animated SVG slices
 * becomes thousands of layers, and transform animations on `<use x y>` can't
 * even run on the compositor (crbug.com/1134775), so they tick on the main
 * thread and re-layerize the whole page every frame. Three things fix that:
 *
 * - **Fields**: an `<svg>` with many animated descendants is drawn as an SVG
 *   image of itself. Its animations run inside the image document, which
 *   never adds a layer to the page. The live elements stay in place, hidden
 *   and not animating, so layout, pins and selection boxes still measure them.
 *   Pointing at the field brings the live elements back, in phase, so hover
 *   effects and hit-testing work, unless they're too small to see or the
 *   camera is moving. Leaving it hands back to the image.
 * - **Paint-only animations** (`stroke-dashoffset`, `clip-path`, colors) get a
 *   layer of their own, so each frame re-rasters a small layer, not the board.
 * - **Finished animations** that hold their last frame (`fill: both`) let go
 *   once they end, when that frame is what the element looks like anyway.
 *
 * Asking for a root's animations walks and sorts every animation in the
 * document, even for one element: a couple of hundred ms with a few thousand
 * running. So the list is taken once per render and kept current from the
 * root's animation events, asking again only for animations it hasn't seen.
 */

/** An animated element drawn smaller than this, in device pixels, isn't worth animating live. */
export const STILL_PX = 8;

const FIELD_MIN = 48;
/** Up to this many elements starting animations in a frame are asked one by one. */
const FEW_STARTS = 8;
const COMPOSITED = new Set([
  "transform",
  "opacity",
  "filter",
  "rotate",
  "scale",
  "translate",
  "backdropFilter",
]);
const NOT_PROPERTIES = new Set(["offset", "easing", "composite", "computedOffset"]);
const SVG_NS = "http://www.w3.org/2000/svg";
const BACK_TO_IMAGE_MS = 1200;
const INHERITED = [
  "color",
  "fill",
  "fill-opacity",
  "stroke",
  "stroke-opacity",
  "stroke-width",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
];

/** Goes in every artboard's shadow root. */
export const MOTION_CSS = `
[data-pz-field] > :not([data-pz-image]) { visibility: hidden !important; }
[data-pz-field] :not([data-pz-image]) { animation: none !important; transition: none !important; }
:not([data-pz-field]) > [data-pz-image] { display: none; }
[data-pz-layer] { will-change: opacity; }
`;

interface Field {
  /** Show the image, and keep it up until `wake`. */
  still(): void;
  /** Go live again if the pointer is on it. */
  wake(): void;
  /** Stop the image's animations while the board isn't rendered, or start them again. */
  sleep(on: boolean): void;
  /** Hold the image's animations where they are while nobody can see them move, or go on. */
  hold(on: boolean): void;
  stop(): void;
  /** The board's time the image shows now, in ms, or null before it has loaded. */
  time(): number | null;
  /** Load the image again showing board time `t` as it appears. Resolves once it shows. */
  phase(t: number): Promise<void>;
}

/** A field's clock, for loops.tsx to hand off to and from its videos in phase. */
export interface FieldClock {
  time(): number | null;
  phase(t: number): Promise<void>;
}

/** One artboard shadow root's animations. `reset` after replacing its content. */
export class Motion {
  /** Running CSS animations, except those inside fields: those run in the image. */
  readonly running = new Set<CSSAnimation>();
  /** Called after animations that weren't running start. */
  onStart?: () => void;
  /** Running animations by target, pseudo-element and name, to tell a new start from a known one. */
  private names = new WeakMap<Element, Map<string, CSSAnimation>>();
  private fields = new Map<SVGSVGElement, Field>();
  /** SVGs looked at that don't become fields. */
  private plain = new WeakSet<SVGSVGElement>();
  /** Fill-forwards animations already set to let go when done. */
  private settling = new WeakSet<Animation>();
  /** Elements whose animations started untracked since the last frame. */
  private started = new Set<Element>();
  /** A ::before or ::after animation started untracked. */
  private pseudo = false;
  private ended = false;
  private frame = 0;
  private calmed = false;
  private asleep = false;
  private held = false;
  /** Its animations were made and taken while the board was hidden (warm). */
  private warmed = false;

  /**
   * Removing an element cancels its animations, but their events fire on the
   * detached element and never reach the root: removals are watched instead.
   */
  private removals = new MutationObserver((records) => {
    if (records.some((r) => r.removedNodes.length)) this.onEvent(new Event("animationcancel"));
  });

  constructor(private root: ShadowRoot) {
    root.addEventListener("animationstart", this.onEvent);
    root.addEventListener("animationend", this.onEvent);
    root.addEventListener("animationcancel", this.onEvent);
    this.removals.observe(root, { childList: true, subtree: true });
    motions.set(root, this);
  }

  /** The content was replaced: start over from what it runs now. */
  reset() {
    this.clear();
    const all = this.root.getAnimations().filter(isCSSAnimation);
    this.take(all, all);
  }

  dispose() {
    this.clear();
    this.removals.disconnect();
    this.root.removeEventListener("animationstart", this.onEvent);
    this.root.removeEventListener("animationend", this.onEvent);
    this.root.removeEventListener("animationcancel", this.onEvent);
  }

  /**
   * Make and take the board's animations now, while it's hidden and nobody's
   * waiting. A board that mounts under `content-visibility: hidden` (a
   * picture) never computes its style, so it has no animations until it first
   * shows; then they all start at once, and finding them, and drawing its big
   * SVGs as images (fields), costs a long frame just as the person looks at
   * it. Call with the board rendering for the one synchronous call (as for
   * hit-testing): no frame shows it. Once per content.
   */
  warm() {
    if (this.warmed) return;
    this.warmed = true;
    // Styles the subtree, which makes its animations.
    void (this.root.querySelector("[data-artboard]") as HTMLElement | null)?.offsetHeight;
    const all = this.root.getAnimations().filter(isCSSAnimation);
    this.take(
      all.filter((a) => !this.running.has(a)),
      all,
    );
  }

  /** The fields that hold any of these elements (by data-id). */
  fieldsOf(ids: Iterable<string>): FieldClock[] {
    const out = new Set<Field>();
    for (const id of ids) {
      const el = this.root.querySelector(`[data-id="${CSS.escape(id)}"]`);
      const svg = el instanceof SVGElement ? outermostSvg(el) : null;
      const f = svg && this.fields.get(svg);
      if (f) out.add(f);
    }
    return [...out];
  }

  /** Animations restarted by the caller: tracked now, so their start events don't send us looking. */
  track(anims: CSSAnimation[]) {
    this.take(anims);
  }

  /** While the camera moves, fields show their image: one layer, still in motion. */
  calm(on: boolean) {
    if (on === this.calmed) return;
    this.calmed = on;
    for (const f of this.fields.values()) on ? f.still() : f.wake();
  }

  /** While the board isn't rendered, fields' images stop too. */
  sleep(on: boolean) {
    if (on === this.asleep) return;
    this.asleep = on;
    for (const f of this.fields.values()) f.sleep(on);
  }

  /** While its loops hold (lod.ts holdLoops), fields' images hold where they are too. */
  hold(on: boolean) {
    if (on === this.held) return;
    this.held = on;
    for (const f of this.fields.values()) f.hold(on);
  }

  private clear() {
    this.warmed = false;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    for (const f of this.fields.values()) f.stop();
    this.fields.clear();
    this.plain = new WeakSet();
    this.running.clear();
    this.names = new WeakMap();
    this.started.clear();
    this.pseudo = false;
    this.ended = false;
  }

  private inField(el: Element): boolean {
    const svg = el instanceof SVGElement ? outermostSvg(el) : null;
    return !!svg && this.fields.has(svg);
  }

  private onEvent = (e: Event) => {
    const ev = e as AnimationEvent;
    if (ev.type !== "animationstart") this.ended = true;
    else {
      const t = ev.target as Element;
      const known = this.names.get(t)?.get(key(ev.pseudoElement, ev.animationName));
      // One we track (not one that stopped and started again since), or a field's live copy.
      if ((known && known.playState !== "idle") || this.inField(t)) return;
      if (ev.pseudoElement) this.pseudo = true;
      else this.started.add(t);
    }
    this.frame ||= requestAnimationFrame(this.flush);
  };

  /** Once a frame at most: drop what stopped, take what started. */
  private flush = () => {
    this.frame = 0;
    if (this.ended) {
      this.ended = false;
      for (const a of this.running) {
        if (a.playState !== "idle" && a.playState !== "finished") continue;
        this.running.delete(a);
        const names = this.names.get(targetOf(a)!);
        if (names?.get(nameOf(a)) === a) names.delete(nameOf(a));
      }
    }
    if (!this.started.size && !this.pseudo) return;
    // Asking an element or the root both walk the document's animations, so a few
    // elements are asked one by one and many at once. A ::before or ::after's only
    // come with the root's.
    const whole = this.pseudo || this.started.size > FEW_STARTS;
    const found = whole
      ? this.root.getAnimations()
      : [...this.started].flatMap((t) => (t.isConnected ? t.getAnimations() : []));
    this.started.clear();
    this.pseudo = false;
    const added = found.filter((a): a is CSSAnimation => isCSSAnimation(a) && !this.running.has(a));
    if (this.take(added, whole ? found.filter(isCSSAnimation) : undefined).length) this.onStart?.();
  };

  /**
   * Track `anims`, making fields of SVGs that animate a lot. Returns the ones
   * now running. `all`, when given, is every animation in the root: an SVG's
   * come from it rather than asking the SVG. Each ask walks the document's
   * animations, and after a field is made (which restyles) it restyles the
   * board too: a few hundred ms for a board that thaws with a few SVGs.
   */
  private take(anims: CSSAnimation[], all?: CSSAnimation[]): CSSAnimation[] {
    const svgs = new Set<SVGSVGElement>();
    for (const a of anims) {
      if (holdsLastFrame(a) && !this.settling.has(a)) {
        this.settling.add(a);
        releaseWhenDone(a);
      }
      const t = targetOf(a);
      const svg = t instanceof SVGElement ? outermostSvg(t) : null;
      if (svg) svgs.add(svg);
      else if (t && paintOnly(a) && isStackingContext(t)) t.setAttribute("data-pz-layer", "");
    }
    let bySvg: Map<SVGSVGElement, CSSAnimation[]> | undefined;
    if (all && svgs.size) {
      bySvg = new Map();
      for (const a of all) {
        const t = targetOf(a);
        const svg = t instanceof SVGElement ? outermostSvg(t) : null;
        if (!svg || !svgs.has(svg)) continue;
        const list = bySvg.get(svg);
        if (list) list.push(a);
        else bySvg.set(svg, [a]);
      }
    }
    let css: string | undefined;
    for (const svg of svgs) {
      if (this.fields.has(svg) || this.plain.has(svg)) continue;
      const list = bySvg?.get(svg) ?? svg.getAnimations({ subtree: true }).filter(isCSSAnimation);
      if (list.length >= FIELD_MIN) {
        css ??= styleText(this.root);
        const f = imageSafe(svg, css) ? field(svg, list, css, () => this.calmed) : null;
        if (f) {
          this.fields.set(svg, f);
          if (this.calmed) f.still();
          if (this.asleep) f.sleep(true);
          if (this.held) f.hold(true);
          continue;
        }
      }
      this.plain.add(svg);
      if (list.some(paintOnly)) svg.setAttribute("data-pz-layer", "");
    }
    const out: CSSAnimation[] = [];
    for (const a of anims) {
      const t = targetOf(a);
      if (!t || a.playState === "finished" || a.playState === "idle" || this.inField(t)) continue;
      this.running.add(a);
      const names = this.names.get(t) ?? new Map<string, CSSAnimation>();
      this.names.set(t, names.set(nameOf(a), a));
      out.push(a);
    }
    return out;
  }
}

const motions = new WeakMap<ShadowRoot, Motion>();

/**
 * A board's running animations, from what motion.ts keeps track of, without
 * asking the root: that walks and sorts every animation it has, tens of ms
 * on a board with a few thousand moving parts. A root motion.ts doesn't
 * watch is asked.
 */
export function animationsOf(root: ShadowRoot, ask = true): Animation[] {
  const m = motions.get(root);
  return m ? [...m.running] : ask ? root.getAnimations() : [];
}

/** The fields in a board that hold any of these elements (Motion.fieldsOf). */
export function fieldsOf(root: ShadowRoot, ids: Iterable<string>): FieldClock[] {
  return motions.get(root)?.fieldsOf(ids) ?? [];
}

/** Make a hidden board's animations ahead of time (Motion.warm). */
export function warm(root: ShadowRoot | null | undefined) {
  if (root) motions.get(root)?.warm();
}

function targetOf(a: Animation): Element | null {
  return a.effect instanceof KeyframeEffect ? a.effect.target : null;
}

export function isCSSAnimation(a: Animation): a is CSSAnimation {
  return "animationName" in a;
}

/** An animation's pseudo-element and name, the same whether read from it or from its events. */
export function key(pseudo: string | null, name: string) {
  return `${pseudo ?? ""}|${name}`;
}

export function nameOf(a: CSSAnimation) {
  return key((a.effect as KeyframeEffect).pseudoElement, a.animationName);
}

function outermostSvg(el: Element): SVGSVGElement | null {
  let top: SVGSVGElement | null = null;
  for (let e: Element | null = el; e; e = e.parentElement)
    if (e instanceof SVGSVGElement) top = e;
    else if (!(e instanceof SVGElement)) break;
  return top;
}

function animatedProperties(a: CSSAnimation): string[] {
  const kf = (a.effect as KeyframeEffect).getKeyframes();
  return [...new Set(kf.flatMap((k) => Object.keys(k)))].filter((p) => !NOT_PROPERTIES.has(p));
}

function paintOnly(a: CSSAnimation): boolean {
  return animatedProperties(a).some((p) => !COMPOSITED.has(p));
}

function isStackingContext(el: Element): boolean {
  const s = getComputedStyle(el);
  return (
    (s.position !== "static" && s.zIndex !== "auto") ||
    s.opacity !== "1" ||
    s.transform !== "none" ||
    s.filter !== "none" ||
    s.clipPath !== "none" ||
    s.maskImage !== "none" ||
    s.isolation === "isolate" ||
    s.mixBlendMode !== "normal"
  );
}

function styleText(root: ShadowRoot): string {
  return [...root.querySelectorAll("style:not([data-pz-base])")]
    .map((s) => s.textContent ?? "")
    .join("\n")
    .replace(/:host\b/g, ":root");
}

/**
 * An SVG image document can't load fonts or other files, and only sees the
 * SVG itself, so it only stands in for SVGs that need nothing else and whose
 * style rules select the same elements without their HTML ancestors.
 */
function imageSafe(svg: SVGSVGElement, css: string): boolean {
  if (svg.querySelector("text, foreignObject, image, feImage, video, audio, iframe")) return false;
  // Every #fragment must be in this SVG: one in another SVG on the board is gone from the image.
  const ids = new Set([...svg.querySelectorAll("[id]")].map((e) => e.id));
  for (const u of svg.querySelectorAll("use")) {
    const href = u.getAttribute("href") ?? u.getAttribute("xlink:href") ?? "";
    if (!href.startsWith("#") || !ids.has(decodeURIComponent(href.slice(1)))) return false;
  }
  if (/url\(\s*["']?(?!#)/.test(svg.outerHTML)) return false;
  for (const m of svg.outerHTML.matchAll(/url\(\s*["']?#([^"')\s]+)/g))
    if (!ids.has(decodeURIComponent(m[1]!))) return false;
  if (getComputedStyle(svg).overflow === "visible") return false;
  const vb = svg.viewBox.baseVal;
  if (!vb || !vb.width || !vb.height) return false;
  const detached = svg.cloneNode(true) as SVGSVGElement;
  const sheet = new CSSStyleSheet();
  try {
    sheet.replaceSync(css);
  } catch {
    return false;
  }
  for (const sel of selectors(sheet.cssRules)) {
    try {
      const live = svg.querySelectorAll(sel).length + (svg.matches(sel) ? 1 : 0);
      const alone = detached.querySelectorAll(sel).length + (detached.matches(sel) ? 1 : 0);
      if (live !== alone) return false;
    } catch {
      // A selector the engine can't test here (e.g. :host); it can't reach inside the SVG either.
    }
  }
  return true;
}

function selectors(rules: CSSRuleList): string[] {
  const out: string[] = [];
  for (const r of rules) {
    if (r instanceof CSSStyleRule) out.push(r.selectorText);
    else if ("cssRules" in r) out.push(...selectors((r as CSSGroupingRule).cssRules));
  }
  return out;
}

interface Phase {
  el: Element;
  /** Its copy in the image. */
  copy: SVGElement;
  delays: number[];
  /** Each animation's current time when the image was made, by animation-name position. */
  at: (number | null)[];
}

/** Draw `svg` as an image of itself, or return null if it can't. */
function field(
  svg: SVGSVGElement,
  anims: CSSAnimation[],
  css: string,
  calmed: () => boolean,
): Field | null {
  const vb = svg.viewBox.baseVal;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const live = [svg, ...svg.querySelectorAll("*")];
  const copy = [clone, ...clone.querySelectorAll("*")];
  const index = new Map(live.map((e, i) => [e, i]));

  const byEl = new Map<Element, CSSAnimation[]>();
  for (const a of anims) {
    const t = targetOf(a)!;
    byEl.set(t, [...(byEl.get(t) ?? []), a]);
  }
  const t0 = performance.now();
  const phases: Phase[] = [];
  for (const [el, list] of byEl) {
    const i = index.get(el);
    if (i === undefined) continue;
    const s = getComputedStyle(el);
    const names = s.animationName.split(",").map((n) => n.trim());
    const delays = s.animationDelay.split(",").map(ms);
    const at = names.map((n) => {
      const a = list.find((x) => x.animationName === n);
      return a && a.currentTime !== null ? Number(a.currentTime) : null;
    });
    const shifted = names.map((_, k) => {
      const d = delays[k % delays.length] ?? 0;
      const t = at[k];
      return t === null || t === undefined ? d : d - t;
    });
    phases.push({
      el,
      copy: copy[i] as SVGElement,
      delays: names.map((_, k) => delays[k % delays.length] ?? 0),
      at,
    });
    (copy[i] as SVGElement).style.animationDelay = shifted.map((d) => `${d}ms`).join(",");
  }
  if (!phases.length) return null;
  // The board time the image starts at: its first animation's, when it was made.
  const first = phases.flatMap((p) => p.at).find((t) => t !== null && t !== undefined) ?? 0;

  // What the SVG inherits from the page, which the image can't see.
  const computed = getComputedStyle(svg);
  for (const p of INHERITED) clone.style.setProperty(p, computed.getPropertyValue(p));
  for (const v of new Set([...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]!))) {
    const value = computed.getPropertyValue(v);
    if (value) clone.style.setProperty(v, value);
  }
  clone.setAttribute("xmlns", SVG_NS);
  clone.setAttribute("width", String(vb.width));
  clone.setAttribute("height", String(vb.height));
  const style = document.createElementNS(SVG_NS, "style");
  style.textContent = css;
  clone.insertBefore(style, clone.firstChild);

  const blob = () =>
    URL.createObjectURL(
      new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" }),
    );
  let url = blob();
  const image = document.createElementNS(SVG_NS, "image");
  image.setAttribute("href", url);
  image.setAttribute("x", String(vb.x));
  image.setAttribute("y", String(vb.y));
  image.setAttribute("width", String(vb.width));
  image.setAttribute("height", String(vb.height));
  image.setAttribute("preserveAspectRatio", "none");
  image.setAttribute("data-pz-image", "");
  // The image's animations start on its own clock each time it loads, at board time
  // `from`; until the first load, the live SVG stays up.
  let started = t0;
  let from = first;
  let loaded = false;
  /** Waiting for the image to show a new phase. */
  let phased: (() => void) | undefined;
  /** The pointer is over the SVG. */
  let pointed = false;
  /** Not rendered: the image has no document. */
  let asleep = false;
  /** Held: the board time the image stands still at. */
  let heldAt: number | undefined;
  /**
   * Load the image again showing board time `t`, running on from there or
   * standing still at it. Resolves once it shows (or at once while asleep:
   * it shows when it wakes).
   */
  const draw = (t: number, still: boolean) =>
    new Promise<void>((resolve) => {
      // Each animation keeps its offset from the first; all of them move to t.
      for (const p of phases) {
        p.copy.style.animationDelay = p.delays
          .map((d, k) => {
            const a = p.at[k];
            return `${a === null || a === undefined ? d : d - (a - first + t)}ms`;
          })
          .join(",");
        p.copy.style.animationPlayState = still ? "paused" : "";
      }
      from = t;
      const old = url;
      url = blob();
      phased?.();
      phased = resolve;
      if (asleep) {
        image.removeAttribute("href");
        phased = undefined;
        resolve();
      } else image.setAttribute("href", url);
      URL.revokeObjectURL(old);
    });
  image.addEventListener("load", () => {
    started = performance.now();
    phased?.();
    phased = undefined;
    if (loaded) return;
    loaded = true;
    // Pointed at already (it was made while its board was a picture, and the
    // pointer brought the board live): the live elements stay, for hover, until it leaves.
    if (pointed && !calmed()) return;
    svg.setAttribute("data-pz-field", "");
  });
  svg.appendChild(image);
  svg.setAttribute("data-pz-layer", "");

  // Too small to see a hover on: the image stays, and so do the page's few layers.
  const tiny = () => {
    const r = phases[0]!.el.getBoundingClientRect();
    return Math.max(r.width, r.height) * devicePixelRatio < STILL_PX;
  };
  // Live while pointed at, in the same phase as the image.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const goLive = () => {
    pointed = true;
    clearTimeout(timer);
    if (calmed() || heldAt !== undefined || !svg.hasAttribute("data-pz-field") || tiny()) return;
    const shift = from - first + performance.now() - started;
    for (const p of phases)
      (p.el as SVGElement).style.animationDelay = p.delays
        .map((d, k) => {
          const t = p.at[k];
          return `${t === null || t === undefined ? d : d - (t + shift)}ms`;
        })
        .join(",");
    svg.removeAttribute("data-pz-field");
  };
  const goStill = () => {
    pointed = false;
    clearTimeout(timer);
    timer = setTimeout(() => loaded && svg.setAttribute("data-pz-field", ""), BACK_TO_IMAGE_MS);
  };
  svg.addEventListener("pointerenter", goLive);
  svg.addEventListener("pointerleave", goStill);
  return {
    still: () => {
      clearTimeout(timer);
      if (loaded) svg.setAttribute("data-pz-field", "");
    },
    wake: () => {
      if (svg.matches(":hover")) goLive();
    },
    sleep: (on) => {
      // Content skipped by `content-visibility` still runs an image's animations. Without
      // its document they stop; back, it loads again (the blob's cached) and fires `load`,
      // which restarts the clock the live elements are phased from.
      asleep = on;
      if (on) image.removeAttribute("href");
      else if (!image.hasAttribute("href")) image.setAttribute("href", url);
    },
    hold: (on) => {
      // The image's document can't be paused from here: drawn again standing still at
      // the pose it shows now, and again running on from that pose once let go.
      if (on === (heldAt !== undefined)) return;
      const running = loaded && image.hasAttribute("href");
      const t = heldAt ?? (running ? from + performance.now() - started : from);
      heldAt = on ? t : undefined;
      if (on) {
        clearTimeout(timer);
        if (loaded) svg.setAttribute("data-pz-field", "");
      }
      void draw(t, on).then(() => !on && pointed && goLive());
    },
    stop: () => {
      clearTimeout(timer);
      svg.removeEventListener("pointerenter", goLive);
      svg.removeEventListener("pointerleave", goStill);
      URL.revokeObjectURL(url);
      phased?.();
    },
    time: () => {
      if (!loaded || !image.hasAttribute("href")) return null;
      return heldAt ?? from + performance.now() - started;
    },
    phase: (t) => {
      // Held, it stands still at the pose it's given.
      if (heldAt !== undefined) heldAt = t;
      return draw(t, heldAt !== undefined);
    },
  };
}

export function ms(v: string): number {
  const n = Number.parseFloat(v);
  return v.trim().endsWith("ms") ? n : n * 1000;
}

function holdsLastFrame(a: CSSAnimation): boolean {
  const t = (a.effect as KeyframeEffect).getTiming();
  return Number.isFinite(t.iterations ?? 1) && (t.fill === "forwards" || t.fill === "both");
}

/**
 * A finished animation that fills forwards keeps its layer for good. Once it
 * ends, drop it if the element looks the same without it. The rest keep
 * filling: writing their end state inline would outrank the design's :hover
 * rules.
 */
function releaseWhenDone(a: CSSAnimation) {
  a.finished.then(
    () => {
      const el = targetOf(a);
      if (!el?.isConnected || a.playState !== "finished") return;
      const pseudo = (a.effect as KeyframeEffect).pseudoElement;
      const props = animatedProperties(a).map(kebab);
      const held = props.map((p) => same(getComputedStyle(el, pseudo).getPropertyValue(p)));
      a.cancel();
      const after = getComputedStyle(el, pseudo);
      if (props.some((p, i) => same(after.getPropertyValue(p)) !== held[i])) a.finish();
    },
    () => {},
  );
}

/** An animation that ends on `transform: none` computes to the identity matrix. */
export function same(v: string): string {
  const t = v.trim();
  return t === "matrix(1, 0, 0, 1, 0, 0)" ||
    t === "matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)"
    ? "none"
    : t;
}

function kebab(p: string): string {
  return p.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}
