import { FONT_LINT_SCRIPT } from "./fonts.ts";
import { LINT_SCRIPT, type LintIssue } from "./renderer.ts";

/** A node to put in an interaction state before capturing, by id. */
export interface Interaction {
  hover?: string;
  focus?: string;
  /** Pointer down: :active, and :hover with it. */
  press?: string;
}

export interface MotionAnimation {
  /** The animated node's id. */
  id: string;
  /** "::before" or "::after" when a pseudo-element animates. */
  pseudo?: string;
  kind: "animation" | "transition" | "smil" | "video";
  /** Keyframes name, transitioned property, SVG attribute or video file. */
  name: string;
  properties: string[];
  delay: number;
  /** One iteration, in ms. */
  duration: number;
  /** null loops forever. */
  iterations: number | null;
  direction: string;
  easing: string;
  /** When it finishes on the timeline, in ms. null loops forever. */
  end: number | null;
  /** "time" plays over time; "scroll" and "view" follow a scroll position. */
  timeline: "time" | "scroll" | "view";
  /** animation-play-state: paused in the CSS, so it never plays on its own. */
  paused?: boolean;
}

export interface MotionInfo {
  /** What started the timeline: "load", or "hover n_card" and so on. */
  trigger: string;
  animations: MotionAnimation[];
  /** When every finite animation on this timeline has finished, in ms. */
  settled: number;
  /** Something on this timeline loops forever. */
  loops: boolean;
  /** One full cycle of the longest loop, in ms. */
  cycle: number;
  /** Where a recording ends by default: settled, or one loop past it. */
  end: number;
  /** The time currently shown, in ms. */
  at: number;
}

/** One frame of a recording: a time on the timeline, or a scroll offset. */
export interface FrameStep {
  label: string;
  t?: number;
  scroll?: number;
}

export interface RecordPlan {
  steps: FrameStep[];
  error?: string;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Runs in the page and installs `window.__ponzuMotion`. Designs have no
 * scripts, so every animation is CSS, SVG or video and can be paused and
 * seeked exactly: frames are repeatable and take no real time to reach.
 *
 * Serialized with toString, so it can't reference anything outside itself.
 */
function motionRuntime() {
  type Entry = { anim: Animation; base: number; trigger: string; paused: boolean; time: boolean };
  const w = window as any;
  if (w.__ponzuMotion) return;
  const root = document.querySelector("[data-artboard]") as HTMLElement | null;
  const STATES = ["hover", "active", "focus-visible", "focus-within", "focus"];
  let entries: Entry[] = [];
  let trigger = "load";
  let loadSettled = 0;
  let base = 0;
  let now = 0;
  let scroller: { el: Element; axis: "x" | "y" } | null = null;
  let rewritten: CSSStyleRule[] | null = null;
  const issues: LintIssue[] = [];

  const frame = () =>
    new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  const round = (n: number) => Math.round(n * 10) / 10;
  const idOf = (el: Element | null | undefined) =>
    el?.closest("[data-id]")?.getAttribute("data-id") ?? "";
  const label = (el: Element) => el.getAttribute("data-name") || el.tagName.toLowerCase();
  const byId = (id: string): Element | null => {
    if (!root) return null;
    if (root.getAttribute("data-id") === id) return root;
    return root.querySelector(`[data-id="${CSS.escape(id)}"]`);
  };
  const kebab = (p: string) => p.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
  const smil = () =>
    root ? [...root.querySelectorAll("animate, animateTransform, animateMotion, set")] : [];
  const svgs = () =>
    root
      ? ([...root.querySelectorAll("svg")].filter(
          (s) => !s.parentElement?.closest("svg"),
        ) as SVGSVGElement[])
      : [];
  const videos = () => (root ? [...root.querySelectorAll("video")] : []);

  /** SMIL clock values: "2s", "500ms", "1.5" (seconds), "1min". */
  const clock = (v: string | null): number | null => {
    if (!v) return null;
    const m = /^\s*(-?\d*\.?\d+)\s*(ms|s|min|h)?\s*$/.exec(v);
    if (!m) return null;
    const n = Number(m[1]);
    const unit = m[2] ?? "s";
    return unit === "ms" ? n : unit === "s" ? n * 1000 : unit === "min" ? n * 60000 : n * 3600000;
  };

  function authoredPaused(a: Animation): boolean {
    const name = (a as any).animationName;
    const effect = a.effect as KeyframeEffect | null;
    if (typeof name !== "string" || !effect?.target) return false;
    const cs = getComputedStyle(effect.target, effect.pseudoElement);
    const names = cs.animationName.split(",").map((s) => s.trim());
    const states = cs.animationPlayState.split(",").map((s) => s.trim());
    const i = names.indexOf(name);
    return i >= 0 && states[i % states.length] === "paused";
  }

  function adopt(anims: Animation[], from: string) {
    for (const anim of anims) {
      const time = anim.timeline === document.timeline;
      const paused = time && authoredPaused(anim);
      if (time) {
        anim.pause();
        anim.currentTime = 0;
      }
      entries.push({ anim, base: 0, trigger: from, paused, time });
    }
  }

  function describe(e: Entry): MotionAnimation | null {
    const a = e.anim as any;
    const effect = a.effect as KeyframeEffect | null;
    if (!effect) return null;
    const timing = effect.getTiming();
    const ct = effect.getComputedTiming();
    const frames = effect.getKeyframes();
    const isAnim = typeof a.animationName === "string";
    const isTransition = typeof a.transitionProperty === "string";
    const props = new Set<string>();
    if (isTransition) props.add(a.transitionProperty);
    else
      for (const k of frames)
        for (const p of Object.keys(k))
          if (!["offset", "computedOffset", "easing", "composite"].includes(p)) props.add(kebab(p));
    const timeline: MotionAnimation["timeline"] = e.time
      ? "time"
      : typeof (w as any).ViewTimeline !== "undefined" && a.timeline instanceof w.ViewTimeline
        ? "view"
        : "scroll";
    const iterations = Number.isFinite(ct.iterations) ? (ct.iterations as number) : null;
    const duration = e.time ? Number(ct.duration) || 0 : 0;
    const end = e.time && iterations !== null ? Number(ct.endTime) || 0 : null;
    const out: MotionAnimation = {
      id: idOf(effect.target),
      kind: isTransition ? "transition" : "animation",
      name: isAnim ? a.animationName : isTransition ? a.transitionProperty : a.id || "animation",
      properties: [...props],
      delay: round(Number(timing.delay) || 0),
      duration: round(duration),
      iterations,
      direction: String(timing.direction ?? "normal"),
      easing: isAnim ? String(frames[0]?.easing ?? "ease") : String(timing.easing ?? "linear"),
      end: end === null ? null : round(end),
      timeline,
    };
    if (effect.pseudoElement) out.pseudo = effect.pseudoElement;
    if (e.paused) out.paused = true;
    return out;
  }

  function describeSmil(el: Element): MotionAnimation {
    const dur = clock(el.getAttribute("dur")) ?? 0;
    const delay = clock(el.getAttribute("begin")) ?? 0;
    const repeat = el.getAttribute("repeatCount");
    const loops = repeat === "indefinite" || el.getAttribute("repeatDur") === "indefinite";
    const iterations = loops ? null : Number(repeat) || 1;
    return {
      id: idOf(el.parentElement),
      kind: "smil",
      name: el.getAttribute("attributeName") ?? el.tagName,
      properties: [el.getAttribute("attributeName") ?? "path"],
      delay: round(delay),
      duration: round(dur),
      iterations,
      direction: "normal",
      easing: el.getAttribute("calcMode") ?? "linear",
      end: iterations === null ? null : round(delay + dur * iterations),
      timeline: "time",
    };
  }

  function list(): MotionAnimation[] {
    const out: MotionAnimation[] = [];
    for (const e of entries) {
      if (e.trigger !== trigger) continue;
      const d = describe(e);
      if (d) out.push(d);
    }
    if (trigger === "load") {
      for (const el of smil()) out.push(describeSmil(el));
      for (const v of videos()) {
        const duration = Number.isFinite(v.duration) ? round(v.duration * 1000) : 0;
        out.push({
          id: idOf(v),
          kind: "video",
          name: /^(data|blob):/.test(v.currentSrc)
            ? "video"
            : v.currentSrc.split("/").pop() || "video",
          properties: [],
          delay: 0,
          duration,
          iterations: v.loop ? null : 1,
          direction: "normal",
          easing: "linear",
          // Unknown until its metadata loads; a video without one doesn't set the pace.
          end: v.loop || !duration ? null : duration,
          timeline: "time",
        });
      }
    }
    return out;
  }

  function info(): MotionInfo {
    const animations = list();
    let settled = 0;
    let loopEnd = 0;
    let cycle = 0;
    let loops = false;
    for (const a of animations) {
      if (a.timeline !== "time" || a.paused) continue;
      if (a.end !== null) settled = Math.max(settled, a.end);
      else if (a.duration > 0 || a.kind !== "video") {
        loops = true;
        const one = a.duration * (a.direction.includes("alternate") ? 2 : 1);
        cycle = Math.max(cycle, one);
        settled = Math.max(settled, a.delay);
        loopEnd = Math.max(loopEnd, a.delay + one);
      }
    }
    return {
      trigger,
      animations: animations.slice(0, 60),
      settled: round(settled),
      loops,
      cycle: round(cycle),
      end: round(Math.max(settled, loopEnd)),
      at: round(now),
    };
  }

  /** Puts everything at t without waiting for a frame. Videos seek separately. */
  function setTime(t: number) {
    now = t;
    for (const e of entries) {
      if (!e.time || e.paused || e.anim.playState === "idle") continue;
      e.anim.currentTime = e.base + t;
    }
    for (const s of svgs()) s.setCurrentTime((base + t) / 1000);
  }

  async function seek(t: number) {
    setTime(t);
    await Promise.all(
      videos().map(
        (v) =>
          new Promise<void>((resolve) => {
            const dur = v.duration;
            if (!Number.isFinite(dur) || dur <= 0) return resolve();
            const s = (base + t) / 1000;
            const target = v.loop ? s % dur : Math.min(s, dur);
            if (Math.abs(v.currentTime - target) < 0.001) return resolve();
            const done = () => resolve();
            v.addEventListener("seeked", done, { once: true });
            setTimeout(done, 1500);
            v.currentTime = target;
          }),
      ),
    );
    await frame();
    return round(now);
  }

  /** Restarts everything from its first frame and holds it there. */
  function hold() {
    if (!root) return info();
    // Animations that finished while fonts and images loaded are gone;
    // reinserting the artboard starts every one of them, @starting-style too.
    const parent = root.parentNode!;
    const next = root.nextSibling;
    parent.removeChild(root);
    void document.body.offsetHeight;
    parent.insertBefore(root, next);
    entries = [];
    adopt(document.getAnimations(), "load");
    for (const s of svgs()) {
      s.pauseAnimations();
      s.setCurrentTime(0);
    }
    for (const v of videos()) v.pause();
    trigger = "load";
    loadSettled = info().settled;
    return info();
  }

  /** Makes :hover, :focus and :active rules also match a data attribute we control. */
  function rewrite(): CSSStyleRule[] {
    if (rewritten) return rewritten;
    const out: CSSStyleRule[] = [];
    const pattern = new RegExp(`:(${STATES.join("|")})(?![\\w-])`, "g");
    const walk = (rules: CSSRuleList) => {
      for (const rule of [...rules]) {
        if (rule instanceof CSSStyleRule && pattern.test(rule.selectorText)) {
          pattern.lastIndex = 0;
          rule.selectorText = rule.selectorText.replace(
            pattern,
            (_, s: string) => `:is(:${s},[data-ponzu-${s}])`,
          );
          out.push(rule);
        }
        pattern.lastIndex = 0;
        if ("cssRules" in rule && (rule as CSSGroupingRule).cssRules)
          walk((rule as CSSGroupingRule).cssRules);
      }
    };
    for (const sheet of [...document.styleSheets]) {
      try {
        walk(sheet.cssRules);
      } catch {
        // Cross-origin sheets (Google Fonts) can't be read and have no states.
      }
    }
    rewritten = out;
    return out;
  }

  function interact(s: { hover?: string; focus?: string; press?: string }) {
    if (!root) return { error: "No artboard on the page." };
    const chain = (el: Element) => {
      const out: Element[] = [];
      for (let n: Element | null = el; n; n = n.parentElement) out.push(n);
      return out;
    };
    const wants: [string, string, string][] = [];
    if (s.hover) wants.push(["hover", s.hover, ":hover"]);
    if (s.press) wants.push(["press", s.press, ":active"]);
    if (s.focus) wants.push(["focus", s.focus, ":focus"]);
    const targets: [string, Element, string][] = [];
    for (const [kind, id, pseudo] of wants) {
      const el = byId(id);
      if (!el) return { error: `No node ${id} in this artboard.` };
      targets.push([kind, el, pseudo]);
    }
    // Start from the settled page, the way a person meets it.
    setTime(loadSettled);
    for (const e of entries) e.base = loadSettled;
    base = loadSettled;
    now = 0;
    // Transitions start from the last computed style, so compute the settled one first.
    void document.body.offsetHeight;
    const rules = rewrite();
    const before = rules.map(matches);
    const near = targets.flatMap(([, el]) => [...chain(el), ...el.querySelectorAll("*")]);
    const looked = look() + full(near);
    for (const [kind, el] of targets) {
      if (kind === "hover" || kind === "press")
        for (const n of chain(el)) n.setAttribute("data-ponzu-hover", "");
      if (kind === "press") for (const n of chain(el)) n.setAttribute("data-ponzu-active", "");
      if (kind === "focus") {
        (el as HTMLElement).focus?.({ preventScroll: true });
        el.setAttribute("data-ponzu-focus", "");
        el.setAttribute("data-ponzu-focus-visible", "");
        for (const n of chain(el)) n.setAttribute("data-ponzu-focus-within", "");
      }
    }
    const known = new Set(entries.map((e) => e.anim));
    const fresh = document.getAnimations().filter((a) => !known.has(a));
    const changed = rules.filter((r, i) => matches(r) !== before[i]);
    // A new transition means something changes, though its first frame looks the same.
    if (!fresh.length && look() + full(near) === looked) {
      const beaten = changed.some(overriddenInline);
      for (const [kind, el, pseudo] of targets) {
        const which = kind === "press" ? ":active or :hover" : pseudo;
        const verb = kind === "press" ? "pressing" : kind === "hover" ? "hovering" : "focusing";
        issues.push({
          id: idOf(el),
          kind: "no-state-style",
          message: beaten
            ? `a ${which} rule matches ${label(el)}, but ${verb} it changes nothing: inline styles beat <style> rules. Mark the state's declarations !important`
            : changed.length
              ? `a ${which} rule matches ${label(el)}, but ${verb} it changes nothing: its values are what's already there`
              : `no ${which} rule matches ${label(el)} or its ancestors, so ${verb} it changes nothing`,
        });
      }
    }
    entries = entries.filter((e) => e.anim.playState !== "idle");
    trigger = targets.map(([kind, el]) => `${kind} ${idOf(el)}`).join(", ");
    adopt(fresh, trigger);
    return info();
  }

  /** A fingerprint of what states usually change, across the artboard. */
  function look(): string {
    if (!root) return "";
    const props = [
      "color",
      "background-color",
      "background-image",
      "border-color",
      "outline-color",
      "outline-style",
      "box-shadow",
      "opacity",
      "transform",
      "translate",
      "scale",
      "rotate",
      "filter",
      "text-decoration-line",
      "visibility",
      "display",
      "width",
      "height",
    ];
    const els = [root, ...root.querySelectorAll("*")].slice(0, 3000);
    let out = "";
    for (const el of els) {
      const cs = getComputedStyle(el);
      for (const p of props) out += `${cs.getPropertyValue(p)}|`;
      for (const pseudo of ["::before", "::after"]) {
        const ps = getComputedStyle(el, pseudo);
        if (ps.content !== "none") for (const p of props) out += `${ps.getPropertyValue(p)}|`;
      }
    }
    return out;
  }

  /** Every computed property of a few elements: what a state near them could change. */
  function full(els: Element[]): string {
    let out = "";
    for (const el of els.slice(0, 300)) {
      const cs = getComputedStyle(el);
      for (let i = 0; i < cs.length; i++) out += `${cs.getPropertyValue(cs[i]!)}|`;
    }
    return out;
  }

  /** Whether an element the rule matches sets one of its properties inline, without !important. */
  function overriddenInline(rule: CSSStyleRule): boolean {
    const sel = rule.selectorText.replace(/::?(before|after|marker|placeholder)(?![\w-])/g, "");
    let els: Element[];
    try {
      els = [root!, ...root!.querySelectorAll("*")].filter((el) => el.matches(sel));
    } catch {
      return false;
    }
    for (let i = 0; i < rule.style.length; i++) {
      const prop = rule.style[i]!;
      if (rule.style.getPropertyPriority(prop) === "important") continue;
      for (const el of els) {
        const inline = (el as HTMLElement).style;
        if (
          inline?.getPropertyValue(prop) &&
          inline.getPropertyValue(prop) !== rule.style.getPropertyValue(prop)
        )
          return true;
      }
    }
    return false;
  }

  function matches(rule: CSSStyleRule): boolean {
    // Pseudo-elements never match an element; their originating element does.
    const sel = rule.selectorText.replace(
      /::?(before|after|marker|placeholder|selection|first-line|first-letter|backdrop|file-selector-button)(?![\w-])/g,
      "",
    );
    try {
      return root!.matches(sel) || !!root!.querySelector(sel);
    } catch {
      return false;
    }
  }

  /** Hold, optionally enter a state, then show `at` (default: settled). */
  async function prepare(opts: {
    interact?: { hover?: string; focus?: string; press?: string };
    at?: number;
  }) {
    // A video's length is what paces it; give each a moment to report it.
    await Promise.all(
      videos().map(
        (v) =>
          new Promise<void>((resolve) => {
            if (v.readyState >= 1 || v.error || !(v.currentSrc || v.src)) return resolve();
            v.addEventListener("loadedmetadata", () => resolve(), { once: true });
            v.addEventListener("error", () => resolve(), { once: true });
            setTimeout(resolve, 2000);
          }),
      ),
    );
    hold();
    if (opts.interact && Object.values(opts.interact).some(Boolean)) {
      const r = interact(opts.interact);
      if ("error" in r) return r;
    }
    await seek(opts.at ?? info().settled);
    return info();
  }

  function plan(spec: { frames?: number; from?: number; to?: number; scroll?: string }): {
    steps: FrameStep[];
    error?: string;
  } {
    const n = Math.max(1, Math.min(24, Math.round(spec.frames ?? 9)));
    const spread = (from: number, to: number) =>
      n === 1 || to <= from
        ? [from]
        : Array.from({ length: n }, (_, i) => round(from + ((to - from) * i) / (n - 1)));
    if (spec.scroll) {
      const el = byId(spec.scroll);
      if (!el) return { steps: [], error: `No node ${spec.scroll} in this artboard.` };
      const y = el.scrollHeight - el.clientHeight;
      const x = el.scrollWidth - el.clientWidth;
      if (y <= 1 && x <= 1)
        return {
          steps: [],
          error: `${spec.scroll} doesn't scroll: its content fits inside it. Give it a fixed height and overflow: auto, with content taller than that.`,
        };
      scroller = { el, axis: y > 1 ? "y" : "x" };
      return {
        steps: spread(0, Math.round(y > 1 ? y : x)).map((p) => ({
          scroll: Math.round(p),
          label: `${Math.round(p)}px`,
        })),
      };
    }
    const i = info();
    const from = spec.from ?? 0;
    const to = spec.to ?? Math.min(i.end, 10000);
    return {
      steps: spread(from, Math.max(from, to)).map((t) => ({
        t,
        label: `${Math.round(t)}ms${t === i.settled && i.animations.length ? " settled" : ""}`,
      })),
    };
  }

  function scrollTo(px: number) {
    if (!scroller) return;
    if (scroller.axis === "y") scroller.el.scrollTop = px;
    else scroller.el.scrollLeft = px;
  }

  async function apply(step: FrameStep) {
    if (step.scroll !== undefined) {
      scrollTo(step.scroll);
      await frame();
    } else await seek(step.t ?? 0);
  }

  /** The area every step covers, inside the artboard, so a moving node stays in frame. */
  function box(arg: { selector: string; steps: FrameStep[] }): Box | null {
    const el = document.querySelector(arg.selector);
    if (!el || !root) return null;
    const rects: DOMRect[] = [];
    const held = now;
    for (const step of arg.steps.length ? arg.steps : [{ label: "" }]) {
      if (step.scroll !== undefined) scrollTo(step.scroll);
      else if (step.t !== undefined) setTime(step.t);
      rects.push(el.getBoundingClientRect());
    }
    scrollTo(0);
    setTime(held);
    const ab = root.getBoundingClientRect();
    const left = Math.max(ab.left, Math.min(...rects.map((r) => r.left)));
    const top = Math.max(ab.top, Math.min(...rects.map((r) => r.top)));
    const right = Math.min(ab.right, Math.max(...rects.map((r) => r.right)));
    const bottom = Math.min(ab.bottom, Math.max(...rects.map((r) => r.bottom)));
    return {
      x: left,
      y: top,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top),
    };
  }

  /** Back to rest for lint: everything finished, scrolled to the top. */
  async function settle() {
    scrollTo(0);
    await seek(info().settled);
  }

  /** Motion problems an agent can't see in HTML. */
  function lint(): LintIssue[] {
    const out = [...issues];
    if (!root) return out;
    const defined = new Set<string>();
    const walk = (rules: CSSRuleList) => {
      for (const rule of [...rules]) {
        if (rule instanceof CSSKeyframesRule) defined.add(rule.name);
        else if ("cssRules" in rule && (rule as CSSGroupingRule).cssRules)
          walk((rule as CSSGroupingRule).cssRules);
      }
    };
    for (const sheet of [...document.styleSheets]) {
      try {
        walk(sheet.cssRules);
      } catch {}
    }
    for (const el of [root, ...root.querySelectorAll("*")]) {
      const cs = getComputedStyle(el);
      if (cs.animationName === "none" || cs.display === "none") continue;
      for (const raw of cs.animationName.split(",")) {
        const name = raw.trim();
        if (name && name !== "none" && !defined.has(name))
          out.push({
            id: idOf(el),
            kind: "missing-keyframes",
            message: `@keyframes ${name} isn't defined here, so ${label(el)} doesn't animate. Define it in a <style> inside this artboard`,
          });
      }
    }
    const flagged = new Set<string>();
    for (const e of entries) {
      if (!e.time || e.paused || e.anim.playState === "idle") continue;
      const effect = e.anim.effect as KeyframeEffect | null;
      const target = effect?.target;
      if (!effect || !target || effect.pseudoElement) continue;
      const ct = effect.getComputedTiming();
      if (!Number.isFinite(ct.endTime) || e.base + now < Number(ct.endTime)) continue;
      if (ct.fill === "forwards" || ct.fill === "both") continue;
      if (!effect.getKeyframes().some((k) => "opacity" in k)) continue;
      if (getComputedStyle(target).opacity !== "0") continue;
      // A fade-out is meant to end hidden: only flag one that ends visible.
      const at = e.anim.currentTime;
      e.anim.currentTime = Math.max(0, Number(ct.endTime) - 1);
      const last = getComputedStyle(target).opacity;
      e.anim.currentTime = at;
      if (Number(last) < 0.05) continue;
      const id = idOf(target);
      if (flagged.has(id)) continue;
      flagged.add(id);
      const name = (e.anim as any).animationName ?? (e.anim as any).transitionProperty ?? "";
      out.push({
        id,
        kind: "hidden-after-animation",
        message: `${label(target)} is invisible once ${name} ends: without animation-fill-mode: forwards it snaps back to opacity: 0`,
      });
    }
    return out;
  }

  w.__ponzuMotion = { hold, interact, prepare, seek, info, plan, apply, box, settle, lint };
}

/** Installs `window.__ponzuMotion` in a page. */
export const MOTION_SCRIPT = `(${motionRuntime.toString()})()`;

/** A call into the installed runtime, as an expression any renderer can evaluate. */
export function motionCall(method: string, arg?: unknown): string {
  return `window.__ponzuMotion.${method}(${arg === undefined ? "" : JSON.stringify(arg)})`;
}

/* Contact sheets */

const SHEET = { budget: 1600, pad: 12, gap: 10, label: 20 };

/**
 * The grid that shows n frames of w×h as large as fits in the budget. Small
 * frames all reach the 2x cap; then the squarest sheet wins, since it reads
 * in order without a long scroll.
 */
export function sheetLayout(n: number, w: number, h: number) {
  let best = { cols: 1, rows: n, scale: 0, squareness: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const room = SHEET.budget - 2 * SHEET.pad;
    const scale = Math.min(
      (room - (cols - 1) * SHEET.gap) / (cols * w),
      (room - (rows - 1) * SHEET.gap - rows * SHEET.label) / (rows * h),
      2,
    );
    const sw = cols * w * scale + (cols - 1) * SHEET.gap;
    const sh = rows * (h * scale + SHEET.label) + (rows - 1) * SHEET.gap;
    const squareness = Math.min(sw, sh) / Math.max(sw, sh);
    const better =
      scale > best.scale + 0.01 ||
      (Math.abs(scale - best.scale) <= 0.01 && squareness > best.squareness);
    if (better) best = { cols, rows, scale, squareness };
  }
  return { cols: best.cols, rows: best.rows, scale: best.scale };
}

/** A page that lays frames out in a labeled grid. Capture its `.sheet` element. */
export function contactSheet(
  frames: { label: string; src: string }[],
  cell: { width: number; height: number },
  cols: number,
): { html: string; width: number; height: number } {
  const rows = Math.ceil(frames.length / cols);
  const cw = Math.max(1, Math.floor(cell.width));
  const ch = Math.max(1, Math.floor(cell.height));
  const width = 2 * SHEET.pad + cols * cw + (cols - 1) * SHEET.gap;
  const height = 2 * SHEET.pad + rows * (ch + SHEET.label) + (rows - 1) * SHEET.gap;
  const text = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const cells = frames
    .map(
      (f) =>
        `<figure><figcaption>${text(f.label)}</figcaption><img src="${f.src}" width="${cw}" height="${ch}"></figure>`,
    )
    .join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#ececec}
.sheet{display:grid;grid-template-columns:repeat(${cols},${cw}px);gap:${SHEET.gap}px;padding:${SHEET.pad}px;width:${width}px;box-sizing:border-box;background:#ececec}
figure{margin:0;display:flex;flex-direction:column}
figcaption{height:${SHEET.label}px;font:500 12px/${SHEET.label}px ui-monospace,Menlo,monospace;color:#555}
img{display:block;background:repeating-conic-gradient(#fff 0 25%,#f4f4f4 0 50%) 0 0/16px 16px;outline:1px solid #d6d6d6}
</style></head><body><div class="sheet">${cells}</div></body></html>`;
  return { html, width, height };
}

/** Font lint, layout lint and motion lint, as one expression. Needs MOTION_SCRIPT installed for the motion part. */
export const FULL_LINT_SCRIPT = `[...${FONT_LINT_SCRIPT}, ...${LINT_SCRIPT}, ...(window.__ponzuMotion ? ${motionCall("lint")} : [])].slice(0, 30)`;

/** Installs the runtime, holds the timeline and shows `at`. Evaluates to MotionInfo or { error }. */
export function prepareScript(opts: { interact?: Interaction; at?: number }): string {
  return `(${MOTION_SCRIPT}, ${motionCall("prepare", opts)})`;
}

/** What a renderer has to offer for recording: one live page. */
export interface FrameDriver {
  /** Evaluate an expression in the page; promises are awaited. */
  evaluate<T = unknown>(expression: string): Promise<T>;
  /** A PNG of a region, in CSS pixels, at `scale` device pixels per CSS pixel. */
  capture(box: Box, scale: number): Promise<Uint8Array>;
  /** Replace the page with this HTML at this viewport size and wait for it to load. */
  show(html: string, width: number, height: number): Promise<void>;
}

export interface RecordOptions {
  /** CSS selector of the element to frame. */
  selector: string;
  interact?: Interaction;
  frames?: number;
  from?: number;
  to?: number;
  /** Id of the node whose scroll range to step through. */
  scroll?: string;
  lint?: boolean;
}

export interface Recording {
  bytes: Uint8Array;
  width: number;
  height: number;
  steps: FrameStep[];
  motion: MotionInfo;
  issues: LintIssue[];
}

/**
 * Records on a page that already shows the artboard: holds its timeline,
 * captures each step, lints at rest, then lays the frames out as a contact
 * sheet on the same page and captures that.
 */
export async function recordFrames(page: FrameDriver, opts: RecordOptions): Promise<Recording> {
  const prepared = await page.evaluate<MotionInfo | { error: string }>(
    // Scroll recordings show time-based motion at rest; time recordings start at 0.
    prepareScript({ interact: opts.interact, at: opts.scroll ? undefined : 0 }),
  );
  if ("error" in prepared) throw new Error(prepared.error);
  const plan = await page.evaluate<RecordPlan>(
    motionCall("plan", { frames: opts.frames, from: opts.from, to: opts.to, scroll: opts.scroll }),
  );
  if (plan.error) throw new Error(plan.error);
  const box = await page.evaluate<Box | null>(
    motionCall("box", { selector: opts.selector, steps: plan.steps }),
  );
  if (!box) throw new Error("That node isn't in this artboard.");
  const layout = sheetLayout(plan.steps.length, box.width, box.height);
  const frames: { label: string; src: string }[] = [];
  for (const step of plan.steps) {
    await page.evaluate(motionCall("apply", step));
    const png = await page.capture(box, layout.scale);
    frames.push({ label: step.label, src: `data:image/png;base64,${base64(png)}` });
  }
  await page.evaluate(motionCall("settle"));
  const issues = opts.lint ? await page.evaluate<LintIssue[]>(FULL_LINT_SCRIPT) : [];
  const sheet = contactSheet(
    frames,
    { width: box.width * layout.scale, height: box.height * layout.scale },
    layout.cols,
  );
  await page.show(sheet.html, sheet.width, sheet.height);
  const bytes = await page.capture({ x: 0, y: 0, width: sheet.width, height: sheet.height }, 1);
  return {
    bytes,
    width: sheet.width,
    height: sheet.height,
    steps: plan.steps,
    motion: prepared,
    issues,
  };
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
