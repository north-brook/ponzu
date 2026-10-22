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
  /** A comment that lands as a pin only, without its card (short films). */
  quiet?: true;
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

/** Visible edits already in place in the first frame, so it opens on something. */
export const OPENING_SUBSTANCE = 3;

/** The brand's bloom at the end. */
export const END_CARD = 1.6;
/** A user comment, at about real speed: a second, and a little more for a long one. */
export const COMMENT_HOLD = 1.0;

/** How long a comment holds: about a second, a little more for a long one, at most 1.7s. */
export function commentHold(words: number): number {
  return Math.min(1.7, Math.max(COMMENT_HOLD, 0.5 + words * 0.055));
}

function commentWords(op: Op): number {
  const create = (op.op === "batch" ? op.ops : [op]).find((o) => o.op === "thread.create");
  const text = create?.op === "thread.create" ? (create.thread.messages[0]?.text ?? "") : "";
  return text.split(/\s+/).filter(Boolean).length;
}
/** A thread resolving: the pin leaves. */
export const RESOLVE_HOLD = 0.4;
/** An agent's reply: its card shows for a moment. */
export const REPLY_HOLD = 0.9;
/** The look at the result before the end card. */
export const PULLBACK = 2.5;
/** The look at the result never runs longer than this; spare time goes back to the work. */
export const PULLBACK_MAX = 3.4;
/** A run of work on one board gets at least this long, so the camera can visit and look. */
export const RUN_MIN = 1.35;
/** A comment that lands as a pin only. */
export const QUIET_HOLD = 0.45;
/** The first beat of a turn gets this much extra, so the change of hands reads. */
export const TURN_BREATH = 0.35;
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
  const notes = noteBoards(entries);
  const raw = all
    .map((x) => ({
      ...x,
      kind: filmKind(x.e),
      note: x.e.artboards.length > 0 && x.e.artboards.every((a) => notes.has(a)),
    }))
    .filter((x): x is typeof x & { kind: BeatKind } => x.kind !== null);
  // Opening on nothing (tokens set, empty boards made, a nav bar alone) wastes the first
  // seconds: the film starts once a board has some substance, with what came before in place.
  // Keep at least half of the opening run of work to watch being built.
  let lead = 0;
  while (lead < raw.length && raw[lead]!.kind === "edit") lead++;
  const leadVisible = raw.slice(0, lead).filter((r) => visible(r.e.op)).length;
  const absorb = Math.min(OPENING_SUBSTANCE, Math.floor(leadVisible / 2));
  let substance = 0;
  while (raw.length > 1 && raw[0]!.kind === "edit") {
    const shows = visible(raw[0]!.e.op);
    if (shows && substance >= absorb) break;
    if (shows) substance++;
    raw.shift();
  }
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
  // In a short film, a turn's first two comments show their cards; the rest land as pins.
  const cardsPerTurn = opts.length <= 15 ? 2 : Number.POSITIVE_INFINITY;
  const seenInTurn = new Map<number, number>();
  const quiet = raw.map((r, k) => {
    if (r.kind !== "comment") return false;
    const n = (seenInTurn.get(turnOf[k]!) ?? 0) + 1;
    seenInTurn.set(turnOf[k]!, n);
    return n > cardsPerTurn;
  });
  const pullback = Math.min(PULLBACK, content * 0.11);
  const { durs, leads } = solveDurations(
    raw.map((r, k) => ({
      kind: r.kind,
      t: r.e.t,
      board: r.e.artboards[0] ?? threadBoard(r.e.op),
      light: r.kind === "edit" && (!visible(r.e.op) || r.note),
      words: r.kind === "comment" ? commentWords(r.e.op) : undefined,
      size: r.kind === "edit" ? JSON.stringify(r.e.op).length : undefined,
      quiet: quiet[k],
    })),
    turnOf,
    content - pullback,
  );
  // Time over (every run at its longest) goes to the look at the result, up to a point,
  // then back to the work.
  let finalPull = content - durs.reduce((x, y) => x + y, 0);
  if (finalPull > PULLBACK_MAX) {
    const extra = finalPull - PULLBACK_MAX;
    const editTotal = durs.reduce((a, d, k) => a + (raw[k]!.kind === "edit" ? d : 0), 0);
    if (editTotal > 0) {
      for (let k = 0; k < durs.length; k++)
        if (raw[k]!.kind === "edit") {
          const add = (extra * durs[k]!) / editTotal;
          durs[k] = durs[k]! + add;
          leads[k] = leads[k]! + (leads[k]! > 0.3 ? add * 0.3 : 0);
        }
      finalPull = PULLBACK_MAX;
    }
  }

  const beats: Beat[] = [];
  let t = 0;
  for (let k = 0; k < raw.length; k++) {
    const r = raw[k]!;
    const d = durs[k]!;
    beats.push({
      entry: r.i,
      kind: r.kind,
      turn: turnOf[k]!,
      start: t,
      at: t + Math.min(leads[k]!, d * 0.9),
      end: t + d,
      t: r.e.t,
      artboards: r.e.artboards,
      thread: threadOf(r.e.op),
      who: r.e.origin,
      ...(quiet[k] ? { quiet: true } : {}),
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

export interface DurationInput {
  kind: BeatKind;
  t: number;
  board?: string;
  /** Shows nothing on its own (a token, a note board): passes quickly. */
  light?: boolean;
  words?: number;
  /** How much the op brings, roughly (its size in characters). */
  size?: number;
  /** A comment shown as a pin only. */
  quiet?: boolean;
}

/**
 * Seconds for each beat, at most `room` in all, and how far into each its
 * change lands. Comments get about a second (a pin-only one less), resolves
 * and replies a moment, the first beat of each turn a little extra. The agent's
 * work is played as runs, consecutive edits on one board: each run long enough
 * for the camera to get there and look (its first change waits for it), and
 * no longer than its changes can fill, so nothing holds on a board where
 * nothing is happening. Within a run, edits play at an even speed, bigger ones
 * longer. When the film can't give every run a visit, the smallest pass in a blink.
 */
export function solveDurations(
  beats: DurationInput[],
  turnOf: number[],
  room: number,
): { durs: number[]; leads: number[] } {
  const n = beats.length;
  if (!n) return { durs: [], leads: [] };
  const hold = beats.map((b, k) => {
    const base =
      b.kind === "comment"
        ? b.quiet
          ? QUIET_HOLD
          : commentHold(b.words ?? 12)
        : b.kind === "resolve"
          ? RESOLVE_HOLD
          : b.kind === "reply"
            ? REPLY_HOLD
            : 0;
    const turnStart = k > 0 && turnOf[k] !== turnOf[k - 1];
    return base + (turnStart ? TURN_BREATH : 0);
  });
  // Op weights: real gaps (idle capped), scaled by size; light ones next to nothing.
  const weights = beats.map((b, k) => {
    if (b.kind !== "edit") return 0;
    if (b.light) return 0.15;
    const gap = k > 0 ? (b.t - beats[k - 1]!.t) / 1000 : MIN_WEIGHT;
    let w = Math.min(IDLE_CAP, Math.max(MIN_WEIGHT, gap));
    if (b.size !== undefined) w *= Math.min(1.7, Math.max(0.45, Math.sqrt(b.size / 2500)));
    return w;
  });
  // Runs: consecutive edits on one board (light ones go with their neighbours).
  interface Run {
    ops: number[];
    board?: string;
    weight: number;
    visible: number;
    dur: number;
  }
  const runs: Run[] = [];
  for (let k = 0; k < n; k++) {
    const b = beats[k]!;
    if (b.kind !== "edit") continue;
    const last = runs[runs.length - 1];
    const prevEdit = last ? last.ops[last.ops.length - 1]! : -1;
    const adjacent = last && prevEdit === k - 1;
    if (last && adjacent && (b.light || !b.board || !last.board || last.board === b.board)) {
      last.ops.push(k);
      last.board ??= b.light ? undefined : b.board;
    } else
      runs.push({ ops: [k], board: b.light ? undefined : b.board, weight: 0, visible: 0, dur: 0 });
  }
  for (const r of runs) {
    r.weight = r.ops.reduce((a, k) => a + weights[k]!, 0);
    r.visible = r.ops.filter((k) => !beats[k]!.light).length;
  }
  const runMax = (r: Run) => (r.visible ? Math.min(4.2, 1.0 + 0.42 * r.visible) : 0.3);

  // Holds first; edits keep at least about half the film.
  const holdSum = hold.reduce((a, b) => a + b, 0);
  const editMin = runs.length ? Math.min(room * 0.55, runs.length * RUN_MIN) : 0;
  const holdScale = holdSum > room - editMin ? Math.max(0.3, (room - editMin) / holdSum) : 1;
  const durs = hold.map((h) => h * holdScale);
  let editRoom = Math.max(0, room - durs.reduce((a, b) => a + b, 0));

  // Which runs get a visit: fixes first (work answering a comment is the payoff), then the
  // biggest, as many as fit at RUN_MIN; the rest blink.
  const BLINK = 0.05;
  const shown = new Set<Run>();
  // A run answers a comment when its board was commented on in the last turn, first visit after.
  const answers = new Set<Run>();
  {
    let asked = new Set<string>();
    let k = 0;
    for (const r of runs) {
      for (; k < r.ops[0]!; k++) {
        const b = beats[k]!;
        if (b.kind === "comment") {
          if (k > 0 && beats[k - 1]!.kind !== "comment") asked = new Set();
          if (b.board) asked.add(b.board);
        }
      }
      if (r.board && asked.has(r.board)) {
        answers.add(r);
        asked.delete(r.board);
      }
    }
  }
  const answering = (r: Run) => answers.has(r);
  const priority = (r: Run) => r.weight + (answering(r) ? 1000 : 0);
  const byWeight = [...runs].filter((r) => r.visible).sort((a, b) => priority(b) - priority(a));
  let budget = editRoom - runs.reduce((a, r) => a + r.ops.length * BLINK, 0);
  for (const r of byWeight) {
    const cost = RUN_MIN - r.ops.length * BLINK;
    if (budget >= cost) {
      shown.add(r);
      budget -= cost;
    }
  }
  for (const r of runs) if (!shown.has(r)) r.dur = r.ops.length * BLINK;
  editRoom -= runs.filter((r) => !shown.has(r)).reduce((a, r) => a + r.dur, 0);
  // Water-fill the shown runs by weight within [RUN_MIN, runMax].
  let free = [...shown];
  let left = editRoom;
  for (let pass = 0; pass < 10 && free.length; pass++) {
    const wSum = free.reduce((a, r) => a + r.weight, 0) || 1;
    const next: Run[] = [];
    let fixed = 0;
    for (const r of free) {
      const share = (left * r.weight) / wSum;
      const lo = Math.min(RUN_MIN, runMax(r));
      if (share < lo) {
        r.dur = lo;
        fixed += lo;
      } else if (share > runMax(r)) {
        r.dur = runMax(r);
        fixed += r.dur;
      } else {
        r.dur = share;
        next.push(r);
      }
    }
    if (next.length === free.length) break;
    left -= fixed;
    free = next;
  }
  // Within a run: the first change waits for the camera; then even speed, bigger ops longer.
  const leads = beats.map((b, k) =>
    b.kind === "comment"
      ? Math.min(0.25, durs[k]! * 0.25)
      : b.kind === "edit"
        ? 0
        : Math.min(0.15, durs[k]! * 0.3),
  );
  for (const r of runs) {
    const arrive = shown.has(r) ? Math.min(1.05, r.dur * 0.55) : 0;
    const playable = r.dur - arrive;
    const w = r.ops.reduce((a, k) => a + Math.max(0.15, weights[k]!), 0) || 1;
    r.ops.forEach((k, i) => {
      durs[k] = (playable * Math.max(0.15, weights[k]!)) / w + (i === 0 ? arrive : 0);
      leads[k] = i === 0 ? arrive : Math.min(0.08, durs[k]! * 0.3);
    });
  }
  // Never more than `room`.
  const sum = durs.reduce((a, b) => a + b, 0);
  if (sum > room + 1e-9) {
    const k = room / sum;
    for (let i = 0; i < n; i++) {
      durs[i]! *= k;
      leads[i]! *= k;
    }
  }
  return { durs, leads };
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

/**
 * Whether an op shows on the canvas by itself: not a token change on an empty
 * canvas, an empty board, a rename or a page made.
 */
function visible(op: Op): boolean {
  switch (op.op) {
    case "batch":
      return op.ops.some(visible);
    case "artboard.create":
      return op.artboard.root.children.length > 0;
    case "tokens":
    case "note":
    case "page.create":
    case "page.update":
    case "file.rename":
    case "file.icon":
    case "name":
      return false;
    default:
      return true;
  }
}

/** The board a new comment is pinned on. */
function threadBoard(op: Op): string | undefined {
  const create = (op.op === "batch" ? op.ops : [op]).find((o) => o.op === "thread.create");
  return create?.op === "thread.create" ? create.thread.artboardId : undefined;
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
  /** The separate pieces that changed, when the whole is too wide to read at once. */
  parts?: Rect[];
  /** Lines of text on the board (canvas px): a resting frame never cuts one in half. */
  texts?: Rect[];
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
  return focus.texts?.length ? avoidCuts(cam, focus.texts, view, f) : cam;
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
  if (widest) {
    const fitZ = usable / widest.w;
    if (fitZ >= f.minZoom * 0.5) cam = { ...cam, cx: widest.x + widest.w / 2, zoom: fitZ };
    else {
      const top = cam.cy - view.h / 2 / cam.zoom + (f.top + 8) / cam.zoom;
      if (widest.y + widest.h > top) cam = { ...cam, cy: cam.cy + (widest.y + widest.h + 8 - top) };
    }
  }
  return cleanFrame(cam, lines, view, f);
}

/** Lines a camera's frame cuts: partly in, partly out, at any edge. Top edge is below the wayfinding line. */
export function cutLines(
  cam: Cam,
  lines: Rect[],
  view: { w: number; h: number },
  f: Framing,
): Rect[] {
  const z = cam.zoom;
  const x0 = cam.cx - view.w / 2 / z;
  const x1 = cam.cx + view.w / 2 / z;
  const y0 = cam.cy - view.h / 2 / z + (f.top + 6) / z;
  const y1 = cam.cy + view.h / 2 / z;
  const tol = 2 / z;
  return lines.filter((r) => {
    const inX = r.x + r.w > x0 + tol && r.x < x1 - tol;
    const inY = r.y + r.h > y0 + tol && r.y < y1 - tol;
    if (!inX || !inY) return false;
    return r.x < x0 - tol || r.x + r.w > x1 + tol || r.y < y0 - tol || r.y + r.h > y1 + tol;
  });
}

/**
 * The nearest frame to `cam` that cuts no line of text: tries nudges of up to
 * a third of a screen each way, then pulling back a little, and takes the
 * closest that's clean (or the one that cuts the least).
 */
function cleanFrame(cam: Cam, lines: Rect[], view: { w: number; h: number }, f: Framing): Cam {
  if (!cutLines(cam, lines, view, f).length) return cam;
  let best = cam;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const zk of [1, 0.94, 0.88, 0.8, 0.7, 0.6]) {
    const z = cam.zoom * zk;
    if (z < f.minZoom * 0.4) break;
    const stepX = view.w / z / 32;
    const stepY = view.h / z / 32;
    for (let i = -14; i <= 14; i++)
      for (let j = -14; j <= 14; j++) {
        const c = { ...cam, zoom: z, cx: cam.cx + i * stepX, cy: cam.cy + j * stepY };
        const cuts = cutLines(c, lines, view, f);
        const area = cuts.reduce((a, r) => a + Math.min(r.w, 400) * r.h, 0);
        const score = area * 100 + Math.hypot(i, j) * 0.8 + (1 - zk) * 60;
        if (score < bestScore) {
          bestScore = score;
          best = c;
        }
      }
    if (bestScore < 1000) break;
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
  // Whole but small (a phone screen in a wide frame): closer on what changed, while it fits.
  if (!focus.overview && focus.detail && fitBoard >= f.minZoom && fitBoard < f.comfort * 0.9) {
    const d = focus.detail;
    const fitD = Math.min(vw / d.w, vh / d.h);
    const zoom = Math.min(f.comfort, fitD);
    if (zoom > fitBoard * 1.15) {
      const sw = vw / zoom;
      const sh = vh / zoom;
      const cx = clampSpan(d.x + d.w / 2, b.x, b.x + b.w, sw);
      const cy = clampSpan(d.y + d.h / 2, b.y, b.y + b.h, sh);
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
 * What an op changes, for the film: `fresh` nodes rise in (new subtrees, and
 * elements whose text was replaced); `restyled` nodes change in place, so their
 * board crossfades from how it looked.
 */
export function changedNodes(op: Op): {
  fresh: string[];
  restyled: string[];
  /** Nodes whose old contents were replaced or taken away: where the old look has to give way. */
  replaced: string[];
} {
  const fresh: string[] = [];
  const restyled: string[] = [];
  const replaced: string[] = [];
  const walk = (o: Op) => {
    switch (o.op) {
      case "batch":
        for (const x of o.ops) walk(x);
        return;
      case "insert":
        for (const n of o.nodes) if (n.kind === "el") fresh.push(n.id);
        // Text inserted straight into a parent: the parent's text is new.
        if (o.nodes.some((n) => n.kind === "text")) fresh.push(o.parent);
        return;
      case "children": {
        replaced.push(o.id);
        const els = o.children.filter((n) => n.kind === "el");
        if (els.length) for (const n of els) fresh.push(n.id);
        else fresh.push(o.id);
        return;
      }
      case "artboard.create":
        for (const n of o.artboard.root.children) if (n.kind === "el") fresh.push(n.id);
        return;
      case "style":
      case "attrs":
      case "move":
        restyled.push(o.id);
        return;
      case "remove":
        replaced.push(o.id);
        return;
      default:
        return;
    }
  };
  walk(op);
  return { fresh, restyled, replaced };
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

/* ------------------------------------------------------------------ */
/* The follow camera                                                   */
/* ------------------------------------------------------------------ */

/** Where the camera goes at film time `t`, and how long it takes to get there. */
export interface CamTarget {
  t: number;
  cam: Cam;
  /** Seconds of travel from wherever the camera is at `t`. */
  travel: number;
}

/** After arriving, the camera holds at least this long before it leaves again. */
export const MIN_HOLD = 1.15;
/** How far ahead of a change the camera sets off, at most. */
export const LEAD = 0.7;

/** How long a trip takes: longer for further, so the speed stays easy on the eye. */
export function travelTime(a: Cam, b: Cam, view: { w: number; h: number }, slow = false): number {
  if (a.page !== b.page) return 0;
  const d = camDistance(a, b, view);
  if (slow) return Math.min(1.3, Math.max(0.9, 0.8 + d * 0.3));
  return Math.min(1.6, Math.max(0.7, 0.55 + d * 0.5));
}

/**
 * Targets from per-beat focus, as visits. Comments and replies are fixed: the
 * camera arrives as each lands. A run of the agent's edits to one board is one
 * visit, framed on everything the run changes, taken only when the camera can
 * get there and hold MIN_HOLD before it must leave for the next comment.
 * Resolves never move the camera: the pin leaves wherever it is. So the
 * camera settles on what it shows instead of chasing every op.
 */
export function camTargets(
  plan: Plan,
  focus: (Focus | null)[],
  view: { w: number; h: number },
  framing: Framing,
  final: Focus | null,
): CamTarget[] {
  interface Visit {
    cam: Cam | null;
    key?: string;
    /** When its first change lands. */
    at: number;
    /** When its last change has played. */
    end: number;
    fixed: boolean;
    parts: Focus[];
  }
  const visits: Visit[] = [];
  for (let i = 0; i < plan.beats.length; i++) {
    const b = plan.beats[i]!;
    const fo = focus[i];
    if (!fo || b.kind === "resolve") continue;
    const last = visits[visits.length - 1];
    if (b.kind === "edit") {
      // Runs of edits on the same board (or turn frame) are one visit.
      if (last && !last.fixed && last.key === fo.key) {
        last.end = b.end;
        last.parts.push(fo);
        continue;
      }
      visits.push({ cam: null, key: fo.key, at: b.at, end: b.end, fixed: false, parts: [fo] });
      continue;
    }
    // A comment: on the same frame as the last comment of its turn, it's the same visit.
    const cam = frameFocus(fo, view, framing);
    if (last?.fixed && last.cam && (last.key === fo.key || sameCam(last.cam, cam, view))) {
      last.end = b.end;
      continue;
    }
    visits.push({ cam, key: fo.key, at: b.at, end: b.end, fixed: true, parts: [fo] });
  }
  // Edit visits frame everything their run changed, on the run's board.
  for (const v of visits) {
    if (v.cam) continue;
    const first = v.parts[0]!;
    const details = v.parts.flatMap((p) => (p.detail ? [p.detail] : []));
    const parts = v.parts.flatMap((p) => p.parts ?? (p.detail ? [p.detail] : []));
    const detail = details.length ? unionRects(details) : undefined;
    v.cam = frameFocus({ ...first, detail, parts }, view, framing);
  }

  const out: CamTarget[] = [];
  let prev: Cam | null = null;
  let free = 0;
  for (let k = 0; k < visits.length; k++) {
    const v = { ...visits[k]!, cam: visits[k]!.cam! };
    if (!prev) {
      out.push({ t: 0, cam: v.cam, travel: 0 });
      prev = v.cam;
      free = MIN_HOLD;
      continue;
    }
    if (sameCam(prev, v.cam, view)) continue;
    const travel = travelTime(prev, v.cam, view);
    if (v.fixed) {
      const lastT = out[out.length - 1]!;
      const t = Math.max(lastT.t + lastT.travel * 0.8, v.at - travel, Math.min(free, v.at - 0.45));
      if (t + travel >= plan.pullback - 0.2) continue;
      out.push({ t, cam: v.cam, travel: Math.max(0.45, Math.min(travel, v.at - t + 0.15)) });
    } else {
      // Arrive as the run's first change lands: a long trip goes a little quicker to make it.
      const needed = v.at - 0.05 - free;
      const trip = needed < travel ? Math.max(0.6, needed) : travel;
      const t = Math.max(free, v.at - trip - 0.05);
      // It must hold, and still leave in time for the next comment.
      const next = visits.slice(k + 1).find((x) => x.fixed);
      if (next) {
        const leave = next.at - travelTime(v.cam, next.cam!, view);
        if (t + trip + MIN_HOLD > leave) continue;
      }
      // Arriving after the run has played still shows its result, for a little while.
      if (t + trip > v.end + 1.0) continue;
      if (t + trip >= plan.pullback - 0.2) continue;
      out.push({ t, cam: v.cam, travel: trip });
    }
    const last = out[out.length - 1]!;
    // A comment's frame holds until it has been read.
    free = Math.max(last.t + last.travel + MIN_HOLD, v.fixed ? v.end - 0.1 : 0);
    prev = v.cam;
  }
  if (final) {
    const cam = frameFocus({ ...final, overview: true }, view, framing);
    const last = out[out.length - 1];
    const from = last?.cam ?? cam;
    const travel = travelTime(from, cam, view, true);
    // Arrive with time to look before the end card.
    const t = Math.max(
      last ? last.t + last.travel + 0.2 : 0,
      Math.min(plan.pullback, plan.endCard - travel - 0.8),
    );
    if (!last || !sameCam(from, cam, view)) out.push({ t, cam, travel });
  }
  return out;
}

function unionRects(rects: Rect[]): Rect {
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w));
  const y1 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export interface CamPath {
  targets: CamTarget[];
  view: { w: number; h: number };
  /** Where each trip set off from. */
  from: Cam[];
}

/** Precomputes where each trip starts, so any frame is a pure function of time. */
export function cameraPath(targets: CamTarget[], view: { w: number; h: number }): CamPath {
  const from: Cam[] = [];
  for (let i = 0; i < targets.length; i++) {
    if (i === 0) from.push(targets[0]!.cam);
    else from.push(segmentAt(targets, from, i - 1, targets[i]!.t, view));
  }
  return { targets, view, from };
}

/** On trip i at time f: flying, then holding with a slow push in. */
function segmentAt(
  targets: CamTarget[],
  from: Cam[],
  i: number,
  f: number,
  view: { w: number; h: number },
): Cam {
  const tg = targets[i]!;
  const start = from[i]!;
  const local = f - tg.t;
  if (tg.travel > 0 && local < tg.travel && start.page === tg.cam.page) {
    const p = ease.inOut(clamp01(local / tg.travel));
    return flyTo(start, tg.cam, p, view);
  }
  const held = Math.max(0, local - tg.travel);
  return { ...tg.cam, zoom: tg.cam.zoom * (1 + Math.min(0.05, held * 0.011)) };
}

/** The camera at film time `f`. */
export function camOnPath(path: CamPath, f: number): Cam | null {
  const { targets, from, view } = path;
  if (!targets.length) return null;
  let i = 0;
  while (i + 1 < targets.length && targets[i + 1]!.t <= f) i++;
  return segmentAt(targets, from, i, f, view);
}

/** How much of the canvas the page-change dip hides at `f`: 0 clear, 1 covered. */
export function pageDipAt(path: CamPath, f: number): number {
  const { targets, from } = path;
  for (let i = 1; i < targets.length; i++) {
    if (from[i]!.page === targets[i]!.cam.page) continue;
    const x = 1 - Math.abs(f - targets[i]!.t) / 0.3;
    if (x > 0) return ease.inOut(Math.min(1, x * 1.3));
  }
  return 0;
}
