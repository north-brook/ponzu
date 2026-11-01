/*
 * Scene scripts. An artboard can hold one `<script type="ponzu/act">`: a short
 * list of beats (move the cursor, click, type, show a toast, roll a total)
 * that plays the artboard's own HTML as a product demo. It never runs as code.
 * Ponzu reads it when the board renders, measures the board, and turns every
 * beat into Web Animations: one per animated property of each element, all on
 * one timeline the length of the scene. So a scene pauses and seeks like any
 * CSS animation. The canvas plays it, screenshot shows its poster frame,
 * record films it beat by beat, and loop.ts films it for boards drawn small.
 *
 * States are the design's own CSS. The cursor hovering a button turns on its
 * :hover rules, a press its :active ones, typing its :focus ones, and `set`
 * adds any attribute or class. Ponzu toggles each state for a moment while it
 * compiles, reads what changes and with which transition, and animates that.
 *
 * Both functions are serialized with toString to run in render pages, so
 * neither may reference anything outside itself: actRuntime gets actCore's
 * result as its argument. get_guide('act') in @ponzu/tools is the language.
 */

/** A problem with a scene, in lint's shape. */
export interface ActIssue {
  id: string;
  kind: "act";
  message: string;
}

/** One beat as it landed on the timeline. */
export interface ActBeat {
  /** Line in the script, from 1. */
  line: number;
  text: string;
  start: number;
  end: number;
}

/** What a compiled scene is, for MotionInfo and the tools. */
export interface ActSummary {
  /** The whole scene, in ms: one cycle when it loops. */
  duration: number;
  loop: boolean;
  /** The frame that tells the story on its own: screenshots and pictures show it. */
  poster: number;
  beats: ActBeat[];
  /** How many animations it made. */
  animations: number;
}

/** A parsed line. */
export interface ActLine {
  line: number;
  text: string;
  verb: string;
  args: string[];
  opts: Record<string, string>;
  /** Starts with the beat before it (`&`), instead of after it. */
  with: boolean;
}

export interface ActScript {
  loop: boolean;
  lines: ActLine[];
  issues: { line: number; message: string }[];
}

/**
 * The pure half: parsing, curves, timing and keyframes. No DOM, so it's
 * tested on its own and handed to actRuntime in the page.
 */
export function actCore() {
  /** Named curves. The first six are measured from product launch films (Stageshow's ease.ts). */
  const CURVES: Record<string, string> = {
    house: "cubic-bezier(0.65, 0, 0.1, 1)",
    through: "cubic-bezier(0.8, 0, 0.1, 1)",
    settle: "cubic-bezier(0.05, 0.85, 0.3, 1)",
    enter: "cubic-bezier(0.1, 0.8, 0.3, 0.95)",
    trip: "cubic-bezier(0.78, 0, 0.17, 1)",
    camera: "cubic-bezier(0.45, 0, 0.1, 1)",
    out: "cubic-bezier(0.22, 1, 0.36, 1)",
    in: "cubic-bezier(0.55, 0, 1, 0.45)",
    inout: "cubic-bezier(0.65, 0, 0.35, 1)",
  };
  const NAMED: Record<string, [number, number, number, number]> = {
    ease: [0.25, 0.1, 0.25, 1],
    "ease-in": [0.42, 0, 1, 1],
    "ease-out": [0, 0, 0.58, 1],
    "ease-in-out": [0.42, 0, 0.58, 1],
  };
  const VERBS = new Set([
    "loop",
    "once",
    "cursor",
    "move",
    "hover",
    "enter",
    "click",
    "tap",
    "drag",
    "swipe",
    "type",
    "stream",
    "key",
    "show",
    "hide",
    "set",
    "unset",
    "focus",
    "blur",
    "count",
    "slide",
    "zoom",
    "scroll",
    "wait",
    "poster",
    "reset",
  ]);

  /** A curve name, or any CSS easing as it is. */
  function curve(name: string | undefined, fallback: string): string {
    if (!name) return fallback;
    return CURVES[name] ?? name;
  }

  /** "400", "400ms", "1.2s" in ms; null when it isn't a time. */
  function ms(v: string | undefined): number | null {
    if (v === undefined) return null;
    const m = /^(-?\d*\.?\d+)(ms|s)?$/.exec(v.trim());
    if (!m) return null;
    return m[2] === "s" ? Number(m[1]) * 1000 : Number(m[1]);
  }

  /** A CSS easing as a function of progress, for sampling a path the way CSS would. */
  function easer(css: string): (t: number) => number {
    let p = NAMED[css.trim()];
    const m = /^cubic-bezier\(([^)]+)\)$/.exec(css.trim());
    if (m) {
      const n = m[1]!.split(",").map(Number);
      if (n.length === 4 && n.every(Number.isFinite)) p = n as [number, number, number, number];
    }
    if (!p) return (t) => t;
    const [x1, y1, x2, y2] = p;
    const cx = 3 * x1;
    const bx = 3 * (x2 - x1) - cx;
    const ax = 1 - cx - bx;
    const cy = 3 * y1;
    const by = 3 * (y2 - y1) - cy;
    const ay = 1 - cy - by;
    const x = (u: number) => ((ax * u + bx) * u + cx) * u;
    const dx = (u: number) => (3 * ax * u + 2 * bx) * u + cx;
    return (t) => {
      if (t <= 0) return 0;
      if (t >= 1) return 1;
      let u = t;
      for (let i = 0; i < 8; i++) {
        const d = dx(u);
        if (Math.abs(d) < 1e-6) break;
        const next = u - (x(u) - t) / d;
        if (next < 0 || next > 1) break;
        u = next;
      }
      if (Math.abs(x(u) - t) > 1e-6) {
        let lo = 0;
        let hi = 1;
        for (let i = 0; i < 40; i++) {
          u = (lo + hi) / 2;
          if (x(u) < t) lo = u;
          else hi = u;
        }
      }
      return ((ay * u + by) * u + cy) * u;
    };
  }

  /**
   * Split a line into words. Quotes group words and go; inside [brackets]
   * and (parens) everything stays as written, quotes and spaces too, so
   * `[data-name="Invite button"]` is one selector. `//` starts a comment.
   */
  function words(line: string): string[] {
    const out: string[] = [];
    let i = 0;
    const n = line.length;
    while (i < n) {
      while (i < n && /\s/.test(line[i]!)) i++;
      if (i >= n || line.startsWith("//", i)) break;
      let tok = "";
      let depth = 0;
      while (i < n && (depth > 0 || !/\s/.test(line[i]!))) {
        const c = line[i]!;
        if (c === '"' || c === "'") {
          const close = line.indexOf(c, i + 1);
          const end = close < 0 ? n : close;
          tok += depth > 0 ? line.slice(i, end + 1) : line.slice(i + 1, end);
          i = end + 1;
          continue;
        }
        if (c === "[" || c === "(") depth++;
        else if ((c === "]" || c === ")") && depth > 0) depth--;
        tok += c;
        i++;
      }
      out.push(tok);
    }
    return out;
  }

  /** The script's lines as beats, and what it couldn't read. */
  function parse(text: string): ActScript {
    const lines: ActLine[] = [];
    const issues: { line: number; message: string }[] = [];
    let loop = true;
    const rows = text.split(/\r?\n/);
    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i]!.trim();
      if (!raw || raw.startsWith("//")) continue;
      let ws = words(raw);
      let together = false;
      if (ws[0] === "&") {
        together = true;
        ws = ws.slice(1);
      } else if (ws[0]?.startsWith("&")) {
        together = true;
        ws[0] = ws[0].slice(1);
      }
      const verb = (ws[0] ?? "").toLowerCase();
      if (!verb) continue;
      if (!VERBS.has(verb)) {
        issues.push({ line: i + 1, message: `"${ws[0]}" isn't a beat` });
        continue;
      }
      if (verb === "loop" || verb === "once") {
        loop = verb === "loop";
        continue;
      }
      const args: string[] = [];
      const opts: Record<string, string> = {};
      for (const w of ws.slice(1)) {
        const m = /^([a-z][\w-]*)=(.*)$/i.exec(w);
        if (m) opts[m[1]!.toLowerCase()] = m[2]!;
        else args.push(w);
      }
      lines.push({
        line: i + 1,
        text: raw.replace(/\s+\/\/.*$/, ""),
        verb,
        args,
        opts,
        with: together,
      });
    }
    return { loop, lines, issues };
  }

  /** A seeded random in [0, 1): the same scene types the same way every time. */
  function random(seed: string): () => number {
    let h = 1779033703 ^ seed.length;
    for (let i = 0; i < seed.length; i++) {
      h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    let a = h >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * When each of `units` appears, in ms from the start: a hand typing (or a
   * model streaming) at about `each` ms apiece, unevenly, slower after a space
   * or a stop. The last unit lands at the returned total.
   */
  function cadence(units: string[], each: number, seed: string): number[] {
    const r = random(seed);
    const out: number[] = [];
    let t = 0;
    for (let i = 0; i < units.length; i++) {
      out.push(Math.round(t));
      const u = units[i]!;
      const pause = /[.!?,;:]\s*$/.test(u) ? 2.6 : /\s$/.test(u) ? 1.4 : 1;
      t += each * pause * (0.6 + r() * 0.8);
    }
    return out;
  }

  /**
   * A hand's path from `a` to `b`: a shallow arc, bowed to one side, sampled
   * along `ease` at even times. Each point's `t` is a fraction of the move.
   */
  function arc(
    a: { x: number; y: number },
    b: { x: number; y: number },
    ease: string,
    bow: number,
    samples: number,
  ): { t: number; x: number; y: number }[] {
    const e = easer(ease);
    const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = -(b.y - a.y) / dist;
    const ny = (b.x - a.x) / dist;
    const out: { t: number; x: number; y: number }[] = [];
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const p = e(t);
      const lift = Math.sin(Math.PI * p) * bow;
      out.push({ t, x: a.x + (b.x - a.x) * p + nx * lift, y: a.y + (b.y - a.y) * p + ny * lift });
    }
    return out;
  }

  /**
   * Characters aligned from the right, each position rolling from its old
   * character to its new one. A position only one side has is "" on the other:
   * a digit that arrives or leaves.
   */
  function columns(from: string, to: string): { from: string; to: string }[] {
    const a = [...from];
    const b = [...to];
    const n = Math.max(a.length, b.length);
    return Array.from({ length: n }, (_, i) => ({
      from: a[a.length - n + i] ?? "",
      to: b[b.length - n + i] ?? "",
    }));
  }

  /** "cmd+shift+k" as keycaps. */
  function caps(combo: string): string[] {
    const GLYPHS: Record<string, string> = {
      cmd: "⌘",
      command: "⌘",
      meta: "⌘",
      shift: "⇧",
      opt: "⌥",
      option: "⌥",
      alt: "⌥",
      ctrl: "⌃",
      control: "⌃",
      enter: "↩",
      return: "↩",
      tab: "⇥",
      esc: "esc",
      escape: "esc",
      space: "space",
      backspace: "⌫",
      delete: "⌫",
      up: "↑",
      down: "↓",
      left: "←",
      right: "→",
    };
    return combo
      .split("+")
      .filter(Boolean)
      .map((k) => GLYPHS[k.toLowerCase()] ?? (k.length === 1 ? k.toUpperCase() : k));
  }

  /**
   * One property's keyframes over a scene of `total` ms: its first value,
   * then each change as a pair of keyframes (where it leaves, eased; where it
   * lands), holding between. A change that takes no time is two keyframes at
   * one offset, which is a jump. Segments must be in order and not overlap.
   */
  function frames(
    initial: string,
    segs: { t0: number; t1: number; from: string; to: string; ease: string }[],
    total: number,
  ): { offset: number; value: string; easing: string }[] {
    const out = [{ offset: 0, value: initial, easing: "linear" }];
    const at = (t: number) => Math.min(1, Math.max(out[out.length - 1]!.offset, t / total));
    const push = (offset: number, value: string, easing: string) => {
      const last = out[out.length - 1]!;
      if (last.offset === offset && last.value === value) {
        last.easing = easing;
        return;
      }
      out.push({ offset, value, easing });
    };
    let last = initial;
    for (const s of segs) {
      const o0 = at(s.t0);
      if (s.from !== last) push(o0, last, "linear");
      push(o0, s.from, s.ease);
      push(at(s.t1), s.to, "linear");
      last = s.to;
    }
    if (out[out.length - 1]!.offset < 1) push(1, last, "linear");
    return out;
  }

  return { CURVES, curve, ms, easer, words, parse, random, cadence, arc, columns, caps, frames };
}

/**
 * The DOM half. Installs `window.__ponzuAct`: `mount(section)` compiles the
 * artboard's scene into animations that play at once (the canvas) or that
 * the caller pauses (render pages, through motion.ts).
 */
export function actRuntime(core: ReturnType<typeof actCore>) {
  type El = Element;
  type Pt = { x: number; y: number };
  type Box = { x: number; y: number; width: number; height: number };
  type Seg = {
    t0: number;
    t1: number;
    to: string;
    from?: string;
    ease: string;
    order: number;
  };
  type Track = {
    el: El;
    pseudo: string;
    prop: string;
    initial: string | null;
    /** Its value in the scene's first state, when a state sets it. */
    stateInitial?: string;
    segs: Seg[];
  };
  type StateEvent = { t: number; el: El; attr: string; value: string | null; order: number };
  type Plan = {
    tracks: Map<string, Track>;
    states: StateEvent[];
    total: number;
    loop: boolean;
    poster: number;
    reset: { at: number; dur: number } | null;
    beats: ActBeat[];
  };
  type Handle = {
    animations: Animation[];
    summary: ActSummary;
    issues: ActIssue[];
    cancel(): void;
    /** Compile again (fonts or images changed the layout), keeping the time and whether it plays. */
    rebuild(): void;
  };

  const w = window as any;
  if (w.__ponzuAct) return;
  /** What set and unset may change: looks, never behavior. */
  const STATE_BOOLEANS = "open, hidden, disabled, checked, selected or inert";
  const STATE_ATTR =
    /^(\.[A-Za-z_][\w-]*|data-(?!id$|artboard$)[\w-]+|aria-[\w-]+|open|hidden|disabled|checked|selected|inert)$/;
  const ID = "ponzu-act";
  const handles = new WeakMap<El, Handle>();
  const rewrittenRules = new WeakSet<CSSRule>();
  let order = 0;

  const SVG = (body: string, size: number, box = "0 0 32 32") =>
    `<svg width="${size}" height="${size}" viewBox="${box}" fill="none" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
  // macOS cursors as Stageshow draws them (MIT, Benji Taylor; THIRD_PARTY_NOTICES.md), hotspots
  // in each glyph's own box.
  const RESIZE_TIP = "M0-8.4 2.55-3.65H-2.55ZM0 8.4 2.55 3.65H-2.55Z";
  const resize = (turn: number) =>
    SVG(
      `<g transform="rotate(${turn})" stroke-linejoin="round"><path d="${RESIZE_TIP}" fill="#fff" stroke="#fff" stroke-width="3.2"/><path d="${RESIZE_TIP}" fill="#000" stroke="#000" stroke-width="1.2"/></g>`,
      21,
      "-14 -14 28 28",
    );
  const GLYPHS: Record<string, { svg: string; hot: Pt }> = {
    arrow: {
      svg: SVG(
        '<g transform="translate(10 7)"><path d="m6.148 18.473 1.863-1.003 1.615-.839-2.568-4.816h4.332l-11.379-11.408v16.015l3.316-3.221z" fill="#fff"/><path d="m6.431 17 1.765-.941-2.775-5.202h3.604l-8.025-8.043v11.188l2.53-2.442z" fill="#000"/></g>',
        24,
      ),
      hot: { x: 7.5, y: 5.25 },
    },
    hand: {
      svg: SVG(
        '<path d="M10.6 6a1.7 1.7 0 0 1 3.4 0v6.6a1.3 1.3 0 0 1 2.6 0v.7a1.3 1.3 0 0 1 2.6 0v.7a1.3 1.3 0 0 1 2.6 0V19c0 3.1-2 5.6-5 5.6h-2.6c-2 0-3.3-.9-4.4-2.4l-3.1-4.1c-.6-.9-.4-2 .5-2.5.8-.4 1.7-.2 2.3.5l1.1 1.4V6Z" fill="#fff" stroke="#000" stroke-width="1.1" stroke-linejoin="round"/><path d="M14 12.6v3.6M16.6 13.3v3M19.2 14v2.6" stroke="#000" stroke-width="1" stroke-linecap="round"/>',
        26,
      ),
      hot: { x: 9.75, y: 3.25 },
    },
    ibeam: {
      svg: `<svg width="10" height="16" viewBox="0 0 10 16" fill="none" overflow="visible" xmlns="http://www.w3.org/2000/svg"><path d="M3 1H7M3 15H7M5 1V15" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/><path d="M3 1H7M3 15H7M5 1V15" stroke="#000" stroke-width="1" stroke-linecap="round"/></svg>`,
      hot: { x: 5, y: 8 },
    },
    crosshair: {
      svg: `<svg width="17" height="17" viewBox="0 0 17 17" fill="none" overflow="visible" xmlns="http://www.w3.org/2000/svg"><path d="M8.5 0V17M0 8.5H17" stroke="#fff" stroke-width="2.6"/><path d="M8.5 0V17M0 8.5H17" stroke="#000" stroke-width="1"/></svg>`,
      hot: { x: 8.5, y: 8.5 },
    },
    open: {
      svg: SVG(
        '<path d="M11 15.5V8.4a1.4 1.4 0 0 1 2.8 0v5.4V6.9a1.4 1.4 0 0 1 2.8 0v6.9V7.6a1.4 1.4 0 0 1 2.8 0v6.6V9.9a1.4 1.4 0 0 1 2.8 0v8.4c0 3.6-2.4 6.2-5.8 6.2h-1.7c-2.1 0-3.5-.8-4.7-2.4l-3.4-4.5c-.6-.8-.5-1.9.3-2.4.8-.5 1.8-.3 2.4.4l2 2.3" fill="#fff" stroke="#000" stroke-width="1.1" stroke-linejoin="round" stroke-linecap="round"/>',
        26,
      ),
      hot: { x: 11.7, y: 10.4 },
    },
    grab: {
      svg: SVG(
        '<path d="M11.2 13.3c0-1 .7-1.6 1.5-1.6s1.4.6 1.4 1.4v-.6c0-.9.6-1.5 1.4-1.5s1.4.6 1.4 1.5v.4c0-.9.6-1.5 1.4-1.5s1.4.6 1.4 1.5v.6c0-.8.6-1.4 1.4-1.4s1.3.6 1.3 1.4v4.6c0 3.3-2.3 5.8-5.6 5.8h-1.9c-2 0-3.3-.8-4.4-2.3l-1.6-2.3c-.5-.8-.4-1.8.4-2.3.7-.4 1.6-.3 2.1.4l.5.7Z" fill="#fff" stroke="#000" stroke-width="1.1" stroke-linejoin="round"/><path d="M14.1 13.2v2.2M16.9 13v2.4M19.7 13.2v2.2" stroke="#000" stroke-width="1" stroke-linecap="round"/>',
        30,
      ),
      hot: { x: 15, y: 15 },
    },
    "resize-ns": { svg: resize(0), hot: { x: 10.5, y: 10.5 } },
    "resize-ew": { svg: resize(90), hot: { x: 10.5, y: 10.5 } },
    "resize-nwse": { svg: resize(-45), hot: { x: 10.5, y: 10.5 } },
    "resize-nesw": { svg: resize(45), hot: { x: 10.5, y: 10.5 } },
    solid: {
      svg: `<svg width="22" height="22" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg"><path d="M4 3 18.5 9.6 11.8 11.8 9.6 18.5Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round" paint-order="stroke"/></svg>`,
      hot: { x: 4, y: 3 },
    },
  };

  /** The cursor's and its helpers' look. States are attributes, eased by transitions: the same engine as the design's own. */
  const LAYER_CSS = `
[data-act-layer]{position:absolute;inset:0;pointer-events:none;z-index:2147483000;overflow:visible;color-scheme:light}
[data-act-cursor]{position:absolute;left:0;top:0;width:0;height:0;--act-size:1;transition:opacity .25s ease}
[data-act-cursor][data-act-off]{opacity:0}
[data-act-dip]{position:absolute;left:0;top:0;transform-origin:0 0;scale:var(--act-size);transition:transform .26s cubic-bezier(.22,1,.36,1)}
[data-act-cursor][data-act-pressed] [data-act-dip]{transform:scale(.9);transition:transform .08s ease-out}
[data-act-glyph]{position:absolute;display:block;opacity:0;scale:.5;filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.28));transition:opacity .16s ease,scale .2s cubic-bezier(.22,1,.36,1)}
[data-act-glyph] svg{display:block}
${Object.keys(GLYPHS)
  .filter((k) => k !== "solid")
  .map(
    (k) =>
      `[data-act-cursor][data-act-style=mac][data-act-kind=${k}] [data-act-glyph=${k}]{opacity:1;scale:1}`,
  )
  .join("\n")}
[data-act-cursor][data-act-style=arrow]:not([data-act-kind=ibeam]) [data-act-glyph=solid]{opacity:1;scale:1}
[data-act-cursor][data-act-style=arrow][data-act-kind=ibeam] [data-act-glyph=ibeam]{opacity:1;scale:1}
[data-act-cursor][data-act-kind=grab] [data-act-glyph=open],[data-act-cursor][data-act-kind=open] [data-act-glyph=grab]{transition:opacity .08s linear}
[data-act-dot]{position:absolute;left:-17px;top:-17px;width:34px;height:34px;border-radius:50%;background:rgba(118,118,128,.16);box-shadow:inset 0 0 0 1px rgba(255,255,255,.35),0 2px 10px rgba(0,0,0,.1);opacity:0;scale:.7;transition:opacity .4s ease,scale .45s cubic-bezier(.22,1,.36,1),background-color .1s ease}
[data-act-cursor][data-act-style=touch][data-act-touching] [data-act-dot]{opacity:1;scale:1;transition:opacity .14s ease,scale .16s cubic-bezier(.22,1,.36,1)}
[data-act-cursor][data-act-style=touch][data-act-pressed] [data-act-dot]{background-color:rgba(118,118,128,.26);scale:.84;transition:background-color .08s ease,scale .1s ease-out}
[data-act-ripple]{position:absolute;left:-14px;top:-14px;width:28px;height:28px;border-radius:50%;border:2px solid rgba(70,110,255,.55);opacity:0}
[data-act-caret]{position:absolute;left:0;top:0;width:2px;border-radius:1px;opacity:0}
[data-act-keys]{position:absolute;left:0;right:0;display:flex;justify-content:center;gap:6px;opacity:0}
[data-act-keys][data-at=bottom]{bottom:22px}
[data-act-keys][data-at=top]{top:22px}
[data-act-cap]{min-width:34px;height:34px;padding:0 10px;border-radius:9px;background:#fff;color:#1d1d1f;font:500 15px/34px -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;text-align:center;box-shadow:0 0 0 .5px rgba(0,0,0,.14),0 1px 0 rgba(0,0,0,.1),0 6px 18px rgba(0,0,0,.14)}
`;

  const camel = (p: string) =>
    p.startsWith("--")
      ? p
      : p === "float"
        ? "cssFloat"
        : p === "offset"
          ? "cssOffset"
          : p.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  const idOf = (el: El | null | undefined) =>
    el?.closest("[data-id]")?.getAttribute("data-id") ?? "";
  const round = (n: number) => Math.round(n * 10) / 10;
  const px = (n: number) => `${round(n)}px`;

  /** Split on commas outside parentheses. */
  function splitTop(s: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let cur = "";
    for (const c of s) {
      if (c === "(") depth++;
      else if (c === ")") depth--;
      if (c === "," && depth === 0) {
        out.push(cur.trim());
        cur = "";
      } else cur += c;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  /** Every style rule a scope's sheets hold, nested ones too. */
  function rulesOf(scope: Document | ShadowRoot): CSSStyleRule[] {
    const out: CSSStyleRule[] = [];
    const walk = (rules: CSSRuleList) => {
      for (const r of [...rules]) {
        if (r instanceof CSSStyleRule) out.push(r);
        if ("cssRules" in r && (r as CSSGroupingRule).cssRules)
          walk((r as CSSGroupingRule).cssRules);
      }
    };
    for (const sheet of [...scope.styleSheets]) {
      try {
        walk(sheet.cssRules);
      } catch {
        // Cross-origin sheets (Google Fonts) have no states.
      }
    }
    return out;
  }

  /** :hover, :active and :focus rules also match the attributes a scene sets. */
  function rewriteStates(scope: Document | ShadowRoot) {
    const pattern = /:(hover|active|focus-visible|focus-within|focus)(?![\w-])/g;
    const alt: Record<string, string> = {
      hover: "[data-act-hover]",
      active: "[data-act-pressed]",
      focus: "[data-act-focus]",
      "focus-visible": "[data-act-focus]",
      "focus-within": "[data-act-focus],:has([data-act-focus])",
    };
    for (const rule of rulesOf(scope)) {
      if (rewrittenRules.has(rule)) continue;
      rewrittenRules.add(rule);
      if (!pattern.test(rule.selectorText)) continue;
      pattern.lastIndex = 0;
      rule.selectorText = rule.selectorText.replace(
        pattern,
        (_, s: string) => `:is(:${s},${alt[s]})`,
      );
      pattern.lastIndex = 0;
    }
  }

  /** The cursor kind a target shows: data-cursor, else its CSS cursor. */
  function kindOf(el: El | null, style: string): string {
    if (!el) return "arrow";
    const named = el.closest("[data-cursor]")?.getAttribute("data-cursor");
    const css = named ?? getComputedStyle(el).cursor;
    const map: Record<string, string> = {
      pointer: "hand",
      hand: "hand",
      text: "ibeam",
      "vertical-text": "ibeam",
      ibeam: "ibeam",
      grab: "open",
      open: "open",
      grabbing: "grab",
      move: "open",
      crosshair: "crosshair",
      "ns-resize": "resize-ns",
      "row-resize": "resize-ns",
      "n-resize": "resize-ns",
      "s-resize": "resize-ns",
      "ew-resize": "resize-ew",
      "col-resize": "resize-ew",
      "e-resize": "resize-ew",
      "w-resize": "resize-ew",
      "nwse-resize": "resize-nwse",
      "nesw-resize": "resize-nesw",
    };
    const kind = map[css] ?? (GLYPHS[css] ? css : "arrow");
    return style === "arrow" && kind !== "ibeam" ? "arrow" : kind;
  }

  /** Elements a target names: a selector, or @Name for data-name. */
  function find(section: HTMLElement, target: string): El[] {
    let sel = target;
    if (target.startsWith("@")) sel = `[data-name="${CSS.escape(target.slice(1))}"]`;
    try {
      const all = [...section.querySelectorAll(sel)];
      return section.matches(sel) ? [section, ...all] : all;
    } catch {
      return [];
    }
  }

  function mount(section: HTMLElement): Handle | null {
    handles.get(section)?.cancel();
    handles.delete(section);
    const script = section.querySelector('script[type="ponzu/act"]');
    if (!script) return null;
    let current = compile(section, script.textContent ?? "");
    const handle: Handle = {
      get animations() {
        return current.animations;
      },
      get summary() {
        return current.summary;
      },
      get issues() {
        return current.issues;
      },
      cancel() {
        for (const a of current.animations) a.cancel();
        current.animations = [];
        if (handles.get(section) === handle) handles.delete(section);
      },
      rebuild() {
        const was = current.animations[0];
        const time = was ? Number(was.currentTime ?? 0) : 0;
        const paused = was ? was.playState === "paused" : false;
        const rate = was ? was.playbackRate : 1;
        for (const a of current.animations) a.cancel();
        current = compile(section, script.textContent ?? "");
        for (const a of current.animations) {
          a.currentTime = time;
          a.playbackRate = rate;
          if (paused) a.pause();
        }
      },
    };
    handles.set(section, handle);
    return handle;
  }

  function compile(
    section: HTMLElement,
    text: string,
  ): { animations: Animation[]; summary: ActSummary; issues: ActIssue[] } {
    const script = core.parse(text);
    const issues: ActIssue[] = [];
    const scriptId = idOf(section.querySelector('script[type="ponzu/act"]'));
    const issue = (line: number, message: string) =>
      issues.push({ id: scriptId, kind: "act", message: `line ${line}: ${message}` });
    for (const i of script.issues) issue(i.line, i.message);
    const scope = section.getRootNode() as Document | ShadowRoot;
    rewriteStates(scope);
    const bases = new Map<string, string>();
    const memo = new Map<El, unknown>();
    // Pass 1 measures the board as it is; pass 2 measures it as pass 1 says it looks at each moment.
    const first = schedule(section, script, null, bases, memo, () => {});
    const draft = build(finish(section, scope, first), first, true);
    const plan = schedule(section, script, draft, bases, memo, issue);
    for (const a of draft) a.cancel();
    const animations = build(finish(section, scope, plan), plan, false);
    return {
      animations,
      issues,
      summary: {
        duration: plan.total,
        loop: plan.loop,
        poster: plan.poster,
        beats: plan.beats,
        animations: animations.length,
      },
    };
  }

  /** The overlay the cursor, carets and keycaps live in, made once per board. */
  function layer(section: HTMLElement): HTMLElement {
    let el = section.querySelector<HTMLElement>(":scope > [data-act-layer]");
    if (el) return el;
    el = document.createElement("div");
    el.setAttribute("data-act-layer", "");
    el.setAttribute("aria-hidden", "true");
    const style = document.createElement("style");
    style.textContent = LAYER_CSS;
    el.appendChild(style);
    section.appendChild(el);
    return el;
  }

  function cursorEl(section: HTMLElement): HTMLElement {
    const host = layer(section);
    let el = host.querySelector<HTMLElement>("[data-act-cursor]");
    if (el) return el;
    el = document.createElement("div");
    el.setAttribute("data-act-cursor", "");
    el.setAttribute("data-act-style", "mac");
    el.setAttribute("data-act-kind", "arrow");
    const dip = document.createElement("div");
    dip.setAttribute("data-act-dip", "");
    for (const [name, g] of Object.entries(GLYPHS)) {
      const span = document.createElement("span");
      span.setAttribute("data-act-glyph", name);
      span.style.left = `${-g.hot.x}px`;
      span.style.top = `${-g.hot.y}px`;
      span.style.transformOrigin = `${g.hot.x}px ${g.hot.y}px`;
      span.innerHTML = g.svg;
      dip.appendChild(span);
    }
    const dot = document.createElement("span");
    dot.setAttribute("data-act-dot", "");
    dip.appendChild(dot);
    el.appendChild(dip);
    host.appendChild(el);
    return el;
  }

  /** A helper element made once per key (a caret, a ripple, a keycap row), so pass 2 reuses pass 1's. */
  function helper(section: HTMLElement, key: string, make: () => HTMLElement): HTMLElement {
    const host = layer(section);
    const found = [...host.children].find((c) => c.getAttribute("data-act-key") === key);
    if (found) return found as HTMLElement;
    const el = make();
    el.setAttribute("data-act-key", key);
    host.appendChild(el);
    return el;
  }

  /** Lay the beats on the timeline: what changes when, as tracks and state events. */
  function schedule(
    section: HTMLElement,
    script: ActScript,
    draft: Animation[] | null,
    bases: Map<string, string>,
    memo: Map<El, unknown>,
    issue: (line: number, message: string) => void,
  ): Plan {
    const tracks = new Map<string, Track>();
    const states: StateEvent[] = [];
    const beats: ActBeat[] = [];
    const k = section.getBoundingClientRect().width / (section.offsetWidth || 1) || 1;
    const W = section.clientWidth;
    const H = section.clientHeight;
    const CURVE_INOUT = core.CURVES.inout!;
    let presses = 0;

    /** The board at `t`, as the draft says it looks then. */
    const at = (t: number) => {
      if (draft) for (const a of draft) a.currentTime = t;
    };
    const box = (el: El, t: number): Box => {
      at(t);
      const r = el.getBoundingClientRect();
      const s = section.getBoundingClientRect();
      return {
        x: (r.left - s.left) / k - section.clientLeft,
        y: (r.top - s.top) / k - section.clientTop,
        width: r.width / k,
        height: r.height / k,
      };
    };
    const inside = (p: Pt, b: Box | null) =>
      !!b && p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
    const key = (el: El, pseudo: string, prop: string) => {
      let id = (el as any).__actKey as number | undefined;
      if (id === undefined) {
        id = ++order;
        (el as any).__actKey = id;
      }
      return `${id}|${pseudo}|${prop}`;
    };
    /** The element's value with nothing of the scene on it. Read in pass 1, before any draft exists. */
    const base = (el: El, prop: string, pseudo = ""): string => {
      const k_ = key(el, pseudo, prop);
      let v = bases.get(k_);
      if (v === undefined) {
        v = getComputedStyle(el, pseudo || null).getPropertyValue(prop);
        bases.set(k_, v);
      }
      return v;
    };
    /** Its height with nothing of the scene on it, read in pass 1 like base(). */
    const naturalHeight = (el: El): number => {
      const k_ = key(el, "", "act:height");
      let v = bases.get(k_);
      if (v === undefined) {
        v = String(draft ? box(el, 0).height : el.getBoundingClientRect().height / k);
        bases.set(k_, v);
      }
      return Number(v);
    };
    /** Its value at `t` as the draft has it (pass 1: as it is). */
    const now_ = (el: El, prop: string, t: number) => {
      at(t);
      return getComputedStyle(el).getPropertyValue(prop);
    };
    const change = (
      el: El,
      prop: string,
      t0: number,
      t1: number,
      to: string,
      ease = "linear",
      from?: string,
      pseudo = "",
    ) => {
      const k_ = key(el, pseudo, prop);
      let tr = tracks.get(k_);
      if (!tr) {
        tr = { el, pseudo, prop, initial: null, segs: [] };
        tracks.set(k_, tr);
      }
      tr.segs.push({ t0, t1: Math.max(t0, t1), to, from, ease, order: ++order });
    };
    const state = (t: number, el: El, attr: string, value: string | null) =>
      states.push({ t, el, attr, value, order: ++order });
    const translateOf = (el: El, t: number): Pt => {
      const v = now_(el, "translate", t).trim();
      if (!v || v === "none") return { x: 0, y: 0 };
      const [x, y] = v.split(/\s+/).map((s) => Number.parseFloat(s) || 0);
      return { x: x ?? 0, y: y ?? 0 };
    };

    // The cursor, as the beats leave it.
    let cursor: HTMLElement | null = null;
    let style = "mac";
    let pos: Pt | null = null;
    let kind = "arrow";
    let hovered: El[] = [];
    let hoverTarget: El | null = null;
    let focused: El | null = null;
    let ripple = false;
    let caret: { el: HTMLElement; from: number; color: string } | null = null;
    let keys: { el: HTMLElement; hide: number } | null = null;
    /** When the cursor last stopped acting, and whether it's out of the picture for resting. */
    let rested: number | null = null;
    let idle = false;
    const IDLE_MS = 4000;
    /** A cursor that rests 4s steps out of the shot, and comes back the moment it moves. */
    const wake = (t: number) => {
      if (rested !== null && !idle && t - rested > IDLE_MS && cursor) {
        state(rested + IDLE_MS, cursor, "data-act-off", "");
        idle = true;
      }
      if (idle && cursor) state(t, cursor, "data-act-off", null);
      idle = false;
    };
    const getCursor = () => {
      if (!cursor) {
        cursor = cursorEl(section);
        state(0, cursor, "data-act-style", style);
        state(0, cursor, "data-act-kind", "arrow");
      }
      return cursor;
    };
    const chain = (el: El | null): El[] => {
      const out: El[] = [];
      for (let n = el; n; n = n === section ? null : n.parentElement) out.push(n);
      return out;
    };
    const place = (p: Pt, t: number) => {
      const v = `${px(p.x)} ${px(p.y)}`;
      change(getCursor(), "translate", t, t, v, "linear", v);
      pos = p;
    };
    const setKind = (next: string, t: number) => {
      if (next === kind) return;
      kind = next;
      state(t, getCursor(), "data-act-kind", next);
    };
    const hover = (el: El | null, t: number) => {
      const next = chain(el);
      for (const n of hovered) if (!next.includes(n)) state(t, n, "data-act-hover", null);
      for (const n of next) if (!hovered.includes(n)) state(t, n, "data-act-hover", "");
      hovered = next;
      hoverTarget = el;
    };
    const focus = (el: El | null, t: number) => {
      if (focused === el) return;
      if (focused) state(t, focused, "data-act-focus", null);
      if (el) state(t, el, "data-act-focus", "");
      focused = el;
      closeCaret(t);
    };
    const closeCaret = (t: number) => {
      if (!caret) return;
      // Blinks while it waits, as a field's caret does: on half a second, off half.
      const c = caret;
      caret = null;
      for (let s = c.from + 530; s < t; s += 1060) {
        change(c.el, "opacity", s, s, "0");
        if (s + 530 < t) change(c.el, "opacity", s + 530, s + 530, "1");
      }
      change(c.el, "opacity", t, t, "0");
    };

    /** A point a target names: `x,y` in board px (or %), else an element's center, aimed by at=fx,fy. */
    const point = (
      target: string | undefined,
      opts: Record<string, string>,
      t: number,
      line: number,
    ): { p: Pt; el: El | null } | null => {
      if (!target) return null;
      const xy = /^(-?\d*\.?\d+)(%?),(-?\d*\.?\d+)(%?)$/.exec(target);
      if (xy) {
        const x = Number(xy[1]) * (xy[2] ? W / 100 : 1);
        const y = Number(xy[3]) * (xy[4] ? H / 100 : 1);
        return { p: { x, y }, el: null };
      }
      const el = find(section, target)[0];
      if (!el) {
        issue(line, `nothing matches ${target}`);
        return null;
      }
      const b = box(el, t);
      if (!b.width && !b.height) issue(line, `${target} isn't on screen at ${Math.round(t)}ms`);
      if (opts.at) {
        const [fx, fy] = opts.at.split(",").map(Number);
        return { p: { x: b.x + b.width * (fx ?? 0.5), y: b.y + b.height * (fy ?? 0.5) }, el };
      }
      // Aim inside the target but off its words, as a hand does: just past the end of a
      // label that fills its button, toward the right of a wide one, small ones in the middle.
      if (b.width < 48 || b.height > 72)
        return { p: { x: b.x + b.width / 2, y: b.y + b.height / 2 }, el };
      const words = document.createRange();
      words.selectNodeContents(el);
      const w_ = words.getBoundingClientRect();
      const s = section.getBoundingClientRect();
      const right = (w_.right - s.left) / k - section.clientLeft;
      const mid = (w_.top + w_.height / 2 - s.top) / k - section.clientTop;
      if (w_.width / k > b.width * 0.5 && right + 3 < b.x + b.width - 4)
        return { p: { x: right + 3, y: mid + 2 }, el };
      return { p: { x: b.x + b.width * 0.78, y: b.y + b.height * 0.62 }, el };
    };

    /**
     * Travel the cursor from where it is to `to`, starting at `t`: a hand's
     * shallow arc, or from past the nearest edge if it hasn't appeared yet.
     * Hover and the cursor's kind change where the path crosses edges.
     */
    const travel = (
      to: { p: Pt; el: El | null },
      t: number,
      opts: Record<string, string>,
      drag?: { carry: El | null; grip: Pt; offset: Pt },
    ): number => {
      getCursor();
      const toBox = to.el ? box(to.el, t) : null;
      let from = pos;
      let ease = core.curve(opts.ease, CURVE_INOUT);
      let dur: number;
      let bow: number;
      if (!from) {
        // Arrives from past the edge nearest its target, already moving.
        const out = 40;
        const gaps = [to.p.x, W - to.p.x, to.p.y, H - to.p.y];
        const side = gaps.indexOf(Math.min(...gaps));
        from =
          side === 0
            ? { x: -out, y: to.p.y + H * 0.12 }
            : side === 1
              ? { x: W + out, y: to.p.y + H * 0.12 }
              : side === 2
                ? { x: to.p.x - W * 0.06, y: -out }
                : { x: to.p.x + W * 0.06, y: H + out };
        place(from, t);
        ease = core.curve(opts.ease, core.CURVES.enter!);
        dur = core.ms(opts.dur) ?? 700;
        bow = 0;
      } else {
        const dist = Math.hypot(to.p.x - from.x, to.p.y - from.y);
        if (dist < 0.5) {
          if (!drag) {
            hover(to.el ?? hoverTarget, t);
            if (to.el) setKind(kindOf(to.el, style), t);
          }
          return t;
        }
        dur =
          core.ms(opts.dur) ??
          (drag
            ? Math.min(900, Math.max(450, 360 + dist * 1.1))
            : Math.min(650, Math.max(300, 260 + dist * 0.9)));
        bow = Math.min(dist * (drag ? 0.06 : 0.08), drag ? 18 : 24);
      }
      const fromBox = hoverTarget ? box(hoverTarget, t) : null;
      const samples = Math.max(8, Math.round(dur / 28));
      const path = core.arc(from, to.p, ease, bow, samples);
      const cur = getCursor();
      let entered = false;
      let left = !fromBox;
      if (!drag && !left && toBox && hoverTarget && to.el && hoverTarget.contains(to.el))
        left = true;
      for (const s of path) {
        const ts = t + s.t * dur;
        if (s.t > 0) change(cur, "translate", ts - dur / samples, ts, `${px(s.x)} ${px(s.y)}`);
        if (drag?.carry) {
          change(
            drag.carry,
            "translate",
            ts - (s.t > 0 ? dur / samples : 0),
            ts,
            `${px(drag.offset.x + s.x - drag.grip.x)} ${px(drag.offset.y + s.y - drag.grip.y)}`,
          );
        }
        if (drag) continue;
        if (!left && !inside(s, fromBox)) {
          left = true;
          hover(to.el && inside(s, toBox) ? to.el : null, ts);
          if (kind !== "arrow" && !inside(s, toBox)) setKind("arrow", ts);
        }
        if (!entered && to.el && inside(s, toBox)) {
          entered = true;
          hover(to.el, ts);
          setKind(kindOf(to.el, style), ts);
        }
      }
      const end = t + dur;
      if (!drag) {
        if (!entered) {
          hover(to.el ?? null, end);
          setKind(to.el ? kindOf(to.el, style) : "arrow", end);
        }
      }
      pos = to.p;
      return end;
    };
    /** A press where the cursor is: it dips, and what it's over takes :active. */
    const press = (t: number, hold: number, el: El | null, right = false) => {
      const cur = getCursor();
      const touch = style === "touch";
      if (touch) state(t - 140, cur, "data-act-touching", "");
      state(t, cur, "data-act-pressed", "");
      const pressed = chain(el);
      for (const n of pressed) state(t, n, "data-act-pressed", right ? "right" : "");
      state(t + hold, cur, "data-act-pressed", null);
      for (const n of pressed) state(t + hold, n, "data-act-pressed", null);
      if (touch) state(t + hold + 60, cur, "data-act-touching", null);
      if (ripple && pos) {
        const p = pos;
        const ring = helper(section, `ripple:${++presses}`, () => {
          const r = document.createElement("span");
          r.setAttribute("data-act-ripple", "");
          return r;
        });
        change(ring, "translate", t, t, `${px(p.x)} ${px(p.y)}`);
        change(ring, "opacity", t, t, "0.9");
        change(ring, "scale", t, t, "0.4");
        change(ring, "scale", t, t + 520, "1.7", core.CURVES.out!);
        change(ring, "opacity", t + 80, t + 520, "0", "ease-out");
      }
    };

    /** Where each character (or word) ends, inside the element: what a reveal uncovers, step by step. */
    const reveal = (el: El, byWord: boolean) => {
      const known = memo.get(el) as ReturnType<typeof measureText> | undefined;
      if (known && known.byWord === byWord) return known;
      const out = measureText(el, byWord);
      memo.set(el, out);
      return out;
    };
    const measureText = (target: El, byWord: boolean) => {
      const el = textHost(target);
      const own = el.getBoundingClientRect();
      // top and bottom bound the clip; glyphTop and glyphBottom are the letters', for the caret.
      const steps: {
        x: number;
        top: number;
        bottom: number;
        glyphTop: number;
        glyphBottom: number;
        text: string;
      }[] = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
        const s = n.data;
        const parts = byWord ? (s.match(/\S+\s*|\s+/g) ?? []) : [...s];
        let i = 0;
        for (const part of parts) {
          const start = i;
          i += part.length;
          if (!part.trim()) {
            if (steps.length) steps[steps.length - 1]!.text += part;
            continue;
          }
          const end = start + part.trimEnd().length;
          range.setStart(n, end - 1);
          range.setEnd(n, end);
          const r = [...range.getClientRects()].pop();
          if (!r) continue;
          steps.push({
            x: (r.right - own.left) / k,
            top: (r.top - own.top) / k,
            bottom: (r.bottom - own.top) / k,
            glyphTop: (r.top - own.top) / k,
            glyphBottom: (r.bottom - own.top) / k,
            text: part,
          });
        }
      }
      // Each line's clip reaches halfway to its neighbors: room for ascenders and
      // descenders, none for the next line's tops.
      const lines = [...new Set(steps.map((s) => Math.round(s.top)))].sort((a, b) => a - b);
      const bottoms = new Map<number, number>();
      for (const s of steps) {
        const l = Math.round(s.top);
        bottoms.set(l, Math.max(bottoms.get(l) ?? s.bottom, s.bottom));
      }
      for (const s of steps) {
        const i = lines.indexOf(Math.round(s.top));
        const prev = lines[i - 1];
        const next = lines[i + 1];
        const bottom = bottoms.get(lines[i]!)!;
        s.top = prev === undefined ? s.top - 12 : (bottoms.get(prev)! + s.top) / 2;
        s.bottom = next === undefined ? bottom + 12 : (bottom + next) / 2;
      }
      return { host: el, steps, width: own.width / k, height: own.height / k, byWord };
    };
    /** The clip that shows everything up to `s`: whole lines above it, its line up to its end. */
    const clipTo = (s: { x: number; top: number; bottom: number }, width: number) => {
      const P = 12;
      return `polygon(${-P}px ${-P}px, ${px(width + P)} ${-P}px, ${px(width + P)} ${px(s.top)}, ${px(s.x)} ${px(s.top)}, ${px(s.x)} ${px(s.bottom)}, ${-P}px ${px(s.bottom)})`;
    };
    const HIDDEN_CLIP = "polygon(0px 0px, 0px 0px, 0px 0px, 0px 0px, 0px 0px, 0px 0px)";

    const PRESETS: Record<string, number> = {
      fade: 240,
      rise: 420,
      drop: 380,
      pop: 320,
      grow: 420,
      blur: 380,
      "from-left": 420,
      "from-right": 420,
    };
    /** Appear (or leave): the preset's look is the hidden end, the element's own look the shown one. */
    const appear = (
      el: El,
      show: boolean,
      preset: string,
      t: number,
      dur: number,
      ease: string,
    ) => {
      const opacity = base(el, "opacity") || "1";
      const t1 = t + dur;
      const fade = (fadeDur: number) => {
        if (show) change(el, "opacity", t, t + fadeDur, opacity, ease, "0");
        else change(el, "opacity", t, t + fadeDur, "0", ease);
      };
      if (preset === "grow") {
        const h = naturalHeight(el);
        const parent = el.parentElement;
        const pcs = parent ? getComputedStyle(parent) : null;
        const gap = pcs && /flex|grid/.test(pcs.display) ? Number.parseFloat(pcs.rowGap) || 0 : 0;
        const lead = gap && el.previousElementSibling ? -gap : 0;
        const props: [string, string, string][] = [
          ["height", "0px", px(h)],
          ["padding-top", "0px", base(el, "padding-top")],
          ["padding-bottom", "0px", base(el, "padding-bottom")],
          ["margin-top", px(lead), base(el, "margin-top")],
          ["margin-bottom", "0px", base(el, "margin-bottom")],
        ];
        const display = base(el, "display");
        if (show) {
          change(el, "display", t, t, display, "linear", "none");
          change(el, "overflow", t, t, "clip", "linear", base(el, "overflow"));
          for (const [p, hid, shown] of props) change(el, p, t, t1, shown, ease, hid);
          change(el, "overflow", t1, t1, base(el, "overflow"));
          change(el, "opacity", t + dur * 0.25, t1, opacity, ease, "0");
        } else {
          change(el, "overflow", t, t, "clip");
          change(el, "opacity", t, t + dur * 0.6, "0", ease);
          for (const [p, hid] of props)
            change(el, p, t, t1, hid, ease, p === "height" ? px(h) : undefined);
          change(el, "display", t1, t1, "none");
        }
        return;
      }
      const tr = translateOf(el, t);
      const shift: Record<string, Pt> = {
        rise: { x: 0, y: 10 },
        drop: { x: 0, y: -8 },
        "from-left": { x: -16, y: 0 },
        "from-right": { x: 16, y: 0 },
      };
      const d = shift[preset];
      if (d) {
        const hid = `${px(tr.x + d.x)} ${px(tr.y + d.y)}`;
        const here = `${px(tr.x)} ${px(tr.y)}`;
        if (show) change(el, "translate", t, t1, here, ease, hid);
        else change(el, "translate", t, t1, hid, ease);
      }
      if (preset === "pop") {
        const s = base(el, "scale");
        const shown = s && s !== "none" ? s : "1";
        if (show) change(el, "scale", t, t1, shown, ease, "0.94");
        else change(el, "scale", t, t1, "0.96", ease);
      }
      if (preset === "blur") {
        const f = base(el, "filter");
        const shown = f && f !== "none" ? f : "blur(0px)";
        if (show) change(el, "filter", t, t1, shown, ease, "blur(6px)");
        else change(el, "filter", t, t1, "blur(6px)", ease);
      }
      fade(preset === "fade" ? dur : Math.min(dur, 260));
    };

    let now = 0;
    let lastStart = 0;
    let poster: number | null = null;
    let reset: { at: number; dur: number } | null = null;
    const POINTER = new Set(["move", "hover", "enter", "click", "tap", "drag", "swipe", "scroll"]);
    for (const line of script.lines) {
      const { verb, args, opts } = line;
      const start = (line.with ? lastStart : now) + (core.ms(opts.delay) ?? 0);
      let end = start;
      // Where a beat that starts with this one (&) starts: a click's press, not its travel.
      let anchor = start;
      if (POINTER.has(verb) && pos) wake(start);
      const ease = (fallback: string) => core.curve(opts.ease, fallback);
      const targets = (i = 0) => {
        const t = args[i];
        if (!t) {
          issue(line.line, `${verb} needs a target`);
          return [];
        }
        const els = find(section, t);
        if (!els.length) issue(line.line, `nothing matches ${t}`);
        return els;
      };
      switch (verb) {
        case "cursor": {
          const cur = getCursor();
          for (const a of args) {
            if (a === "mac" || a === "arrow" || a === "touch") {
              style = a;
              state(start, cur, "data-act-style", a);
            } else if (a === "hide") state(start, cur, "data-act-off", "");
            else if (a === "show") state(start, cur, "data-act-off", null);
            else if (a === "ripple") ripple = true;
          }
          if (opts.size) cur.style.setProperty("--act-size", opts.size);
          const i = args.indexOf("at");
          if (i >= 0) {
            const to = point(args[i + 1], opts, start, line.line);
            if (to) {
              place(to.p, start);
              hover(to.el, start);
              setKind(kindOf(to.el, style), start);
            }
          }
          break;
        }
        case "move":
        case "hover":
        case "enter": {
          const to = point(args[0], opts, start, line.line);
          if (!to) break;
          if (verb === "enter") pos = null;
          // Aim where the target will be on arrival: it may be moving into place.
          const guess = travelTime(to.p);
          const there = point(args[0], opts, start + guess, line.line) ?? to;
          end = travel(there, start, opts);
          break;
        }
        case "click":
        case "tap": {
          let t = start;
          let el: El | null = hoverTarget;
          if (args[0]) {
            const to = point(args[0], opts, start, line.line);
            if (to) {
              const there = point(args[0], opts, start + travelTime(to.p), line.line) ?? to;
              const arrived = travel(there, start, opts);
              t = arrived > start ? arrived + 120 : start;
              el = to.el ?? hoverTarget;
            }
          }
          if (focused && el && !chain(el).includes(focused)) focus(null, t);
          anchor = t;
          const double = args.includes("double");
          const right = args.includes("right");
          press(t, double ? 80 : 100, el, right);
          end = t + (double ? 80 : 100);
          if (double) {
            press(end + 70, 80, el, right);
            end += 150;
          }
          break;
        }
        case "drag":
        case "swipe": {
          const toAt = args.indexOf("to");
          const fromT = toAt > 0 ? args[0] : undefined;
          const toT = toAt >= 0 ? args[toAt + 1] : args[0];
          let t = start;
          if (fromT) {
            const from = point(fromT, {}, start, line.line);
            if (from) {
              const arrived = travel(from, start, {});
              t = arrived > start ? arrived + 120 : start;
            }
          }
          const carrySel = opts.carry ?? (args.includes("carry") ? fromT : undefined);
          const carry = carrySel ? (find(section, carrySel)[0] ?? null) : null;
          if (carrySel && !carry) issue(line.line, `nothing matches ${carrySel}`);
          const to = point(toT, opts, t, line.line);
          if (!to || !pos) break;
          const grip = pos;
          anchor = t;
          const offset = carry ? translateOf(carry, t) : { x: 0, y: 0 };
          const before = kind;
          const closes =
            before !== "ibeam" && before !== "crosshair" && !before.startsWith("resize");
          const cur = getCursor();
          if (style === "touch") state(t - 140, cur, "data-act-touching", "");
          state(t, cur, "data-act-pressed", "");
          state(t + 90, cur, "data-act-pressed", null);
          if (closes) setKind("grab", t + 60);
          if (carry) state(t + 60, carry, "data-act-dragging", "");
          const pressed = chain(hoverTarget);
          for (const n of pressed) state(t, n, "data-act-pressed", "");
          const landed = travel(to, t + 110, opts, { carry, grip, offset });
          for (const n of pressed) state(landed, n, "data-act-pressed", null);
          if (carry) state(landed, carry, "data-act-dragging", null);
          if (style === "touch") state(landed + 60, cur, "data-act-touching", null);
          hover(to.el, landed);
          setKind(to.el ? kindOf(to.el, style) : closes ? "open" : before, landed);
          end = landed;
          break;
        }
        case "type":
        case "stream": {
          const el = targets()[0];
          if (!el) break;
          const word = verb === "stream";
          const { host, steps, width } = reveal(el, word);
          if (!steps.length) {
            issue(line.line, `${args[0]} has no text to ${verb}`);
            break;
          }
          const each = core.ms(opts.speed) ?? (word ? 45 : 38);
          // The first key lands a keystroke in, as a hand's does.
          const times = core
            .cadence(
              steps.map((s) => s.text),
              each,
              `${line.line}:${el.textContent}`,
            )
            .map((t) => t + (word ? 0 : each));
          // A placeholder leaves on the first character, as a field's does.
          if (opts.placeholder)
            for (const p of find(section, opts.placeholder)) {
              const at = start + times[0]!;
              change(p, "opacity", at, at, "0");
            }
          closeCaret(start);
          if (!word) focus(el, start);
          const t0 = start + times[0]!;
          change(host, "clip-path", start, start, HIDDEN_CLIP, "linear", HIDDEN_CLIP);
          change(host, "clip-path", t0, t0, clipTo(steps[0]!, width));
          for (let i = 1; i < steps.length; i++) {
            const ts = start + times[i]!;
            change(host, "clip-path", ts, ts, clipTo(steps[i]!, width));
          }
          const last = start + times[times.length - 1]!;
          change(host, "clip-path", last + each, last + each, "none");
          end = last + each;
          if (!word && !args.includes("nocaret")) {
            const color = getComputedStyle(el).color;
            const c = helper(section, `caret:${line.line}`, () => {
              const s = document.createElement("span");
              s.setAttribute("data-act-caret", "");
              return s;
            });
            c.style.background = color;
            const origin = box(host, start);
            const lineH = steps[0]!.glyphBottom - steps[0]!.glyphTop;
            c.style.height = px(lineH);
            change(c, "opacity", start, start, "1");
            change(
              c,
              "translate",
              start,
              start,
              `${px(origin.x)} ${px(origin.y + steps[0]!.glyphTop)}`,
            );
            for (let i = 0; i < steps.length; i++) {
              const s = steps[i]!;
              const ts = start + times[i]!;
              change(
                c,
                "translate",
                ts,
                ts,
                `${px(origin.x + s.x + 1)} ${px(origin.y + s.glyphTop)}`,
              );
            }
            caret = { el: c, from: end, color };
          }
          break;
        }
        case "key": {
          const combo = args[0];
          if (!combo) {
            issue(line.line, "key needs keys, like cmd+k");
            break;
          }
          const where = opts.at === "top" ? "top" : "bottom";
          const group = helper(section, `keys:${line.line}`, () => {
            const g = document.createElement("div");
            g.setAttribute("data-act-keys", "");
            for (const cap of core.caps(combo)) {
              const c = document.createElement("span");
              c.setAttribute("data-act-cap", "");
              c.textContent = cap;
              g.appendChild(c);
            }
            return g;
          });
          group.setAttribute("data-at", where);
          if (keys && keys.hide > start) {
            change(keys.el, "opacity", start, start + 120, "0", "ease-in");
          }
          change(group, "opacity", start, start + 180, "1", core.CURVES.out!, "0");
          change(group, "translate", start, start + 180, "0px 0px", core.CURVES.out!, "0px 6px");
          change(group, "scale", start + 180, start + 240, "0.94", "ease-out", "1");
          change(group, "scale", start + 320, start + 460, "1", core.CURVES.out!);
          change(group, "opacity", start + 1100, start + 1300, "0", "ease-in");
          keys = { el: group, hide: start + 1100 };
          end = start + 320;
          break;
        }
        case "show":
        case "hide": {
          const els = targets();
          const preset = args.slice(1).find((a) => a in PRESETS) ?? "fade";
          const dur = core.ms(opts.dur) ?? PRESETS[preset]!;
          const gap = core.ms(opts.stagger) ?? (els.length > 1 ? 60 : 0);
          const curveFor =
            verb === "show" ? core.CURVES.out! : preset === "grow" ? CURVE_INOUT : "ease-in";
          els.forEach((el, i) => {
            appear(el, verb === "show", preset, start + i * gap, dur, ease(curveFor));
          });
          end = start + Math.max(0, els.length - 1) * gap + dur;
          break;
        }
        case "set":
        case "unset": {
          const els = targets();
          const names = args.slice(1);
          const asked: [string, string | null][] = names.map((n) => [n, ""]);
          for (const [kk, v] of Object.entries(opts))
            if (!["dur", "delay", "ease", "stagger"].includes(kk)) asked.push([kk, v]);
          // States only: a class, data-*, aria-* or a boolean. Never a handler, a URL or a
          // style, which would put something other than a look on the live page.
          const values = asked.filter(([name]) => {
            if (STATE_ATTR.test(name)) return true;
            issue(
              line.line,
              `${name} isn't a state; set takes a .class, data-*, aria-* or ${STATE_BOOLEANS}`,
            );
            return false;
          });
          if (!asked.length) issue(line.line, `${verb} needs an attribute or .class`);
          const gap = core.ms(opts.stagger) ?? 0;
          els.forEach((el, i) => {
            for (const [name, v] of values)
              state(start + i * gap, el, name, verb === "set" ? (v ?? "") : null);
          });
          end = start + Math.max(0, els.length - 1) * gap + (core.ms(opts.dur) ?? 0);
          break;
        }
        case "focus": {
          const el = targets()[0];
          if (el) focus(el, start);
          break;
        }
        case "blur":
          focus(null, start);
          break;
        case "count": {
          const els = targets();
          const fromAt = args.indexOf("from");
          const old = fromAt >= 0 ? args[fromAt + 1] : undefined;
          if (old === undefined) {
            issue(line.line, "count needs from <old value>, like count .total from $1,180");
            break;
          }
          const dur = core.ms(opts.dur) ?? 600;
          const gap = core.ms(opts.stagger) ?? 50;
          let last = start;
          for (const el of els) {
            const rolls = rollColumns(el, old);
            let n = 0;
            for (let i = rolls.length - 1; i >= 0; i--) {
              const r = rolls[i]!;
              if (!r) continue;
              const t0 = start + n * gap;
              if (Math.abs(r.from - r.to) > 0.5)
                change(
                  r.col,
                  "width",
                  t0,
                  t0 + dur,
                  px(r.to),
                  ease(core.CURVES.house!),
                  px(r.from),
                );
              change(
                r.strip,
                "translate",
                t0,
                t0 + dur,
                `0px ${px(-r.h)}`,
                ease(core.CURVES.house!),
                "0px 0px",
              );
              last = Math.max(last, t0 + dur);
              n++;
            }
          }
          end = last;
          break;
        }
        case "slide": {
          const els = targets();
          const toAt = args.indexOf("to");
          const byAt = args.indexOf("by");
          const dur = core.ms(opts.dur) ?? 520;
          const gap = core.ms(opts.stagger) ?? 0;
          els.forEach((el, i) => {
            const t = start + i * gap;
            const tr = translateOf(el, t);
            let d: Pt | null = null;
            if (byAt >= 0) {
              const [dx, dy] = (args[byAt + 1] ?? "").split(",").map(Number);
              d = { x: dx || 0, y: dy || 0 };
            } else if (toAt >= 0) {
              const dest = point(args[toAt + 1], opts, t, line.line);
              const b = box(el, t);
              if (dest)
                d = { x: dest.p.x - (b.x + b.width / 2), y: dest.p.y - (b.y + b.height / 2) };
            } else issue(line.line, "slide needs to <target> or by dx,dy");
            if (d)
              change(
                el,
                "translate",
                t,
                t + dur,
                `${px(tr.x + d.x)} ${px(tr.y + d.y)}`,
                ease(core.CURVES.house!),
              );
          });
          end = start + Math.max(0, els.length - 1) * gap + dur;
          break;
        }
        case "zoom": {
          const scene = targets()[0];
          if (!scene) break;
          const dur = core.ms(opts.dur) ?? 900;
          const out = args[1] === "out";
          let to = base(scene, "transform") || "none";
          if (!out) {
            const target = args[1] === "to" || args[1] === "on" ? args[2] : args[1];
            const el = target ? find(section, target)[0] : undefined;
            if (!el) {
              issue(line.line, `zoom needs to <target> or out`);
              break;
            }
            const sb = box(scene, start);
            const tb = box(el, start);
            const s =
              Number(opts.scale) ||
              Math.min(
                2.2,
                Math.max(1.1, 0.7 * Math.min(sb.width / tb.width, sb.height / tb.height)),
              );
            const qx = tb.x + tb.width / 2 - (sb.x + sb.width / 2);
            const qy = tb.y + tb.height / 2 - (sb.y + sb.height / 2);
            to = `translate(${px(-s * qx)}, ${px(-s * qy)}) scale(${round(s * 100) / 100})`;
          }
          change(scene, "transform", start, start + dur, to, ease(core.CURVES.camera!));
          end = start + dur;
          break;
        }
        case "scroll": {
          const content = targets()[0];
          if (!content) break;
          const viewport = content.parentElement ?? section;
          const toAt = args.indexOf("to");
          const where = toAt >= 0 ? args[toAt + 1] : args[1];
          const tr = translateOf(content, start);
          const vb = box(viewport, start);
          const cb = box(content, start);
          let delta = 0;
          const n = Number(where);
          if (where !== undefined && Number.isFinite(n)) delta = n - -tr.y;
          else if (where) {
            const el = find(section, where)[0];
            if (!el) issue(line.line, `nothing matches ${where}`);
            else delta = box(el, start).y - vb.y - (core.ms(opts.offset) ?? 0);
          }
          const max = Math.max(0, cb.height - vb.height);
          const y = Math.min(max, Math.max(0, -tr.y + delta));
          let t = start;
          // You can only scroll what the pointer is over: it moves into the area first.
          if (
            pos &&
            !inside(pos, { x: vb.x + 8, y: vb.y + 8, width: vb.width - 16, height: vb.height - 16 })
          ) {
            t =
              travel(
                { p: { x: vb.x + vb.width * 0.6, y: vb.y + vb.height * 0.55 }, el: viewport },
                start,
                {},
              ) + 120;
          }
          const dur =
            core.ms(opts.dur) ?? Math.min(1400, Math.max(500, 420 + Math.abs(y + tr.y) * 1.2));
          change(content, "translate", t, t + dur, `${px(tr.x)} ${px(-y)}`, ease(CURVE_INOUT));
          end = t + dur;
          break;
        }
        case "wait":
          end = start + (core.ms(args[0]) ?? 0);
          if (core.ms(args[0]) === null) issue(line.line, `wait needs a time, like wait 600`);
          break;
        case "poster":
          poster = start;
          break;
        case "reset": {
          const dur = core.ms(args[0]) ?? core.ms(opts.dur) ?? 700;
          closeCaret(start);
          reset = { at: start, dur };
          end = start + dur;
          break;
        }
      }
      if (POINTER.has(verb) && pos) rested = end;
      beats.push({ line: line.line, text: line.text, start: round(start), end: round(end) });
      if (!line.with) lastStart = anchor;
      now = Math.max(now, end);
    }
    const total = Math.max(1, Math.round(reset ? reset.at + reset.dur : now));
    if (rested !== null && cursor && !idle && (reset ? reset.at : total) - rested > IDLE_MS)
      state(rested + IDLE_MS, cursor, "data-act-off", "");
    closeCaret(reset ? reset.at : total);
    // A cursor the scene never put anywhere stays out of the picture.
    if (cursor && !pos) state(0, cursor, "data-act-off", "");
    const loop = script.loop;
    if (loop && !reset && script.lines.length)
      issue(
        script.lines[script.lines.length - 1]!.line,
        "the scene loops without a reset, so it snaps back to the start; end it with reset (or say once)",
      );
    const posterAt = poster ?? (reset ? reset.at : loop ? Math.max(0, total - 1) : total);
    return { tracks, states, total, loop, poster: round(posterAt), reset, beats };

    /** About how long a move to `p` takes, to aim where its target will be on arrival. */
    function travelTime(p: Pt): number {
      if (!pos) return 700;
      const dist = Math.hypot(p.x - pos.x, p.y - pos.y);
      return Math.min(650, Math.max(300, 260 + dist * 0.9));
    }
  }

  /**
   * What a reveal clips: the element, or, when it paints a box of its own (a
   * card, a bubble), a block around its contents, so the box stays and only
   * the words are uncovered. Made once per element.
   */
  function textHost(el: El): El {
    const made = (el as any).__actHost as El | undefined;
    if (made?.parentElement === el) return made;
    const cs = getComputedStyle(el);
    const paints =
      !/^(rgba\(0, 0, 0, 0\)|transparent)$/.test(cs.backgroundColor) ||
      cs.backgroundImage !== "none" ||
      cs.boxShadow !== "none" ||
      ["Top", "Right", "Bottom", "Left"].some(
        (s) =>
          Number.parseFloat((cs as any)[`border${s}Width`]) > 0 &&
          (cs as any)[`border${s}Style`] !== "none",
      );
    if (!paints) return el;
    const wrap = document.createElement("span");
    wrap.setAttribute("data-act-text", "");
    wrap.style.display = cs.display === "inline" ? "inline-block" : "block";
    while (el.firstChild) wrap.appendChild(el.firstChild);
    el.appendChild(wrap);
    (el as any).__actHost = wrap;
    return wrap;
  }

  /** A number's characters as columns that roll from `old` to what it says now. Made once per element. */
  type Roll = { col: HTMLElement; strip: HTMLElement; h: number; from: number; to: number };
  function rollColumns(el: El, old: string): (Roll | null)[] {
    const cached = (el as any).__actRoll as { old: string; cols: (Roll | null)[] } | undefined;
    if (cached && cached.old === old) return cached.cols;
    const next = (el as any).__actText ?? el.textContent ?? "";
    (el as any).__actText = next;
    const lineH = el.getBoundingClientRect().height || 16;
    const k = el.getBoundingClientRect().width / ((el as HTMLElement).offsetWidth || 1) || 1;
    const h = lineH / k;
    // Each character's width in this font, so a digit that arrives or leaves opens or closes its room.
    const probe = document.createElement("span");
    probe.style.whiteSpace = "pre";
    el.textContent = "";
    el.appendChild(probe);
    const widthOf = (ch: string) => {
      if (!ch) return 0;
      probe.textContent = ch;
      return probe.getBoundingClientRect().width / k;
    };
    const pairs = core
      .columns(old, next)
      .map((c) => ({ ...c, from_w: widthOf(c.from), to_w: widthOf(c.to) }));
    probe.remove();
    const cols = pairs.map((c) => {
      if (c.from === c.to) {
        el.appendChild(document.createTextNode(c.to));
        return null;
      }
      const col = document.createElement("span");
      col.setAttribute("data-act-roll", "");
      col.style.cssText = `display:inline-block;vertical-align:top;overflow:hidden;height:${h}px`;
      const strip = document.createElement("span");
      strip.style.cssText = "display:flex;flex-direction:column";
      for (const ch of [c.from, c.to]) {
        const s = document.createElement("span");
        s.style.height = `${h}px`;
        s.style.lineHeight = `${h}px`;
        s.style.whiteSpace = "pre";
        s.textContent = ch;
        strip.appendChild(s);
      }
      col.appendChild(strip);
      el.appendChild(col);
      return { col, strip, h, from: c.from_w, to: c.to_w };
    });
    (el as any).__actRoll = { old, cols };
    return cols;
  }

  /**
   * Turn the plan into tracks: read what each state changes (and with which
   * transition), add the reset, and settle where changes interrupt each other.
   */
  function finish(section: HTMLElement, scope: Document | ShadowRoot, plan: Plan): Track[] {
    const tracks = plan.tracks;
    stateTracks(section, scope, plan);
    const all = [...tracks.values()];
    for (const tr of all) {
      if (tr.initial === null) {
        // A track whose first change says where it starts from (a show, the cursor's first
        // place) starts there; the rest start as the board is.
        const first = [...tr.segs].sort((a, b) => a.t0 - b.t0 || a.order - b.order)[0];
        tr.initial =
          first?.from ??
          tr.stateInitial ??
          getComputedStyle(tr.el, tr.pseudo || null).getPropertyValue(tr.prop);
      }
    }
    for (const tr of all) settle(tr);
    if (plan.reset) {
      // Everything eases back to how the scene began. What's out of sight by then (faded
      // out, or closed) snaps back while nobody can see it, and only its opacity eases.
      const { at, dur } = plan.reset;
      const hidden = new Set<El>();
      for (const tr of all) {
        const v = valueAt(tr, at).trim();
        if ((tr.prop === "opacity" && Number(v) === 0) || (tr.prop === "display" && v === "none"))
          hidden.add(tr.el);
      }
      for (const tr of all) {
        const snap = hidden.has(tr.el) && tr.prop !== "opacity";
        tr.segs.push({
          t0: at,
          t1: snap ? at : at + dur,
          to: tr.initial!,
          ease: core.CURVES.inout!,
          order: ++order,
        });
        settle(tr);
      }
    }
    return all;
  }

  /** A settled track's value at `t`: where its last change before then landed. */
  function valueAt(tr: Track, t: number): string {
    let v = tr.initial!;
    for (const s of tr.segs) {
      if (s.t0 > t) break;
      v = s.to;
    }
    return v;
  }

  /** Where changes overlap, the later one starts from wherever the earlier had got to. */
  function settle(tr: Track) {
    tr.segs.sort((a, b) => a.t0 - b.t0 || a.order - b.order);
    let cur = tr.initial!;
    let prev: (Seg & { from: string }) | null = null;
    const out: (Seg & { from: string })[] = [];
    for (const s of tr.segs) {
      if (prev && s.t0 < prev.t1) {
        const p = (s.t0 - prev.t0) / (prev.t1 - prev.t0 || 1);
        cur = sample(tr, prev.from, prev.to, prev.ease, p);
        prev.t1 = s.t0;
        prev.to = cur;
      }
      const seg = { ...s, from: s.from ?? cur };
      out.push(seg);
      cur = seg.to;
      prev = seg;
    }
    tr.segs = out;
  }

  /** A property's value part way between two others, as the browser interpolates it. */
  function sample(tr: Track, from: string, to: string, ease: string, p: number): string {
    const prop = camel(tr.prop);
    try {
      const a = tr.el.animate([{ [prop]: from }, { [prop]: to }], {
        duration: 1000,
        easing: ease,
        fill: "both",
        pseudoElement: tr.pseudo || undefined,
      });
      a.pause();
      a.currentTime = Math.max(0, Math.min(1, p)) * 1000;
      const v = getComputedStyle(tr.el, tr.pseudo || null).getPropertyValue(tr.prop);
      a.cancel();
      return v;
    } catch {
      return p < 0.5 ? from : to;
    }
  }

  /**
   * The design's states, as tracks. Each moment a state changes, the board is
   * put in that state and read: every element a state rule could match, every
   * property those rules set, and the transition each property takes there.
   * Then everything goes back as it was.
   */
  function stateTracks(section: HTMLElement, scope: Document | ShadowRoot, plan: Plan) {
    if (!plan.states.length) return;
    const names = new Set(plan.states.map((s) => s.attr));
    const markers = [...names].map((n) =>
      n.startsWith(".") ? new RegExp(`\\.${CSS.escape(n.slice(1))}(?![\\w-])`) : n,
    );
    const rules = rulesOf(scope).filter(
      (r) =>
        r.selectorText.includes("data-act-") ||
        markers.some((m) =>
          typeof m === "string" ? r.selectorText.includes(`[${m}`) : m.test(r.selectorText),
        ),
    );
    if (!rules.length) return;
    const ALWAYS = [
      "opacity",
      "transform",
      "translate",
      "scale",
      "rotate",
      "color",
      "background-color",
      "border-top-color",
      "border-right-color",
      "border-bottom-color",
      "border-left-color",
      "box-shadow",
      "filter",
      "visibility",
      "display",
      "outline-color",
      "outline-style",
    ];
    // What each rule can match, and which properties it sets.
    const targets = rules.map((r) => {
      const parts = splitTop(r.selectorText);
      return parts.map((sel) => {
        const pseudo = /::(before|after)\b/.exec(sel)?.[0] ?? "";
        const clean = sel.replace(/::?(before|after|marker|placeholder|selection)(?![\w-])/g, "");
        const props = new Set<string>();
        for (let i = 0; i < r.style.length; i++) {
          const p = r.style[i]!;
          if (!/^(transition|animation)/.test(p)) props.add(p);
        }
        return { sel: clean || "*", pseudo, props };
      });
    });
    // The changes, in time order, grouped by moment. Those at the start are the initial state.
    const events = [...plan.states].sort((a, b) => a.t - b.t || a.order - b.order);
    const moments: { t: number; events: StateEvent[] }[] = [{ t: 0, events: [] }];
    for (const e of events) {
      const last = moments[moments.length - 1]!;
      if (e.t <= 0.5) moments[0]!.events.push(e);
      else if (Math.abs(last.t - e.t) < 0.5) last.events.push(e);
      else moments.push({ t: e.t, events: [e] });
    }
    // Put the board back exactly as it was afterwards.
    const original = new Map<El, Map<string, string | null>>();
    const apply = (e: StateEvent) => {
      let saved = original.get(e.el);
      if (!saved) {
        saved = new Map();
        original.set(e.el, saved);
      }
      if (e.attr.startsWith(".")) {
        const cls = e.attr.slice(1);
        if (!saved.has(e.attr)) saved.set(e.attr, e.el.classList.contains(cls) ? "" : null);
        e.el.classList.toggle(cls, e.value !== null);
        return;
      }
      if (!saved.has(e.attr)) saved.set(e.attr, e.el.getAttribute(e.attr));
      if (e.value === null) e.el.removeAttribute(e.attr);
      else e.el.setAttribute(e.attr, e.value);
    };
    const restore = () => {
      for (const [el, saved] of original) {
        for (const [attr, v] of saved) {
          if (attr.startsWith(".")) el.classList.toggle(attr.slice(1), v !== null);
          else if (v === null) el.removeAttribute(attr);
          else el.setAttribute(attr, v);
        }
      }
    };
    // First pass: everything any moment's rules match.
    const watched = new Map<string, { el: El; pseudo: string; props: Set<string> }>();
    const look = () => {
      targets.forEach((parts) => {
        for (const part of parts) {
          let els: El[];
          try {
            els = [...section.querySelectorAll(part.sel)];
            if (section.matches(part.sel)) els.push(section);
          } catch {
            continue;
          }
          for (const el of els) {
            if (watched.size >= 600) return;
            if ((el as any).__actKey === undefined) (el as any).__actKey = ++order;
            const id = `${(el as any).__actKey}|${part.pseudo}`;
            let w_ = watched.get(id);
            if (!w_) {
              w_ = { el, pseudo: part.pseudo, props: new Set(part.pseudo ? [] : ALWAYS) };
              watched.set(id, w_);
            }
            for (const p of part.props) w_.props.add(p);
          }
        }
      });
    };
    for (const m of moments) {
      for (const e of m.events) apply(e);
      look();
    }
    restore();
    // Second pass: the transition each watched element takes in each moment.
    const list = [...watched.values()];
    const reads: { values: string[]; transition: string[] }[][] = [];
    for (const m of moments) {
      for (const e of m.events) apply(e);
      reads.push(
        list.map((wt) => {
          const cs = getComputedStyle(wt.el, wt.pseudo || null);
          return {
            values: [],
            transition: [
              cs.transitionProperty,
              cs.transitionDuration,
              cs.transitionDelay,
              cs.transitionTimingFunction,
            ],
          };
        }),
      );
    }
    restore();
    // Third pass: the values. A state change starts the design's transition, and a value
    // read then is its first frame, so transitions are off while reading.
    const still = document.createElement("style");
    still.textContent = "*,*::before,*::after{transition:none!important}";
    (scope instanceof Document ? scope.head : scope).appendChild(still);
    moments.forEach((m, mi) => {
      for (const e of m.events) apply(e);
      list.forEach((wt, i) => {
        const cs = getComputedStyle(wt.el, wt.pseudo || null);
        reads[mi]![i]!.values = [...wt.props].map((p) => cs.getPropertyValue(p));
      });
    });
    // The board stays in the scene's first state: what never changes after it is drawn
    // by the board itself, not by an animation.
    restore();
    for (const e of moments[0]!.events) apply(e);
    void section.offsetHeight;
    still.remove();
    // Toggling started the design's own transitions; the scene plays them instead.
    for (const a of scope.getAnimations ? scope.getAnimations() : document.getAnimations()) {
      if ("transitionProperty" in a) {
        const t = (a.effect as KeyframeEffect | null)?.target;
        if (t && section.contains(t)) a.cancel();
      }
    }
    list.forEach((wt, i) => {
      const props = [...wt.props];
      props.forEach((prop, j) => {
        const first = reads[0]![i]!.values[j]!;
        let last = first;
        const segs: { t0: number; t1: number; to: string; ease: string }[] = [];
        for (let m = 1; m < moments.length; m++) {
          const v = reads[m]![i]!.values[j]!;
          if (v === last) continue;
          const [tp, td, tdl, tf] = reads[m]![i]!.transition;
          const timing = transitionFor(prop, tp!, td!, tdl!, tf!);
          const t0 = moments[m]!.t + timing.delay;
          segs.push({ t0, t1: t0 + timing.duration, to: v, ease: timing.ease });
          last = v;
        }
        if (!segs.length) return;
        const key = `${(wt.el as any).__actKey}|${wt.pseudo}|${prop}`;
        let tr = plan.tracks.get(key);
        if (!tr) {
          tr = { el: wt.el, pseudo: wt.pseudo, prop, initial: null, segs: [] };
          plan.tracks.set(key, tr);
        }
        tr.stateInitial = first;
        for (const s of segs) tr.segs.push({ ...s, order: ++order });
      });
    });
  }

  /** The transition a property takes, from computed transition lists. */
  function transitionFor(
    prop: string,
    props: string,
    durs: string,
    delays: string,
    eases: string,
  ): { duration: number; delay: number; ease: string } {
    const ps = splitTop(props);
    const ds = splitTop(durs);
    const dl = splitTop(delays);
    const es = splitTop(eases);
    const toMs = (v: string | undefined) => {
      if (!v) return 0;
      const n = Number.parseFloat(v);
      return v.trim().endsWith("ms") ? n : n * 1000;
    };
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i]!;
      const sides = /^border-(color|width|style)$/.exec(p);
      const matches =
        p === "all" ||
        p === prop ||
        prop.startsWith(`${p}-`) ||
        (sides && new RegExp(`^border-(top|right|bottom|left)-${sides[1]}$`).test(prop)) ||
        (p === "inset" && /^(top|right|bottom|left)$/.test(prop));
      if (!matches) continue;
      return {
        duration: toMs(ds[i % ds.length]),
        delay: toMs(dl[i % dl.length]),
        ease: es[i % es.length] ?? "ease",
      };
    }
    return { duration: 0, delay: 0, ease: "linear" };
  }

  /** One animation per animated property, all one scene long. */
  function build(tracks: Track[], plan: Plan, paused: boolean): Animation[] {
    const out: Animation[] = [];
    for (const tr of tracks) {
      if (!tr.segs.length) continue;
      const kf = core.frames(
        tr.initial!,
        tr.segs as { t0: number; t1: number; from: string; to: string; ease: string }[],
        plan.total,
      );
      if (kf.every((f) => f.value === kf[0]!.value)) continue;
      const prop = camel(tr.prop);
      try {
        const a = tr.el.animate(
          kf.map((f) => ({ offset: f.offset, easing: f.easing, [prop]: f.value })),
          {
            duration: plan.total,
            iterations: plan.loop ? Number.POSITIVE_INFINITY : 1,
            fill: "both",
            pseudoElement: tr.pseudo || undefined,
          },
        );
        a.id = ID;
        if (paused) {
          a.pause();
          a.currentTime = 0;
        }
        out.push(a);
      } catch {
        // A value the browser can't animate between; the property stays as it is.
      }
    }
    return out;
  }

  w.__ponzuAct = {
    mount,
    get: (section: El) => handles.get(section) ?? null,
    /** Every scene animation in a root, for code that sorts animations. */
    isAct: (a: Animation) => a.id === ID,
  };
}

/** Installs `window.__ponzuAct` in a page. */
export const ACT_SCRIPT = `(${actRuntime.toString()})((${actCore.toString()})())`;

/** The type a scene's script element carries. */
export const ACT_TYPE = "ponzu/act";
