import type { Op } from "./doc.ts";
import type { JournalEntry, OpEntry } from "./journal.ts";

/**
 * A timelapse's edit decisions, as pure functions of the journal: which ops
 * become beats, how they group into turns, how much of the film each one
 * gets, and where the camera looks. The film page plays this back frame by
 * frame; nothing here touches the DOM.
 */

export type FilmShape = "16:9" | "1:1" | "9:16";
export type FilmLength = 15 | 30 | 60;

export const FILM_SHAPES: FilmShape[] = ["16:9", "1:1", "9:16"];
export const FILM_LENGTHS: FilmLength[] = [15, 30, 60];

/** Output size in pixels. */
export function filmSize(shape: FilmShape): { w: number; h: number } {
  if (shape === "1:1") return { w: 1080, h: 1080 };
  if (shape === "9:16") return { w: 1080, h: 1920 };
  return { w: 1920, h: 1080 };
}

/**
 * The film page's viewport in CSS pixels, and the device scale that makes it
 * the output size. Overlays (pins, cards, the wayfinding line) are sized in
 * CSS pixels, so a tall film shows them bigger relative to the frame, which
 * is what keeps them legible on a phone.
 */
export function filmViewport(shape: FilmShape): { w: number; h: number; scale: number } {
  if (shape === "1:1") return { w: 720, h: 720, scale: 1.5 };
  if (shape === "9:16") return { w: 540, h: 960, scale: 2 };
  return { w: 960, h: 540, scale: 2 };
}

/** A stretch of history: a session, or what the trims leave. Times in ms since the epoch. */
export interface Range {
  from: number;
  to: number;
}

/** A gap this long or longer starts a new session. */
export const SESSION_GAP = 60 * 60_000;

/** The last session: everything since the last gap of an hour or more. */
export function lastSession(entries: JournalEntry[], gap = SESSION_GAP): Range | null {
  const ops = entries.filter((e) => e.kind === "op" && filmKind(e as OpEntry) !== null);
  if (!ops.length) return null;
  let from = ops[ops.length - 1]!.t;
  for (let i = ops.length - 1; i > 0; i--) {
    if (ops[i]!.t - ops[i - 1]!.t >= gap) break;
    from = ops[i - 1]!.t;
  }
  return { from, to: ops[ops.length - 1]!.t };
}

/* ------------------------------------------------------------------ */
/* Beats                                                               */
/* ------------------------------------------------------------------ */

export type BeatKind = "comment" | "reply" | "resolve" | "edit";

/** What an op shows as in a film, or null for one that shows nothing (notes, renames). */
export function filmKind(e: OpEntry): BeatKind | null {
  const op = e.op;
  const leaf = op.op === "batch" ? op.ops : [op];
  if (leaf.some((o) => o.op === "thread.create"))
    return e.origin.kind === "user" ? "comment" : "reply";
  if (leaf.some((o) => o.op === "thread.update" && o.status === "resolved")) return "resolve";
  if (leaf.some((o) => o.op === "thread.message")) return "reply";
  if (e.artboards.length) return "edit";
  if (leaf.some((o) => o.op === "tokens")) return "edit";
  return null;
}

/** Boards named "Note: …": the agent's annotations. The film passes them quickly. */
export function noteBoards(entries: JournalEntry[]): Set<string> {
  const out = new Set<string>();
  const see = (id: string, name?: string) => {
    if (name === undefined) return;
    if (/^note\b/i.test(name.trim())) out.add(id);
    else out.delete(id);
  };
  const walk = (op: Op) => {
    if (op.op === "batch") for (const o of op.ops) walk(o);
    else if (op.op === "artboard.create") see(op.artboard.id, op.artboard.name);
    else if (op.op === "artboard.update") see(op.id, op.name);
  };
  for (const e of entries) {
    if (e.kind === "checkpoint")
      for (const p of e.doc.pages) for (const ab of p.artboards) see(ab.id, ab.name);
    else walk(e.op);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Easing                                                              */
/* ------------------------------------------------------------------ */

export const ease = {
  /** The studio's --ease-out: cubic-bezier(.2,.8,.2,1). */
  out: bezier(0.2, 0.8, 0.2, 1),
  /** --ease-in-out: cubic-bezier(.65,0,.35,1). */
  inOut: bezier(0.65, 0, 0.35, 1),
  in: bezier(0.4, 0, 1, 1),
  linear: (x: number) => x,
};

/** A CSS cubic-bezier timing function. */
export function bezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sx(t) - x;
      if (Math.abs(err) < 1e-6) break;
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    // Bisection when Newton wanders.
    if (t < 0 || t > 1 || Math.abs(sx(t) - x) > 1e-4) {
      let lo = 0;
      let hi = 1;
      t = x;
      for (let i = 0; i < 30; i++) {
        if (sx(t) < x) lo = t;
        else hi = t;
        t = (lo + hi) / 2;
      }
    }
    return sy(t);
  };
}

export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
/** 0 → 1 as `f` goes from `a` to `b`, eased. */
export function progress(f: number, a: number, b: number, fn: (x: number) => number = ease.out) {
  if (b <= a) return f >= b ? 1 : 0;
  return fn(clamp01((f - a) / (b - a)));
}

/* ------------------------------------------------------------------ */
/* Camera                                                              */
/* ------------------------------------------------------------------ */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where the camera looks: the canvas point at the centre of the frame, and px per canvas px. */
export interface Cam {
  page: string;
  cx: number;
  cy: number;
  zoom: number;
}

/** What one beat wants in frame. */
export interface Focus {
  page: string;
  /** The board, or boards, the beat is about. */
  board: Rect;
  /** The part of it that changed, when known. */
  detail?: Rect;
  /** The separate pieces that changed, when the whole is too wide to read at once. */
  parts?: Rect[];
  /** Lines of text on the board (canvas px): a resting frame never cuts one in half. */
  texts?: Rect[];
  /** Lines on the boards around it: cutting these matters less (they're context). */
  context?: Rect[];
  /** What must stay wholly in frame whatever else moves (the change being shown). */
  keep?: Rect;
  /** Show the whole of `board` even when that's below the shape's legible zoom. */
  overview?: boolean;
  /** What it's about (a board id), for debugging and tests. */
  key?: string;
  /**
   * A pin whose thread card shows: the card is 320×150 screen px to its right
   * (or left), so the frame keeps room for it at any zoom.
   */
  pin?: { x: number; y: number };
}

export interface Framing {
  /** Below this zoom (output px per canvas px), text is too small, so frame a part. */
  minZoom: number;
  maxZoom: number;
  /** Margin around what's framed, in output px. */
  pad: number;
  /** Extra room at the top for the board's name and the wayfinding line. */
  top: number;
  /** A change on a board that only fits small is framed closer, up to this zoom, so it reads. */
  comfort: number;
  /** The wayfinding line's box in screen px, when measured. */
  pill?: Rect;
  /** The agent's badge, top right in a close shot of the board it's working on (screen px). */
  badge?: Rect;
}

/** In the film's CSS pixels (see filmViewport). */
export function framingFor(shape: FilmShape): Framing {
  if (shape === "9:16") return { minZoom: 0.6, maxZoom: 1.5, pad: 24, top: 60, comfort: 0.95 };
  if (shape === "1:1") return { minZoom: 0.5, maxZoom: 1.4, pad: 32, top: 48, comfort: 0.85 };
  return { minZoom: 0.36, maxZoom: 1.2, pad: 40, top: 44, comfort: 0.78 };
}

/**
 * The camera for a focus in a viewport. The whole board when it fits at a
 * legible zoom; otherwise as close as legibility needs, centred on what
 * changed and kept inside the board, so a tighter shape pans across the same
 * canvas instead of re-laying it out.
 */
export function frameFocus(focus: Focus, view: { w: number; h: number }, f: Framing): Cam {
  const cam = frameFocusRaw(focus, view, f);
  return focus.texts?.length
    ? avoidCuts(cam, focus.texts, view, f, focus.context, focus.keep)
    : cam;
}

/** Text runs on one row (same top, touching) joined into the line they make. */
function mergeRows(texts: Rect[]): Rect[] {
  const sorted = [...texts].sort((a, b) => a.y - b.y || a.x - b.x);
  const out: Rect[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.y - r.y) < r.h * 0.4 && r.x - (last.x + last.w) < r.h * 0.8) {
      const x1 = Math.max(last.x + last.w, r.x + r.w);
      last.y = Math.min(last.y, r.y);
      last.h = Math.max(last.h, r.h);
      last.w = x1 - last.x;
    } else out.push({ ...r });
  }
  return out;
}

/**
 * Moves a camera the least it takes so no line of text sits across a frame
 * edge: each edge lands in a gap between lines, the cut line fully in or out.
 */
export function avoidCuts(
  cam: Cam,
  texts: Rect[],
  view: { w: number; h: number },
  f: Framing,
  context: Rect[] = [],
  keep?: Rect,
): Cam {
  // Lines are measured as text runs; a heading's lines on one row make one line here.
  const lines = mergeRows(texts);
  // A line wider than the frame across it (a big heading): pull back to fit it whole while
  // that stays readable; else frame below it, so it isn't cut at the sides.
  const inFrame = (r: Rect, c: Cam) =>
    r.y + r.h > c.cy - view.h / 2 / c.zoom &&
    r.y < c.cy + view.h / 2 / c.zoom &&
    r.x < c.cx + view.w / 2 / c.zoom &&
    r.x + r.w > c.cx - view.w / 2 / c.zoom;
  const usable = view.w - 2 * f.pad;
  const widest = lines
    .filter((r) => inFrame(r, cam) && r.w * cam.zoom > usable)
    .sort((a, b) => b.w - a.w)[0];
  // With a subject, only a line it holds that it isn't much narrower than matters here (a
  // page-wide nav row over a headline column isn't a reason to see the whole page small).
  const matters = (r: Rect) =>
    !keep ||
    (r.y + r.h > keep.y &&
      r.y < keep.y + keep.h &&
      r.x < keep.x + keep.w &&
      r.x + r.w > keep.x &&
      r.w <= keep.w * 1.1);
  if (widest && matters(widest)) {
    const fitZ = usable / widest.w;
    if (fitZ >= f.minZoom * 0.5) cam = { ...cam, cx: widest.x + widest.w / 2, zoom: fitZ };
    else {
      const top = cam.cy - view.h / 2 / cam.zoom + (f.top + 8) / cam.zoom;
      if (widest.y + widest.h > top) cam = { ...cam, cy: cam.cy + (widest.y + widest.h + 8 - top) };
    }
  }
  return cleanFrame(cam, lines, view, f, mergeRows(context), keep);
}

/** The corner wayfinding line, in screen px: text under it reads as cut too. Set per film. */
export const WAYFINDING = { x: 10, y: 10, w: 300, h: 40 };

/** Lines a camera's frame cuts: partly in and partly out at an edge, or under the wayfinding line. */
export function cutLines(
  cam: Cam,
  lines: Rect[],
  view: { w: number; h: number },
  f?: Framing,
): Rect[] {
  const W = f?.pill ?? WAYFINDING;
  const z = cam.zoom;
  const x0 = cam.cx - view.w / 2 / z;
  const x1 = cam.cx + view.w / 2 / z;
  const y0 = cam.cy - view.h / 2 / z;
  const y1 = cam.cy + view.h / 2 / z;
  const tol = 1.5 / z;
  const toCanvas = (o: Rect) => ({
    x: x0 + (o.x - 4) / z,
    y: y0 + (o.y - 4) / z,
    w: (o.w + 8) / z,
    h: (o.h + 8) / z,
  });
  const obstacles = [toCanvas(W), ...(f?.badge ? [toCanvas(f.badge)] : [])];
  return lines.filter((r) => {
    const inX = r.x + r.w > x0 + tol && r.x < x1 - tol;
    const inY = r.y + r.h > y0 + tol && r.y < y1 - tol;
    if (!inX || !inY) return false;
    if (r.x < x0 - tol || r.x + r.w > x1 + tol || r.y < y0 - tol || r.y + r.h > y1 + tol)
      return true;
    return obstacles.some(
      (o) => r.x < o.x + o.w && r.x + r.w > o.x && r.y < o.y + o.h && r.y + r.h > o.y,
    );
  });
}

/**
 * The nearest frame to `cam` that cuts no line of text: tries nudges of up to
 * a third of a screen each way, then pulling back a little, and takes the
 * closest that's clean (or the one that cuts the least).
 */
function cleanFrame(
  cam: Cam,
  lines: Rect[],
  view: { w: number; h: number },
  f: Framing,
  context: Rect[] = [],
  keep?: Rect,
): Cam {
  // The change being shown stays wholly in frame (below the corner lines): never traded away.
  const holds = (c: Cam) => {
    if (!keep) return true;
    const hw = view.w / 2 / c.zoom;
    const hh = view.h / 2 / c.zoom;
    const top = (f.top + 4) / c.zoom;
    const m = 8 / c.zoom;
    return (
      keep.x >= c.cx - hw + m &&
      keep.x + keep.w <= c.cx + hw - m &&
      keep.y >= c.cy - hh + top &&
      keep.y + keep.h <= c.cy + hh - m
    );
  };
  // A cut heading is far worse than a cut caption: weigh each cut line by its type size; the
  // subject's own lines count fully, the boards around it a quarter.
  const weight = (c: Cam) =>
    cutLines(c, lines, view, f).reduce((a, r) => a + (r.h * c.zoom) ** 2, 0) +
    0.5 * cutLines(c, context, view, f).reduce((a, r) => a + (r.h * c.zoom) ** 2, 0);
  if (weight(cam) === 0) return cam;
  let best = cam;
  let bestW = weight(cam);
  let bestCost = 0;
  const consider = (c: Cam, cost: number) => {
    if (!holds(c)) return;
    const w = weight(c) + cost * 6;
    if (w < bestW + bestCost * 6 - 1e-6) {
      bestW = weight(c);
      bestCost = cost;
      best = c;
    }
  };
  for (const zk of [1, 0.94, 0.88, 0.8, 0.72, 0.64, 0.56]) {
    const z = cam.zoom * zk;
    if (z < f.minZoom * 0.55) break;
    const stepX = view.w / z / 32;
    const stepY = view.h / z / 32;
    for (let i = -16; i <= 16; i++)
      for (let j = -16; j <= 16; j++)
        consider(
          { ...cam, zoom: z, cx: cam.cx + i * stepX, cy: cam.cy + j * stepY },
          // Small cuts are worth trading for staying close to the subject.
          Math.hypot(i, j) * 2 + (1 - zk) * 120,
        );
  }
  return best;
}

function frameFocusRaw(focus: Focus, view: { w: number; h: number }, f: Framing): Cam {
  // Frame inside the view less its margins: more at the top, for the board's name.
  const vw = view.w - 2 * f.pad;
  const vh = view.h - 2 * f.pad - f.top;
  const shift = f.top / 2;
  const at = (cx: number, cy: number, zoom: number): Cam => ({
    page: focus.page,
    cx,
    cy: cy - shift / zoom,
    zoom,
  });
  const b = focus.board;
  const fitBoard = Math.min(vw / b.w, vh / b.h);
  // Whole but small (a phone screen in a wide frame): closer on what changed, while it fits,
  // centred across the board's width when that fits, so the subject owns the frame.
  if (!focus.overview && focus.detail && fitBoard >= f.minZoom && fitBoard < f.comfort * 0.9) {
    const d = focus.detail;
    const fitD = Math.min(vw / d.w, vh / d.h);
    const zoom = Math.min(f.comfort, fitD);
    if (zoom > fitBoard * 1.15) {
      const sw = vw / zoom;
      const sh = vh / zoom;
      const cx = b.w <= sw ? b.x + b.w / 2 : clampSpan(d.x + d.w / 2, b.x, b.x + b.w, sw);
      const cy = b.h <= sh ? b.y + b.h / 2 : clampSpan(d.y + d.h / 2, b.y, b.y + b.h, sh);
      return withPin(at(cx, cy, zoom), focus, view, f);
    }
  }
  if (focus.overview || fitBoard >= f.minZoom || !focus.detail) {
    if (focus.overview || fitBoard >= f.minZoom)
      return withPin(
        at(b.x + b.w / 2, b.y + b.h / 2, Math.min(f.maxZoom, fitBoard)),
        focus,
        view,
        f,
      );
    // Too tall to show whole, nothing in particular changed: its width, from the top.
    const zoom = Math.min(f.maxZoom, vw / b.w);
    return withPin(at(b.x + b.w / 2, b.y + Math.min(b.h, vh / zoom) / 2, zoom), focus, view, f);
  }
  // Too big to read whole: the whole changed block, as close as it fits, never cut.
  // When that's too small to read, the biggest piece of it instead, whole.
  let d = focus.detail;
  if (Math.min(vw / d.w, vh / d.h) < f.minZoom * 0.75 && focus.parts?.length) {
    const fits = focus.parts.filter((r) => Math.min(vw / r.w, vh / r.h) >= f.minZoom * 0.75);
    const pick = (fits.length ? fits : focus.parts).reduce((a, r) =>
      r.w * r.h > a.w * a.h ? r : a,
    );
    d = pick;
  }
  const fitDetail = Math.min(vw / d.w, vh / d.h);
  const zoom = Math.max(
    fitBoard,
    Math.min(f.maxZoom, fitDetail, Math.max(f.minZoom, vw / b.w) * 1.6),
  );
  const sw = vw / zoom;
  const sh = vh / zoom;
  const cx = clampSpan(d.x + d.w / 2, b.x, b.x + b.w, sw);
  const cy = clampSpan(d.y + d.h / 2, b.y, b.y + b.h, sh);
  return withPin(at(cx, cy, zoom), focus, view, f);
}

/**
 * Nudges a camera the least it takes for a pin to sit inside the frame's
 * margins. Its card is kept in frame by the film itself (it slides in from an
 * edge), so the camera never trades the commented design for room beside it.
 */
function withPin(cam: Cam, focus: Focus, view: { w: number; h: number }, f: Framing): Cam {
  const p = focus.pin;
  if (!p) return cam;
  const z = cam.zoom;
  const hw = view.w / 2 / z;
  const hh = view.h / 2 / z;
  const m = (f.pad + 16) / z;
  const cx = clampCentre(cam.cx, p.x - hw + m, p.x + hw - m);
  const cy = clampCentre(cam.cy, p.y - hh + m, p.y + hh - m - f.top / z);
  return { ...cam, cx, cy };
}

/** `c` moved into [lo, hi]; the middle of the two when they cross. */
function clampCentre(c: number, lo: number, hi: number): number {
  if (lo > hi) return (lo + hi) / 2;
  return Math.min(hi, Math.max(lo, c));
}

/** Keep a window of `span` centred near `c` inside [lo, hi]; centred on the range if it's smaller. */
function clampSpan(c: number, lo: number, hi: number, span: number): number {
  if (hi - lo <= span) return (lo + hi) / 2;
  return Math.min(hi - span / 2, Math.max(lo + span / 2, c));
}

/* ------------------------------------------------------------------ */
/* What changed                                                        */
/* ------------------------------------------------------------------ */

interface TreeNode {
  kind: string;
  id?: string;
  children?: TreeNode[];
}

/**
 * The pieces a new subtree streams in as: its roots, opened up while there
 * are fewer than `want`, so a whole section arrives block by block and not
 * as one slab. Document order, at most `max`.
 */
export function streamUnits(
  find: (id: string) => TreeNode | null,
  roots: string[],
  want = 5,
  max = 14,
): string[] {
  let units: TreeNode[] = roots.map(find).filter((n): n is TreeNode => Boolean(n));
  for (let pass = 0; pass < 3 && units.length < want; pass++) {
    const next: TreeNode[] = [];
    let opened = false;
    for (const u of units) {
      const kids = (u.children ?? []).filter((c) => c.kind === "el");
      if (kids.length > 1 && units.length - 1 + next.length + kids.length <= max * 2) {
        next.push(...kids);
        opened = true;
      } else next.push(u);
    }
    units = next;
    if (!opened) break;
  }
  return units
    .map((u) => u.id)
    .filter((id): id is string => Boolean(id))
    .slice(0, max);
}

/** How far apart two cameras are, in screens. */
export function camDistance(a: Cam, b: Cam, view: { w: number; h: number }): number {
  const z = Math.min(a.zoom, b.zoom);
  const dx = ((a.cx - b.cx) * z) / view.w;
  const dy = ((a.cy - b.cy) * z) / view.h;
  return Math.hypot(dx, dy) + Math.abs(Math.log(a.zoom / b.zoom));
}

/** van Wijk and Nuij's smooth zoom-and-pan, gentled (rho < √2) so it backs out only a little. */
export function flyTo(a: Cam, b: Cam, p: number, view: { w: number; h: number }): Cam {
  const rho = 0.9;
  // Work in screen widths at zoom 1: w is the visible width in canvas units.
  const w0 = view.w / a.zoom;
  const w1 = view.w / b.zoom;
  const dx = b.cx - a.cx;
  const dy = b.cy - a.cy;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6 || !Number.isFinite(d)) {
    const w = w0 * (w1 / w0) ** p;
    return { page: b.page, cx: a.cx + dx * p, cy: a.cy + dy * p, zoom: view.w / w };
  }
  const rho2 = rho * rho;
  const b0 = (w1 * w1 - w0 * w0 + rho2 * rho2 * d * d) / (2 * w0 * rho2 * d);
  const b1 = (w1 * w1 - w0 * w0 - rho2 * rho2 * d * d) / (2 * w1 * rho2 * d);
  const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
  const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
  const S = (r1 - r0) / rho;
  const s = p * S;
  const u = (w0 / (rho2 * d)) * (Math.cosh(r0) * Math.tanh(rho * s + r0) - Math.sinh(r0));
  const w = (w0 * Math.cosh(r0)) / Math.cosh(rho * s + r0);
  if (!Number.isFinite(u) || !Number.isFinite(w) || !Number.isFinite(S)) {
    const ww = w0 * (w1 / w0) ** p;
    return { page: b.page, cx: a.cx + dx * p, cy: a.cy + dy * p, zoom: view.w / ww };
  }
  return { page: b.page, cx: a.cx + dx * u, cy: a.cy + dy * u, zoom: view.w / w };
}
