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

export interface Beat {
  /** Index of the journal entry. */
  entry: number;
  kind: BeatKind;
  /** Index into `turns`. */
  turn: number;
  /** Film time the beat starts, the camera heads for it. Seconds. */
  start: number;
  /** When its change lands on the canvas. */
  at: number;
  end: number;
  /** Real time of the op. */
  t: number;
  artboards: string[];
  /** The comment thread, for comment, reply and resolve beats. */
  thread?: string;
  /** Who made it. */
  who: { kind: string; name: string; client?: string };
}

export interface Turn {
  kind: "user" | "agent";
  start: number;
  end: number;
  /** Agent's name and product, for its mark. */
  who?: { name: string; client?: string };
}

export interface Plan {
  beats: Beat[];
  turns: Turn[];
  /** Film time the canvas pulls back to the result. */
  pullback: number;
  /** End card, to the end of the film. */
  endCard: number;
  duration: number;
  /** Index of the entry the film starts after: the doc at this entry is the opening frame. */
  base: number;
}

export interface PlanOptions {
  length: number;
  range?: Range;
}

/** The brand's bloom at the end. */
export const END_CARD = 1.6;
/** A user comment, at about real speed. */
export const COMMENT_HOLD = 1.0;
/** A thread resolving: the pin leaves. */
export const RESOLVE_HOLD = 0.4;
/** An agent's reply: its card shows for a moment. */
export const REPLY_HOLD = 0.9;
/** The look at the result before the end card. */
export const PULLBACK = 1.8;
/** Real gaps longer than this are idle, and cut down to it. */
export const IDLE_CAP = 6;
/** Even two ops in the same millisecond get this much weight, so each one is seen. */
export const MIN_WEIGHT = 0.6;
/** Extra weight when the work moves to another board: the camera has somewhere to go. */
export const MOVE_WEIGHT = 2.2;
/** No edit gets less than this, or more. */
export const MIN_EDIT = 0.28;
export const MAX_EDIT = 3.2;

const opEntries = (entries: JournalEntry[], range?: Range) =>
  entries
    .map((e, i) => ({ e, i }))
    .filter(
      (x): x is { e: OpEntry; i: number } =>
        x.e.kind === "op" && (!range || (x.e.t >= range.from && x.e.t <= range.to)),
    );

/** Split beats into turns: consecutive user comments make yours, everything between the agent's. */
export function groupTurns(kinds: BeatKind[]): number[] {
  const out: number[] = [];
  let turn = -1;
  let prev: "user" | "agent" | null = null;
  for (const k of kinds) {
    const side = k === "comment" ? "user" : "agent";
    if (side !== prev) {
      turn++;
      prev = side;
    }
    out.push(turn);
  }
  return out;
}

/**
 * The film's edit decisions. Idle time is cut, each comment gets about a
 * second, a moment for each resolve and reply, and edits share what's left in
 * proportion to their (capped) real gaps, so the agent's work plays at an even
 * speed. Moving to another board weighs extra, for the camera's trip.
 */
export function planFilm(entries: JournalEntry[], opts: PlanOptions): Plan {
  const range = opts.range;
  const all = opEntries(entries, range);
  const raw = all
    .map((x) => ({ ...x, kind: filmKind(x.e) }))
    .filter((x): x is typeof x & { kind: BeatKind } => x.kind !== null);
  const content = Math.max(2, opts.length - END_CARD);
  const firstEntry = raw[0]?.i ?? entries.length;
  // The opening frame: the doc just before the first beat.
  const base = Math.max(0, firstEntry - 1);
  if (!raw.length) {
    return {
      beats: [],
      turns: [],
      pullback: 0,
      endCard: content,
      duration: content + END_CARD,
      base,
    };
  }

  const turnOf = groupTurns(raw.map((r) => r.kind));
  // Fixed holds, scaled down when there are more of them than the film has room for.
  const fixed = raw.map((r): number =>
    r.kind === "comment"
      ? COMMENT_HOLD
      : r.kind === "resolve"
        ? RESOLVE_HOLD
        : r.kind === "reply"
          ? REPLY_HOLD
          : 0,
  );
  const edits = raw.filter((r) => r.kind === "edit").length;
  const pullback = Math.min(PULLBACK, content * 0.12);
  const fixedTotal = fixed.reduce((a, b) => a + b, 0);
  // Edits keep at least half the film when there are many of them.
  const editFloor = edits ? Math.min(content * 0.5, edits * MIN_EDIT * 1.6) : 0;
  const room = content - pullback - editFloor;
  const holdScale = fixedTotal > room ? Math.max(0.35, room / fixedTotal) : 1;

  // Edit weights: real gaps, idle cut, floored, plus a move when the board changes.
  const weights: number[] = [];
  let lastBoard: string | undefined;
  for (let k = 0; k < raw.length; k++) {
    const r = raw[k]!;
    const board = r.e.artboards[0];
    if (r.kind !== "edit") {
      if (board) lastBoard = board;
      weights.push(0);
      continue;
    }
    const gap = k > 0 ? (r.e.t - raw[k - 1]!.e.t) / 1000 : MIN_WEIGHT;
    let w = Math.min(IDLE_CAP, Math.max(MIN_WEIGHT, gap));
    if (board && board !== lastBoard) w += MOVE_WEIGHT;
    if (board) lastBoard = board;
    weights.push(w);
  }
  const wSum = weights.reduce((a, b) => a + b, 0);
  const editRoom = content - pullback - fixedTotal * holdScale;
  const durs = raw.map((r, k) => {
    if (r.kind !== "edit") return fixed[k]! * holdScale;
    return Math.min(MAX_EDIT, Math.max(MIN_EDIT, (editRoom * weights[k]!) / (wSum || 1)));
  });
  // Clamping may leave time over or short: spread the difference evenly over edits.
  const used = durs.reduce((a, b) => a + b, 0);
  let diff = content - pullback - used;
  if (Math.abs(diff) > 1e-6) {
    const flexible = raw.map((r, k) => (r.kind === "edit" ? k : -1)).filter((k) => k >= 0);
    const pool = flexible.length ? flexible : raw.map((_, k) => k);
    const each = diff / pool.length;
    for (const k of pool) durs[k] = Math.max(0.12, durs[k]! + each);
    diff = 0;
  }
  // Whatever's still off (all holds, nothing to stretch) goes to the pull-back.
  const total = durs.reduce((a, b) => a + b, 0);
  const finalPull = Math.max(pullback, content - total);

  const beats: Beat[] = [];
  let t = 0;
  for (let k = 0; k < raw.length; k++) {
    const r = raw[k]!;
    const d = durs[k]!;
    // The change lands once the camera has had a moment to get there.
    const lead =
      r.kind === "comment"
        ? Math.min(0.25, d * 0.25)
        : r.kind === "edit"
          ? Math.min(0.55, d * 0.4)
          : Math.min(0.15, d * 0.3);
    beats.push({
      entry: r.i,
      kind: r.kind,
      turn: turnOf[k]!,
      start: t,
      at: t + lead,
      end: t + d,
      t: r.e.t,
      artboards: r.e.artboards,
      thread: threadOf(r.e.op),
      who: r.e.origin,
    });
    t += d;
  }
  const turns: Turn[] = [];
  for (const b of beats) {
    const kind = b.kind === "comment" ? "user" : "agent";
    const cur = turns[b.turn];
    if (!cur) {
      turns[b.turn] = {
        kind,
        start: b.start,
        end: b.end,
        ...(kind === "agent" && b.who.kind === "agent"
          ? { who: { name: b.who.name, client: b.who.client } }
          : {}),
      };
    } else {
      cur.end = b.end;
      if (!cur.who && kind === "agent" && b.who.kind === "agent")
        cur.who = { name: b.who.name, client: b.who.client };
    }
  }
  const pull = t;
  return {
    beats,
    turns,
    pullback: pull,
    endCard: pull + finalPull,
    duration: pull + finalPull + END_CARD,
    base,
  };
}

function threadOf(op: Op): string | undefined {
  if (op.op === "batch") {
    for (const o of op.ops) {
      const id = threadOf(o);
      if (id) return id;
    }
    return undefined;
  }
  if (op.op === "thread.create") return op.thread.id;
  if (op.op === "thread.update" || op.op === "thread.message") return op.id;
  return undefined;
}

/** The last beat that has landed by film time `f`, or -1 before the first. */
export function beatIndexAt(plan: Plan, f: number): number {
  let lo = 0;
  let hi = plan.beats.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (plan.beats[mid]!.at <= f) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** Comment ticks for an activity track: real times of user comments in the range. */
export function commentTimes(entries: JournalEntry[], range?: Range): number[] {
  return opEntries(entries, range)
    .filter((x) => filmKind(x.e) === "comment")
    .map((x) => x.e.t);
}

/** Real time of the film moment `f` (for a playhead over a real-time track). */
export function realTimeAt(plan: Plan, f: number): number | null {
  if (!plan.beats.length) return null;
  const i = beatIndexAt(plan, f);
  if (i < 0) return plan.beats[0]!.t;
  const b = plan.beats[i]!;
  const next = plan.beats[i + 1];
  if (!next) return b.t;
  const p = Math.min(1, Math.max(0, (f - b.at) / Math.max(0.001, next.at - b.at)));
  return b.t + (next.t - b.t) * p;
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
  /** Show the whole of `board` even when that's below the shape's legible zoom. */
  overview?: boolean;
  /** What it's about (a board id), for debugging and tests. */
  key?: string;
}

export interface Framing {
  /** Below this zoom (output px per canvas px), text is too small, so frame a part. */
  minZoom: number;
  maxZoom: number;
  /** Margin around what's framed, in output px. */
  pad: number;
}

/** In the film's CSS pixels (see filmViewport). */
export function framingFor(shape: FilmShape): Framing {
  if (shape === "9:16") return { minZoom: 0.62, maxZoom: 1.6, pad: 28 };
  if (shape === "1:1") return { minZoom: 0.5, maxZoom: 1.5, pad: 36 };
  return { minZoom: 0.36, maxZoom: 1.3, pad: 48 };
}

/**
 * The camera for a focus in a viewport. The whole board when it fits at a
 * legible zoom; otherwise as close as legibility needs, centred on what
 * changed and kept inside the board, so a tighter shape pans across the same
 * canvas instead of re-laying it out.
 */
export function frameFocus(focus: Focus, view: { w: number; h: number }, f: Framing): Cam {
  const b = focus.board;
  const fit = Math.min((view.w - 2 * f.pad) / b.w, (view.h - 2 * f.pad) / b.h);
  if (fit >= f.minZoom || focus.overview) {
    const zoom = Math.min(f.maxZoom, focus.overview ? Math.max(fit, f.minZoom * 0.42) : fit);
    if (zoom >= fit - 1e-9 || !focus.detail)
      return { page: focus.page, cx: b.x + b.w / 2, cy: b.y + b.h / 2, zoom };
  }
  // Fit the width if that's legible, else the legibility floor.
  const widthFit = (view.w - 2 * f.pad) / b.w;
  const zoom = Math.min(
    f.maxZoom,
    Math.max(f.minZoom, Math.min(widthFit, fit > 0 ? Math.max(fit, widthFit) : widthFit)),
  );
  const vw = view.w / zoom;
  const vh = view.h / zoom;
  const d = focus.detail ?? { x: b.x, y: b.y, w: b.w, h: Math.min(b.h, vh) };
  const padC = f.pad / zoom;
  const cx = clampSpan(d.x + d.w / 2, b.x - padC, b.x + b.w + padC, vw);
  const cy = clampSpan(d.y + d.h / 2, b.y - padC, b.y + b.h + padC, vh);
  return { page: focus.page, cx, cy, zoom };
}

/** Keep a window of `span` centred near `c` inside [lo, hi]; centred on the range if it's smaller. */
function clampSpan(c: number, lo: number, hi: number, span: number): number {
  if (hi - lo <= span) return (lo + hi) / 2;
  return Math.min(hi - span / 2, Math.max(lo + span / 2, c));
}

export interface Shot {
  /** Film time the camera starts heading here. */
  start: number;
  /** When it arrives. */
  arrive: number;
  cam: Cam;
}

/** Shortest and longest trip between shots. */
export const MOVE_MIN = 0.45;
export const MOVE_MAX = 1.1;

/**
 * Shots from per-beat focus: one per change of what's in frame, so beats on
 * the same spot hold still. The camera leaves early enough to arrive as the
 * beat's change lands, never before the previous shot settles.
 */
export function planShots(
  plan: Plan,
  focus: (Focus | null)[],
  view: { w: number; h: number },
  framing: Framing,
  final: Focus | null,
): Shot[] {
  const shots: Shot[] = [];
  let prev: Cam | null = null;
  for (let i = 0; i < plan.beats.length; i++) {
    const fo = focus[i];
    if (!fo) continue;
    const b = plan.beats[i]!;
    const cam = frameFocus(fo, view, framing);
    if (prev && sameCam(prev, cam, view)) continue;
    const lastArrive = shots.length ? shots[shots.length - 1]!.arrive : 0;
    if (!prev) {
      shots.push({ start: 0, arrive: 0, cam });
    } else {
      const dist = camDistance(prev, cam, view);
      const move =
        prev.page !== cam.page ? 0.5 : Math.min(MOVE_MAX, Math.max(MOVE_MIN, 0.4 + dist * 0.35));
      const arrive = Math.max(b.at, lastArrive + 0.2);
      const start = Math.max(lastArrive + 0.05, arrive - move);
      shots.push({ start, arrive: Math.max(arrive, start + 0.2), cam });
    }
    prev = cam;
  }
  if (final) {
    const cam = frameFocus({ ...final, overview: true }, view, framing);
    const start = plan.pullback;
    const arrive = start + Math.min(1.3, Math.max(0.6, (plan.endCard - plan.pullback) * 0.7));
    if (!prev || !sameCam(prev, cam, view)) shots.push({ start, arrive, cam });
  }
  return shots;
}

function sameCam(a: Cam, b: Cam, view: { w: number; h: number }) {
  return a.page === b.page && camDistance(a, b, view) < 0.04;
}

/** How far apart two cameras are, in screens. */
export function camDistance(a: Cam, b: Cam, view: { w: number; h: number }): number {
  const z = Math.min(a.zoom, b.zoom);
  const dx = ((a.cx - b.cx) * z) / view.w;
  const dy = ((a.cy - b.cy) * z) / view.h;
  return Math.hypot(dx, dy) + Math.abs(Math.log(a.zoom / b.zoom));
}

/**
 * The camera at film time `f`: holds with a slow push between shots, and
 * travels between them on a smooth zoom-and-pan path that backs out a little
 * on long trips, so the eye can follow where it's going.
 */
export function cameraAt(shots: Shot[], f: number, view: { w: number; h: number }): Cam | null {
  if (!shots.length) return null;
  let i = 0;
  while (i + 1 < shots.length && shots[i + 1]!.start <= f) i++;
  const cur = shots[i]!;
  const next = shots[i + 1];
  if (f < cur.arrive && i > 0) {
    const from = settled(shots, i - 1, cur.start);
    const p = ease.inOut(clamp01((f - cur.start) / Math.max(0.001, cur.arrive - cur.start)));
    if (from.page !== cur.cam.page) return p < 0.5 ? from : cur.cam;
    return flyTo(from, cur.cam, p, view);
  }
  return drift(cur, next ? next.start : f + 10, f);
}

/** Where shot i's hold has drifted to by `f`. */
function settled(shots: Shot[], i: number, f: number): Cam {
  return drift(shots[i]!, shots[i + 1]?.start ?? f, f);
}

/** A slow push in while the camera holds, so the canvas never sits dead still. */
function drift(s: Shot, until: number, f: number): Cam {
  const held = Math.max(0, Math.min(f, until) - s.arrive);
  const zoom = s.cam.zoom * (1 + Math.min(0.06, held * 0.012));
  return { ...s.cam, zoom };
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

/** How much of the canvas is hidden by the page change dip at `f`: 0 clear, 1 covered. */
export function dipAt(shots: Shot[], f: number): number {
  for (let i = 1; i < shots.length; i++) {
    const s = shots[i]!;
    if (shots[i - 1]!.cam.page === s.cam.page) continue;
    const mid = (s.start + s.arrive) / 2;
    const half = Math.max(0.12, (s.arrive - s.start) / 2);
    const x = 1 - Math.abs(f - mid) / half;
    if (x > 0) return ease.inOut(Math.min(1, x * 1.4));
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/* What changed                                                        */
/* ------------------------------------------------------------------ */

/**
 * The nodes an op brings in (roots of new subtrees, which stream in) and the
 * ones it changes in place (restyled, retexted), for the camera's detail.
 */
export function changedNodes(op: Op): { fresh: string[]; touched: string[] } {
  const fresh: string[] = [];
  const touched: string[] = [];
  const walk = (o: Op) => {
    switch (o.op) {
      case "batch":
        for (const x of o.ops) walk(x);
        return;
      case "insert":
        for (const n of o.nodes) if (n.kind === "el") fresh.push(n.id);
        // Text inserted straight into a parent changes the parent.
        if (o.nodes.some((n) => n.kind === "text")) touched.push(o.parent);
        return;
      case "children": {
        const els = o.children.filter((n) => n.kind === "el");
        if (els.length) for (const n of els) fresh.push(n.id);
        else touched.push(o.id);
        return;
      }
      case "artboard.create":
        for (const n of o.artboard.root.children) if (n.kind === "el") fresh.push(n.id);
        touched.push(o.artboard.id);
        return;
      case "style":
      case "attrs":
      case "name":
        touched.push(o.id);
        return;
      case "move":
        touched.push(o.id);
        return;
      default:
        return;
    }
  };
  walk(op);
  return { fresh, touched };
}

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
