import {
  type Artboard,
  type Cam,
  COMMENT_IN,
  clamp01,
  type Doc,
  ease,
  excerpt,
  findArtboard,
  findNode,
  flyTo,
  progress,
  shotAt,
  type Thread,
  typeTime,
} from "@ponzu/core";
import {
  AgentMark,
  ARRIVE_LAG_MS,
  ARRIVE_MS,
  arriveDelay,
  arriveLayer,
  artboardMarkup,
  artboardSize,
  type Develop,
  develop,
  Icon,
  loadArtboardFonts,
  MemorySource,
  pinClass,
  pinWrapClass,
  Ring,
  SLICE,
  SLICE_STROKE,
  ThreadCard,
  WorkingStatus,
} from "@ponzu/react";
import { type CSSProperties, memo, useLayoutEffect, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";
import type { Edit, Scene } from "./edit.ts";
import { pinSpot, schemeFor } from "./model.ts";

const PIN_IN = 0.32;
/** How far a film's pin sits up and right of its spot, in film px. */
const PIN_NUDGE = 11;
/** A resolved pin: pops to a check, holds, then shrinks away. */
const RESOLVE = 0.95;

type FilmModel = Edit;

/** What the film's shared pieces (boards, prompt, wayfinding, end card) need of a film. */
export type FilmLook = Pick<Edit, "name" | "prompt" | "view" | "theme" | "assetBase">;

interface Frame {
  doc: Doc;
  heights: Map<string, number>;
  cam: Cam;
  /** The board an agent is working on, with its mark. */
  working?: { board: string; who: { name: string; client?: string } };
  /** Pieces rising, and how far into their rise (ms), by data-id. */
  rising?: { ids: string[]; at: number[] };
  /** A board being drawn in: 0 → 1. */
  drawing?: { board: string; p: number };
  /** Pins: open threads, with how far they've popped in or out. */
  threads: Thread[];
  pinIn?: { thread: string; p: number };
  pinsOut?: { thread: Thread; p: number }[];
  /** The one card showing, and what it's about (canvas px), which it keeps clear of. */
  card?: {
    thread: Thread;
    /** Opening out of the pin, and closing back into it: 0 → 1 each. */
    open: number;
    close: number;
    /** How much of the comment has typed in: 0 → 1. */
    typed: number;
    now: number;
    subject?: { x: number; y: number; w: number; h: number };
  };
  /** The person's cursor, coming to place a comment: canvas px, its glide 0 → 1, a press. */
  cursor?: {
    to: { x: number; y: number };
    from?: "edge";
    p: number;
    down: boolean;
    fade: number;
    fadeIn: number;
  };
  /** The end card: 0 → 1 fade, and its own clock. */
  end?: { fade: number; t: number };
  /** The last look: only these boards stay; the rest fade by `p`. */
  only?: { ids: string[]; p: number };
  /**
   * The board as it was, over its new look, fading out: a replaced piece crossfades. With
   * `only`, just those pieces of it (what the change took away), never the rest a second time.
   */
  ghost?: { board: Artboard; doc: Doc; p: number; only?: string[] };
  /** Pieces sliding to where the change put them: how far they still are from it (board px). */
  moving?: { id: string; dx: number; dy: number }[];
  /** The opening prompt: how much is typed, whether it's sent, and how far it's gone. */
  prompt?: { typed: number; sent: number; out: number };
  /** New artboards settling in as the agent makes them: 0 → 1. */
  sheets?: { id: string; p: number }[];
  /** At rest in a tall frame: the boards beside the subject recede by `p` (0 → 1). */
  dim?: { ids: string[]; p: number };
}

/** The canvas at film time `f`: one settled state, a camera, and what's animating. */
function frameAt(e: Edit, f: number): Frame {
  const tl = e.timeline;
  // The opening: what the person asked for, typed and sent, over the canvas the agent starts on.
  if (tl.prompt && e.prompt && f < tl.prompt.end) {
    const first = e.scenes[0];
    const doc = first?.before ?? e.first.doc;
    const heights = first?.heights.before ?? e.first.heights;
    const cam = first?.cams[0] ?? e.result.cam;
    return { doc, heights, cam, threads: [], prompt: promptState(tl.prompt, f) };
  }
  const { index, phase } = shotAt(tl, f);
  const scene = e.scenes[index];
  if (!scene || phase === "result" || phase === "end") {
    const from = scene ? sceneCam(scene, scene.shot.end, e.view) : e.result.cam;
    const p = ease.inOut(clamp01((f - tl.result) / 1.0));
    const lean = 1 + 0.03 * progress(f, tl.result + 1, tl.endCard, ease.inOut);
    const to = { ...e.result.cam, zoom: e.result.cam.zoom * lean };
    const cam = from.page === to.page ? flyTo(from, to, p, e.view) : to;
    const doc = e.result.doc;
    // The result, clean: the conversation's done, so its pins are off the final picture.
    const out: Frame = { doc, heights: e.result.heights, cam, threads: [] };
    if (e.result.boards.length) {
      // Already faded if the last fix was on the result board; else they fade as the camera goes.
      const last = e.scenes.at(-1);
      const done = last?.board && e.result.boards.includes(last.board);
      out.only = {
        ids: e.result.boards,
        p: done ? 1 : progress(f, tl.result + 0.15, tl.result + 0.85, ease.inOut),
      };
    }
    if (f >= tl.endCard - 0.3)
      out.end = { fade: clamp01((f - (tl.endCard - 0.3)) / 0.3), t: f - tl.endCard };
    return out;
  }
  const s = scene.shot;
  // Travelling: the canvas is this shot's before; the camera glides from the last shot's rest.
  const prevScene = e.scenes[index - 1];
  const from = prevScene ? sceneCam(prevScene, prevScene.shot.end, e.view) : scene.cams[0]!;
  if (phase === "travel") {
    const p = ease.inOut(clamp01((f - s.start) / Math.max(0.001, s.arrive - s.start)));
    const to = scene.cams[0]!;
    const cam = from.page === to.page ? flyTo(from, to, p, e.view) : p < 0.5 ? from : to;
    return {
      doc: scene.before,
      heights: scene.heights.before,
      cam,
      // On the way to a fix, only its board's pins (as when it lands): no stray stories.
      threads: told(scene, open(scene.before)).filter(
        (t) => scene.shot.moment.kind !== "work" || t.artboardId === scene.board,
      ),
    };
  }
  const fr = scene.shot.moment.kind === "turn" ? turnFrame(e, scene, f) : workFrame(e, scene, f);
  // A tall frame shows one subject: once the camera rests, the boards beside it recede, and come
  // back as it leaves.
  // The build moves from board to board itself: nothing recedes while the canvas fills in.
  if (e.view.h > e.view.w && !fr.only && !(scene.build?.length && f < scene.shot.end)) {
    // In a turn, the board of the card being read (pin-only comments land without moving it).
    const l = scene.shot.landings ?? [];
    // The subject switches at the middle of a hop, when every board is up: no pop.
    const k = landingIndex(scene, f + 0.3);
    let card = l.findIndex((x, i) => x.card && i >= k);
    for (let i = k; i >= 0; i--)
      if (l[i]?.card) {
        card = i;
        break;
      }
    const here = scene.board ? [scene.board] : (scene.subjectBoards?.[Math.max(0, card)] ?? []);
    // The board the camera goes to next never recedes: it arrives as it is.
    const nextScene = e.scenes[index + 1];
    const ids = [
      ...here,
      ...(nextScene?.board ? [nextScene.board] : (nextScene?.subjectBoards?.flat() ?? [])),
    ];
    const next = e.scenes[index + 1];
    const leaving = next ? next.shot.start : tl.result;
    // Only a real rest: a quick beat doesn't flicker its neighbours down and back up.
    if (ids.length && leaving - s.arrive >= 1.6) {
      // Around a hop to another board's card, everything comes back up: no board arrives dimmed.
      const hop = l.find((x, i) => x.hop && Math.abs(f - x.at) < 1 && i > 0);
      const around = hop ? 1 - Math.min(1, Math.abs(f - (hop.at - 0.3)) / 0.7) : 0;
      fr.dim = {
        ids,
        p:
          (1 - around) *
          Math.min(
            progress(f, s.arrive, s.arrive + 0.35, ease.out),
            1 - progress(f, leaving - 0.3, leaving, ease.in),
          ),
      };
    }
  }
  return fr;
}

/** Where a scene's camera is at time `f` (a turn's camera hops between its comments). */
function sceneCam(scene: Scene, f: number, view: { w: number; h: number }): Cam {
  const l = scene.shot.landings;
  // The build ends where its camera was, not back at its first board.
  if (scene.build?.length && scene.buildCams && f >= scene.shot.change)
    return buildCam(view, scene, f, buildTimes(scene));
  // At rest on a result, the camera leans in a touch, so a hold is never a still.
  if (scene.shot.moment.kind === "work") {
    const c = scene.cams[0]!;
    const k = 1 + 0.035 * progress(f, scene.shot.changed, scene.shot.end + 1.5, ease.inOut);
    return { ...c, zoom: c.zoom * k };
  }
  if (!l?.length || scene.cams.length < 2) return scene.cams[0]!;
  // The camera only moves on a hop (a card on another board), gliding in the gap before that
  // card lands; pin-only landings keep it still.
  const GLIDE = 0.8;
  let i = 0;
  while (i + 1 < l.length && l[i + 1]!.at <= f) i++;
  const next = l[i + 1];
  if (next?.hop && f > next.at - GLIDE) {
    const p = ease.inOut(clamp01((f - (next.at - GLIDE)) / GLIDE));
    return flyTo(scene.cams[i]!, scene.cams[i + 1]!, p, view);
  }
  return scene.cams[i]!;
}

const open = (doc: Doc) => doc.threads.filter((t) => t.status === "open");
/** Of these threads, the ones the film's story has open at this shot. */
const told = (scene: Scene, threads: Thread[]) => threads.filter((t) => scene.told.includes(t.id));

/**
 * The opening build: the canvas as the agent wrote it, one write after another, each write's new
 * pieces rising in as they did on the canvas. The camera rests on the board being written and
 * glides to the next board as the agent moves on. Writes come quicker as a board fills, so its
 * first pieces read and the rest pour in.
 */
function buildFrame(e: Edit, scene: Scene, f: number): Frame | null {
  const steps = scene.build;
  const s = scene.shot;
  if (!steps?.length || f < s.change) return null;
  const times = buildTimes(scene);
  let k = 0;
  while (k + 1 < steps.length && times[k + 1]! <= f) k++;
  const step = steps[k]!;
  // Pieces still rising from the last few writes, each from its own start.
  const ids: string[] = [];
  const at: number[] = [];
  for (let j = Math.max(0, k - 8); j <= k; j++) {
    steps[j]!.arrive.forEach((id, i) => {
      if (!findNodeIn(step.doc, id)) return;
      ids.push(id);
      at.push((f - times[j]!) * 1000 - arriveDelay(i));
    });
  }
  // New boards: a sheet is uncovered top first as its first pieces start, so it's never seen bare
  // (a dark one never a black slab).
  const sheets: { id: string; p: number }[] = [];
  for (let j = Math.max(0, k - 3); j <= k; j++)
    for (const id of steps[j]!.boards) {
      const p = clamp01(((f - times[j]!) * 1000 - ARRIVE_LAG_MS) / ARRIVE_MS);
      if (p < 1) sheets.push({ id, p: ease.out(p) });
    }
  return {
    doc: step.doc,
    heights: step.heights,
    cam: buildCam(e.view, scene, f, times),
    threads: [],
    // The agent's mark stays on the board being written until the build is done.
    ...(f < s.changed + 0.2
      ? { working: { board: step.board, who: scene.who ?? { name: "Agent" } } }
      : {}),
    rising: { ids, at },
    ...(sheets.length ? { sheets } : {}),
  };
}

/**
 * The prompt's beats: it rises in, types itself, a moment to read, sent (the button presses and
 * the agent's mark lights), then it lifts away as the canvas begins.
 */
export function promptState(span: { start: number; end: number }, f: number) {
  const d = span.end - span.start;
  const t = f - span.start;
  return {
    typed: progress(t, 0.1, d * 0.46, (x) => x),
    sent: progress(t, d * 0.52, d * 0.52 + 0.18, ease.out),
    out: progress(t, d - 0.38, d, ease.in),
  };
}

/** Between boards in the build: a short glide. */
const BUILD_GLIDE = 0.55;
/** How much of that glide comes before the next board's first write lands. */
const GLIDE_PRE = 0.38;
/** After a board's last piece has risen, a beat to see it whole before the camera moves on. */
const BUILD_REST = 0.45;

/**
 * When each build step lands. Each board's writes come quicker as it fills; it's finished (its
 * last piece fully risen) and rests a beat before the camera leaves for the next.
 */
function buildTimes(scene: Scene): number[] {
  const steps = scene.build ?? [];
  const s = scene.shot;
  const rise = ARRIVE_MS / 1000;
  const runs: number[][] = [];
  steps.forEach((st, i) => {
    if (i === 0 || st.board !== steps[i - 1]!.board) runs.push([]);
    runs.at(-1)!.push(i);
  });
  // Each run ends with its last rise and a rest; then a glide to the next.
  // Every board finishes inside the shot: the last one's pieces have risen by the end of it.
  const overhead = runs.length * (rise + BUILD_REST) + (runs.length - 1) * GLIDE_PRE;
  const span = Math.max(0.4 * runs.length, s.changed - s.change - overhead);
  // The first board is where the viewer learns what's happening: it gets more time.
  const weight = (i: number, n: number) => (i === 0 ? n * 1.6 + 1 : n + 1);
  const total = runs.reduce((a, x, i) => a + weight(i, x.length), 0);
  const out: number[] = [];
  let t = s.change;
  for (const [r, run] of runs.entries()) {
    const share = (span * weight(r, run.length)) / total;
    run.forEach((_, j) => {
      out.push(t + share * (run.length > 1 ? (j / (run.length - 1)) ** 1.35 : 0));
    });
    t += share + rise + BUILD_REST + GLIDE_PRE;
  }
  return out;
}

/** How the build's camera trails the writing: two smoothing stages of this many seconds each. */
const FOLLOW = 0.24;
/** The camera heads for a write a moment before it lands, so the piece arrives in frame. */
const FOLLOW_LEAD = 0.3;
const FOLLOW_DT = 1 / 60;
const follows = new WeakMap<Scene, Cam[]>();

/**
 * The build's camera: it follows the writing, close on what's written so far and pulling back as
 * the board fills; it glides to the next board as the agent moves on. A smooth chase of each
 * write's framing, worked out once per scene so every frame is a pure lookup.
 */
function buildCam(view: { w: number; h: number }, scene: Scene, f: number, times: number[]): Cam {
  const steps = scene.build!;
  const s = scene.shot;
  let track = follows.get(scene);
  if (!track) {
    track = [];
    const camOf = (k: number) =>
      steps[k]!.cam ?? scene.buildCams!.get(steps[k]!.board) ?? scene.cams[0]!;
    const target = (t: number) => {
      let k = 0;
      // Ahead to the next write on this board; onto another board only by its glide.
      while (
        k + 1 < steps.length &&
        times[k + 1]! - (steps[k + 1]!.board === steps[k]!.board ? FOLLOW_LEAD : 0) <= t
      )
        k++;
      // Onto another board: an even glide that lands as its first pieces are uncovered, so the
      // camera never waits on bare canvas.
      const into = steps.findIndex(
        (st, j) =>
          j > 0 &&
          st.board !== steps[j - 1]!.board &&
          t >= times[j]! - GLIDE_PRE &&
          t < times[j]! - GLIDE_PRE + BUILD_GLIDE,
      );
      if (into > 0) {
        const p = ease.inOut(clamp01((t - (times[into]! - GLIDE_PRE)) / BUILD_GLIDE));
        return { cam: flyTo(camOf(into - 1), camOf(into), p, view), glide: true };
      }
      return { cam: camOf(k), glide: false };
    };
    const first = target(s.change).cam;
    let a = { x: first.cx, y: first.cy, z: Math.log(first.zoom) };
    let b = { ...a };
    const n = Math.ceil((s.end + 2 - s.change) / FOLLOW_DT);
    const k = 1 - Math.exp(-FOLLOW_DT / FOLLOW);
    for (let i = 0; i <= n; i++) {
      const { cam, glide } = target(s.change + i * FOLLOW_DT);
      const goal = { x: cam.cx, y: cam.cy, z: Math.log(cam.zoom) };
      if (glide) {
        // A glide is its own ease: the chase lets go of it.
        a = goal;
        b = goal;
      } else {
        a = {
          x: a.x + (goal.x - a.x) * k,
          y: a.y + (goal.y - a.y) * k,
          z: a.z + (goal.z - a.z) * k,
        };
        b = { x: b.x + (a.x - b.x) * k, y: b.y + (a.y - b.y) * k, z: b.z + (a.z - b.z) * k };
      }
      track.push({ page: cam.page, cx: b.x, cy: b.y, zoom: Math.exp(b.z) });
    }
    follows.set(scene, track);
  }
  const i = Math.max(0, Math.min(track.length - 1, Math.round((f - s.change) / FOLLOW_DT)));
  return track[i]!;
}

const findNodeIn = (doc: Doc, id: string) =>
  doc.pages.some((p) => p.artboards.some((ab) => ab.id === id || Boolean(findNode(ab.root, id))));

/** Seconds between one piece of a fix rising and the next. */
function riseStep(scene: Scene): number {
  const n = scene.rise?.length ?? 0;
  const span = Math.max(0, scene.shot.changed - scene.shot.change - ARRIVE_MS / 1000);
  return n > 1 ? Math.min(0.09, span / (n - 1)) : 0;
}

function workFrame(e: Edit, scene: Scene, f: number): Frame {
  const s = scene.shot;
  // The opening build owns its whole shot, its last look included: the canvas is the build's end.
  const built = buildFrame(e, scene, f);
  if (built) return built;
  const cam = sceneCam(scene, f, e.view);
  const changing = f >= s.change;
  const doc = changing ? scene.after : scene.before;
  const heights = changing ? scene.heights.after : scene.heights.before;
  const out: Frame = {
    doc,
    heights,
    cam,
    // On a fix, only the pins it answers: other boards' pins wait their turn off this shot.
    threads: told(scene, open(doc)).filter((t) => t.artboardId === scene.board),
    ...(scene.board && f < s.changed + 0.35
      ? { working: { board: scene.board, who: scene.who ?? { name: "Agent" } } }
      : {}),
  };
  // The pins this work answers stay up, numbered, until it has landed, then leave.
  if (changing) {
    const leaving = (scene.resolves ?? [])
      .map((id) => scene.before.threads.find((t) => t.id === id))
      .filter((t): t is Thread => Boolean(t) && scene.told.includes(t!.id));
    // Resolved: once every piece of the change has risen and the old look has gone, and a beat
    // to see it, the pin pops to a check, holds a beat, then shrinks away. Until then it's the
    // numbered pin it was: the check confirms what's there.
    const n = scene.rise?.length ?? 0;
    const settled =
      s.change + riseStep(scene) * Math.max(0, n - 1) + (n ? ARRIVE_MS / 1000 : 0.45) + 0.25;
    out.threads = out.threads.filter((t) => !(scene.resolves ?? []).includes(t.id));
    if (f < settled) out.threads.push(...leaving.filter((t) => !out.threads.includes(t)));
    else {
      const p = clamp01((f - settled) / RESOLVE);
      if (p < 1) out.pinsOut = leaving.map((thread) => ({ thread, p }));
    }
  }
  // The last fix: once it's landed, the boards around it fade, so the result stands alone.
  if (scene === e.scenes.at(-1) && scene.board && e.result.boards.includes(scene.board))
    out.only = {
      ids: e.result.boards,
      p: progress(f, s.changed - 0.2, s.changed + 0.5, ease.inOut),
    };
  // What was there gives way to what replaces it: the pieces taken away or restyled fade off
  // where they were, the pieces that only moved slide to their new places, and the new rise in.
  // Nothing is drawn twice: the old look is only the pieces that went.
  if (changing && !scene.born && scene.board && scene !== e.scenes[0]) {
    const was = findArtboard(scene.before, scene.board)?.artboard;
    const p = scene.rise?.length
      ? progress(f, s.change, s.change + 0.18, ease.out)
      : progress(f, s.change, s.change + 0.45, ease.inOut);
    if (was && p < 1)
      out.ghost = {
        board: was,
        doc: scene.before,
        p,
        ...(scene.gone || scene.moves ? { only: scene.gone ?? [] } : {}),
      };
    if (scene.moves?.length) {
      const m = ease.inOut(clamp01((f - s.change) / 0.5));
      if (m < 1)
        out.moving = scene.moves.map((x) => ({ id: x.id, dx: x.dx * (1 - m), dy: x.dy * (1 - m) }));
    }
  }
  if (changing && scene.born)
    out.drawing = { board: scene.board!, p: ease.out(clamp01((f - s.change) / 0.5)) };
  if (changing && scene.rise?.length) {
    const step = riseStep(scene);
    out.rising = {
      ids: scene.rise,
      at: scene.rise.map((_, i) => (f - s.change - i * step) * 1000),
    };
  }
  return out;
}

/** Which of a turn's comments has landed last at `f` (-1 before the first). */
function landingIndex(scene: Scene, f: number): number {
  const l = scene.shot.landings ?? [];
  let k = -1;
  for (let i = 0; i < l.length; i++) if (l[i]!.at <= f) k = i;
  return k;
}

function turnFrame(e: Edit, scene: Scene, f: number): Frame {
  const s = scene.shot;
  const l = s.landings ?? [];
  let k = -1;
  for (let i = 0; i < l.length; i++) if (l[i]!.at <= f) k = i;
  // What's told so far, and this turn's comments as they've landed.
  const mine = new Set(l.slice(0, k + 1).map((x) => x.comment.thread));
  const pool = k >= 0 ? scene.threads![k]! : scene.before.threads;
  const threads = pool.filter(
    (t) => t.status === "open" && (scene.told.includes(t.id) || mine.has(t.id)),
  );
  const cam = sceneCam(scene, f, e.view);
  const out: Frame = { doc: scene.before, heights: scene.heights.before, cam, threads };
  if (k >= 0) {
    const cur = l[k]!;
    const short = e.timeline.duration <= 16;
    // A card arrives: the cursor glides to its spot and clicks, the pin springs in, the card
    // opens out of the pin and the words type in. A pin-only comment just pops.
    const glide = cur.card ? COMMENT_IN.cursor * (short ? 0.75 : 1) : 0;
    const click = cur.at + glide;
    const pinAt = cur.card ? click + COMMENT_IN.click : cur.at;
    // Until the click, the comment isn't there yet.
    if (f < pinAt) out.threads = threads.filter((t) => t.id !== cur.comment.thread);
    else out.pinIn = { thread: cur.comment.thread, p: clamp01((f - pinAt) / PIN_IN) };
    if (cur.card) {
      // Out a beat before the next lands or the camera hops.
      const until = Math.min(
        cur.until,
        (l[k + 1]?.at ?? s.changed) - (l[k + 1]?.hop ? 0.82 : 0.08),
      );
      const t = threads.find((x) => x.id === cur.comment.thread);
      const open = progress(f, pinAt + 0.04, pinAt + 0.04 + COMMENT_IN.open, ease.out);
      const close = progress(f, until - 0.22, until, ease.in);
      const typeStart = pinAt + 0.04 + COMMENT_IN.open * 0.6;
      const typed = progress(
        f,
        typeStart,
        typeStart + typeTime(cur.comment.words) * (short ? 0.8 : 1),
        (x) => x,
      );
      if (t && open > 0.001 && close < 0.999)
        out.card = {
          // A long comment shows as an excerpt of the person's own words.
          thread: {
            ...t,
            messages: t.messages.map((msg, i) =>
              i === 0 ? { ...msg, text: excerpt(msg.text) } : msg,
            ),
          },
          open,
          close,
          typed,
          now: cur.comment.t + 1000,
          subject: scene.subjects?.[k],
        };
      // The cursor: in from the frame's edge (or the last card), to the pin, a press, then away.
      const pin = t ? (pinSpot(scene.before, t) ?? pinSpot(e.result.doc, t)) : null;
      if (pin && f < pinAt + 0.5) {
        const prev = l
          .slice(0, k)
          .reverse()
          .find((x) => x.card);
        out.cursor = {
          to: { x: pin.x, y: pin.y },
          from: prev ? undefined : "edge",
          p: ease.inOut(clamp01((f - cur.at) / Math.max(0.001, glide))),
          down: f >= click && f < click + 0.16,
          fade: 1 - progress(f, pinAt + 0.2, pinAt + 0.5, ease.in),
          fadeIn: progress(f, cur.at, cur.at + 0.15, ease.out),
        };
      }
    }
  }
  return out;
}

/**
 * One frame of a timelapse, as a pure function of film time `f` (seconds):
 * the canvas with the real artboard renderer, pins, thread cards, trace and
 * working status, under a resting or gliding camera; then the brand's end card.
 */
export function Film({ model, f }: { model: FilmModel; f: number }) {
  const { view } = model;
  const fr = frameAt(model, f);
  const { doc, cam, heights } = fr;
  const page = doc.pages.find((p) => p.id === cam.page) ?? doc.pages[0];
  const root = useRef<HTMLDivElement>(null);
  const empty = useMemo(() => new MemorySource(model.first.doc), [model]);

  const tx = view.w / 2 - cam.cx * cam.zoom;
  const ty = view.h / 2 - cam.cy * cam.zoom;
  const toScreen = (x: number, y: number) => ({ x: x * cam.zoom + tx, y: y * cam.zoom + ty });
  const boards = page?.artboards ?? [];

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    applyRise(el, fr.rising);
    applyMoves(el, fr.moving);
    styleCards(el);
    keepCardsInFrame(el, view);
  });

  return (
    <div
      ref={root}
      className={cn("pz-root pz-film", `pz-${model.theme}`)}
      style={{ width: view.w, height: view.h }}
      data-film-frame={Math.round(f * 1000)}
    >
      <div className="pz:absolute pz:inset-0 pz:overflow-hidden">
        {/* Each board placed in screen space with its own transform (see the capture note in git history). */}
        <div className="pz:absolute pz:inset-0">
          {boards.map((ab) => {
            const who = fr.working?.board === ab.id ? fr.working.who : undefined;
            const { w, h } = artboardSize(ab);
            const bh = heights.get(ab.id) ?? h ?? 900;
            const s0 = toScreen(ab.x, ab.y - 40);
            const s1 = toScreen(ab.x + w, ab.y + bh);
            const offscreen = s1.x < -40 || s0.x > view.w + 40 || s1.y < -40 || s0.y > view.h + 40;
            const drawing = fr.drawing?.board === ab.id ? fr.drawing.p : 1;
            const sheet = fr.sheets?.find((x) => x.id === ab.id)?.p ?? 1;
            // Receding: a wash of the canvas over it, so it falls back into the page, never grey.
            const veil =
              fr.only && !fr.only.ids.includes(ab.id)
                ? fr.only.p
                : fr.dim && !fr.dim.ids.includes(ab.id)
                  ? fr.dim.p
                  : 0;
            return (
              <div
                key={ab.id}
                className="pz-film-board pz:absolute pz:shadow-board"
                style={{
                  display: offscreen ? "none" : undefined,
                  opacity: undefined,
                  boxShadow: veil > 0.5 ? "none" : undefined,
                  left: 0,
                  top: 0,
                  transform: `translate(${ab.x * cam.zoom + tx}px, ${ab.y * cam.zoom + ty}px) scale(${cam.zoom})`,
                  transformOrigin: "0 0",
                  width: w,
                  height: h ?? undefined,
                  // Rounded as on the canvas: a few px on screen.
                  borderRadius: 4 / cam.zoom,
                  ["--pz-board-radius" as string]: `${4 / cam.zoom}px`,
                  // A new board is drawn in from the top, solid: a dark one never passes through grey.
                  // A new sheet is uncovered top first with its first pieces (the develop).
                  clipPath:
                    Math.min(drawing, sheet) < 1
                      ? `inset(-40px -40px ${(1 - Math.min(drawing, sheet)) * 100}% -40px)`
                      : undefined,
                }}
              >
                <div
                  className={cn(
                    "pz:absolute pz:left-0 pz:flex pz:items-center pz:gap-[0.5em] pz:whitespace-nowrap pz:leading-[1.4] pz:max-w-full",
                    who ? "pz:right-0 pz:text-foreground" : "pz:text-muted-foreground",
                  )}
                  style={{ fontSize: 12 / cam.zoom, top: -22 / cam.zoom, opacity: 1 - veil }}
                >
                  <span className="pz:min-w-0 pz:truncate">{ab.name}</span>
                  {who && (
                    <WorkingStatus
                      who={[{ id: who.name, name: who.name, client: who.client }]}
                      zoom={cam.zoom}
                    />
                  )}
                </div>
                <FilmBoard artboard={ab} doc={doc} model={model} />
                {fr.ghost?.board.id === ab.id && (
                  <div
                    style={{
                      position: "absolute",
                      left: 0,
                      top: 0,
                      width: w,
                      opacity: 1 - fr.ghost.p,
                    }}
                  >
                    <FilmBoard
                      artboard={fr.ghost.board}
                      doc={fr.ghost.doc}
                      model={model}
                      only={fr.ghost.only}
                    />
                  </div>
                )}
                {veil > 0 && (
                  <div
                    style={{
                      position: "absolute",
                      left: -2,
                      top: -2,
                      width: w + 4,
                      height: bh + 4,
                      background: "var(--canvas)",
                      opacity: veil,
                      zIndex: 1,
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>

        <div className="pz:pointer-events-none pz:absolute pz:inset-0">
          {fr.working &&
            (() => {
              const ab = boards.find((b) => b.id === fr.working!.board);
              if (!ab) return null;
              const p = toScreen(ab.x, ab.y);
              const h = heights.get(ab.id) ?? artboardSize(ab).h ?? 900;
              const w = artboardSize(ab).w * cam.zoom;
              // The board's own header is above the frame (a close shot): its name and the
              // agent's mark ride the top of the board's visible part, so the agent is always seen.
              const headerY = p.y - 22;
              const pinned = (headerY < 14 || p.x < 0) && p.y + h * cam.zoom > 120;
              return (
                <>
                  <Ring x={p.x} y={p.y} w={w} h={h * cam.zoom} />
                  {pinned && (
                    <div
                      className="pz-film-badge pz:absolute pz:flex pz:items-center pz:gap-[0.5em] pz:whitespace-nowrap pz:rounded-xl pz:bg-bar pz:text-foreground pz:leading-none pz:shadow-bar pz:backdrop-blur-[18px] pz:backdrop-saturate-[1.6]"
                      style={{
                        right: 14,
                        top: 14,
                        maxWidth: view.w * 0.42,
                        padding: `${6 * (view.w < view.h ? 1.08 : 1)}px ${10 * (view.w < view.h ? 1.08 : 1)}px`,
                        fontSize: 12.5 * (view.w < view.h ? 1.08 : 1),
                      }}
                    >
                      <span className="pz:min-w-0 pz:truncate">{ab.name}</span>
                      <WorkingStatus
                        who={[
                          {
                            id: fr.working!.who.name,
                            name: fr.working!.who.name,
                            client: fr.working!.who.client,
                          },
                        ]}
                        zoom={1}
                      />
                    </div>
                  )}
                </>
              );
            })()}
          {[
            ...fr.threads.map((t) => ({
              t,
              scale: 1,
              opacity: 1,
              popping: fr.pinIn?.thread === t.id,
            })),
            ...(fr.pinsOut ?? []).map(({ thread, p }) => ({
              t: thread,
              // A pop past full size, a hold, then away.
              scale:
                p < 0.25
                  ? 1 + 0.32 * ease.out(p / 0.25)
                  : p < 0.6
                    ? 1.32 - 0.12 * ease.inOut((p - 0.25) / 0.35)
                    : 1.2 * (1 - 0.75 * ease.in((p - 0.6) / 0.4)),
              opacity: 1 - progress(p, 0.7, 1, ease.in),
              popping: false,
              done: true,
            })),
          ].map(({ t, scale: s0, opacity: o0, popping, ...rest }) => {
            const done = "done" in rest;
            const spot = pinSpot(doc, t) ?? pinSpot(model.first.doc, t);
            if (!spot || spot.page !== cam.page) return null;
            let scale = s0;
            let opacity = o0;
            if (popping && fr.pinIn!.p < 1) {
              const p = fr.pinIn!.p;
              scale =
                p < 0.55
                  ? 0.5 + 0.64 * ease.out(p / 0.55)
                  : 1.14 - 0.14 * ease.inOut((p - 0.55) / 0.45);
              opacity = clamp01(p * 3);
            }
            // Just up and right of the spot, so the pin points at what it's about without
            // sitting on it (a pin on a headline reads as a stray letter).
            const at = toScreen(spot.x, spot.y);
            const sp = { x: at.x + PIN_NUDGE, y: at.y - PIN_NUDGE };
            const card = fr.card?.thread.id === t.id ? fr.card : undefined;
            return (
              <div
                key={t.id}
                className={cn(pinWrapClass, card ? "pz:z-[3]" : "pz:z-[2]")}
                style={{ left: sp.x, top: sp.y }}
              >
                <span
                  className={cn(pinClass, "pz-film-pin pz:bg-comment pz:text-comment-foreground")}
                  style={{ scale: String(scale), opacity }}
                >
                  {done ? <Icon name="check" size={13} strokeWidth={2.4} /> : t.messages.length}
                </span>
                {card && (
                  <div
                    data-film-card
                    data-subject={
                      card.subject
                        ? JSON.stringify(
                            (() => {
                              const a = toScreen(card.subject.x, card.subject.y);
                              return {
                                x: a.x,
                                y: a.y,
                                w: card.subject.w * cam.zoom,
                                h: card.subject.h * cam.zoom,
                              };
                            })(),
                          )
                        : undefined
                    }
                    data-open={card.open * (1 - card.close)}
                    data-typed={card.typed}
                    className="pz-film-card"
                    style={{
                      // Read on a phone: the real card, a little larger than in the studio.
                      zoom: view.w > view.h ? 2.1 : 1.6,
                    }}
                  >
                    <ThreadCard
                      thread={card.thread}
                      source={empty}
                      me={{ kind: "user", name: "" }}
                      onClose={() => {}}
                      bare
                      now={card.now}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {fr.cursor &&
          (() => {
            const c = fr.cursor;
            const to = toScreen(c.to.x, c.to.y);
            // From below and to the right of the pin, as a hand comes in to point.
            const from = { x: to.x + view.w * 0.22, y: to.y + view.h * 0.18 };
            const x = from.x + (to.x - from.x) * c.p;
            const y = from.y + (to.y - from.y) * c.p;
            const k = view.w > view.h ? 1.9 : 1.5;
            return (
              <div
                className="pz:pointer-events-none pz:absolute pz:z-[4]"
                style={{
                  left: 0,
                  top: 0,
                  // The arrow's tip is at the pin.
                  transform: `translate(${x - 3 * k}px, ${y - 2.2 * k}px) scale(${c.down ? 0.86 : 1})`,
                  transformOrigin: `${3 * k}px ${2.2 * k}px`,
                  opacity: Math.min(c.fade, c.fadeIn),
                }}
              >
                <svg width={22 * k} height={22 * k} viewBox="0 0 22 22" aria-hidden>
                  <path
                    d="M3 2.2v15.6l4.2-3.9 2.7 6.1 2.8-1.2-2.7-6h5.9Z"
                    fill="#0e0e0e"
                    stroke="#fff"
                    strokeWidth="1.4"
                    strokeLinejoin="round"
                    style={{ filter: "drop-shadow(0 1px 1.5px rgb(0 0 0 / 0.35))" }}
                  />
                </svg>
              </div>
            );
          })()}
        <Wayfinding model={model} doc={doc} pageId={cam.page} />
      </div>
      {fr.prompt && model.prompt && <Prompt model={model} state={fr.prompt} />}
      {fr.end && (
        <EndCard model={model} t={Math.max(0, fr.end.t)} opacity={ease.out(fr.end.fade)} />
      )}
    </div>
  );
}

/** One artboard, drawn the way the canvas draws it. Replaces its markup only when it changed. */
export const FilmBoard = memo(function FilmBoard({
  artboard,
  doc,
  model,
  only,
}: {
  artboard: Artboard;
  doc: Doc;
  model: FilmLook;
  /** Draw just these pieces (and what's in them); the rest of the board is there but unseen. */
  only?: string[];
}) {
  const host = useRef<HTMLDivElement>(null);
  const last = useRef("");
  const scheme = schemeFor(doc, artboard, model.theme);
  const onlyKey = only?.join(" ");
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const root = el.shadowRoot ?? el.attachShadow({ mode: "open" });
    const {
      html: board,
      fonts,
      faces,
    } = artboardMarkup(artboard, doc.tokens, model.assetBase, scheme, true);
    const ids = onlyKey ? onlyKey.split(" ") : onlyKey === "" ? [] : undefined;
    const sel = (ids ?? []).map((id) => `[data-id="${CSS.escape(id)}"]`);
    const html = ids
      ? `${board}<style>*{visibility:hidden!important}${sel.length ? `${sel.join(",")},${sel.map((s) => `${s} *`).join(",")}{visibility:visible!important}` : ""}</style>`
      : board;
    if (html === last.current) return;
    last.current = html;
    loadArtboardFonts(fonts, faces);
    root.innerHTML = html;
  }, [artboard, doc.tokens, model.assetBase, scheme, onlyKey]);
  return <div ref={host} data-artboard-host={artboard.id} style={{ display: "contents" }} />;
});

/** New pieces developing; driven from film time. */
const developing = new Map<Element, Develop>();

/** `ms`: how long each arrival takes (the canvas's own pace unless a film quickens it). */
export function applyRise(root: HTMLElement, r: Frame["rising"], ms = ARRIVE_MS) {
  const live = new Set<Element>();
  if (r)
    r.ids.forEach((id, n) => {
      const local = r.at[n]!;
      if (local >= ms) return;
      for (const host of root.querySelectorAll("[data-artboard-host]")) {
        const shadow = host.shadowRoot;
        const el = shadow?.querySelector(`[data-id="${CSS.escape(id)}"]`);
        if (!shadow || !el || live.has(el)) continue;
        live.add(el);
        let d = developing.get(el);
        if (!d) {
          // The canvas's own arrival (the develop), seeked: the film shows what the person saw.
          d = develop(el, arriveLayer(shadow), ms);
          for (const a of d.animations) a.pause();
          developing.set(el, d);
        }
        // Before its turn (the beat after its write, its place in the stagger) it waits hidden.
        for (const a of d.animations) a.currentTime = Math.max(0, local);
      }
    });
  for (const [el, d] of developing) {
    if (live.has(el)) continue;
    d.cancel();
    developing.delete(el);
  }
}

/** Pieces a change moved, drawn where they still are on their way (the live board, not the ghost). */
const moved = new Set<HTMLElement>();

function applyMoves(root: HTMLElement, m: Frame["moving"]) {
  const live = new Set<HTMLElement>();
  for (const x of m ?? [])
    for (const host of root.querySelectorAll(".pz-film-board > [data-artboard-host]")) {
      const el = host.shadowRoot?.querySelector<HTMLElement>(`[data-id="${CSS.escape(x.id)}"]`);
      if (!el) continue;
      el.style.translate = `${x.dx}px ${x.dy}px`;
      live.add(el);
      moved.add(el);
    }
  for (const el of moved)
    if (!live.has(el)) {
      el.style.translate = "";
      moved.delete(el);
    }
}

/**
 * A card's comment typed in so far: the words still to come are there but unseen, so the card is
 * its full size from the first frame and the words fill it rather than push it around. Then it
 * opens out of its pin, and later folds back into it.
 */
function styleCards(root: HTMLElement) {
  for (const wrap of root.querySelectorAll<HTMLElement>("[data-film-card]")) {
    const card = wrap.firstElementChild as HTMLElement | null;
    const text = card?.querySelector<HTMLElement>("[data-message-text]");
    const typed = Number(wrap.dataset.typed ?? 1);
    if (text) {
      const full = text.dataset.full ?? text.textContent ?? "";
      text.dataset.full = full;
      const n = Math.round(full.length * typed);
      if (typed >= 1) text.textContent = full;
      else {
        text.textContent = "";
        text.append(full.slice(0, n));
        const rest = document.createElement("span");
        rest.style.color = "transparent";
        rest.textContent = full.slice(n);
        text.append(rest);
      }
    }
    if (card) {
      // Opens from the pin's side: a little smaller, rising, as a popover does in the studio.
      const p = Number(wrap.dataset.open ?? 1);
      card.style.opacity = String(clamp01(p * 1.6));
      card.style.scale = String(0.94 + 0.06 * p);
      card.style.transformOrigin = "0 12px";
      card.style.filter = p < 1 ? `blur(${(1 - p) * 3}px)` : "";
    }
  }
}

/** Inside this far from the frame's edges, and below the wayfinding line. */
const SAFE = 16;
const SAFE_TOP = 16;

/**
 * Thread cards sit beside their pin where they cover least of what the
 * comment is about, and stay whole inside the frame.
 */
function keepCardsInFrame(root: HTMLElement, view: { w: number; h: number }) {
  const frame = root.getBoundingClientRect();
  const k = frame.width / view.w || 1;
  for (const wrap of root.querySelectorAll<HTMLElement>("[data-film-card]")) {
    const card = wrap.firstElementChild as HTMLElement | null;
    if (!card) continue;
    card.style.translate = "";
    const r = card.getBoundingClientRect();
    const w = r.width / k;
    const h = r.height / k;
    // The pin, in frame px (the wrap sits at it).
    const pr = wrap.parentElement!.getBoundingClientRect();
    const px = (pr.left - frame.left) / k;
    const py = (pr.top - frame.top) / k;
    const subj = wrap.dataset.subject
      ? (JSON.parse(wrap.dataset.subject) as { x: number; y: number; w: number; h: number })
      : null;
    // Where the card's top-left may go: beside the pin, and beside what the comment is about
    // (above, below, left or right of it), so it reads next to its subject without covering it.
    const options = [
      { x: px + 20, y: py - 12 },
      { x: px - 20 - w, y: py - 12 },
      { x: px - w / 2, y: py + 20 },
      { x: px - w / 2, y: py - 20 - h },
      { x: px + 20, y: py + 20 },
      { x: px - 20 - w, y: py - 20 - h },
      ...(subj
        ? [
            { x: subj.x + subj.w + 14, y: subj.y + subj.h / 2 - h / 2 },
            { x: subj.x - 14 - w, y: subj.y + subj.h / 2 - h / 2 },
            { x: subj.x + subj.w / 2 - w / 2, y: subj.y + subj.h + 14 },
            { x: subj.x + subj.w / 2 - w / 2, y: subj.y - 14 - h },
            { x: px - w / 2, y: subj.y + subj.h + 14 },
            { x: px - w / 2, y: subj.y - 14 - h },
            { x: subj.x + subj.w + 14, y: py - h / 2 },
            { x: subj.x - 14 - w, y: py - h / 2 },
          ]
        : []),
    ];
    const clampX = (x: number) => Math.min(view.w - SAFE - w, Math.max(SAFE, x));
    const clampY = (y: number) => Math.min(view.h - SAFE - h, Math.max(SAFE_TOP, y));
    // The corner lines (wayfinding, top left; the agent's badge, top right) are off limits.
    const blocked = [...root.querySelectorAll<HTMLElement>(".pz-film-way, .pz-film-badge")].map(
      (b) => {
        const r = b.getBoundingClientRect();
        return {
          x: (r.left - frame.left) / k - 12,
          y: (r.top - frame.top) / k - 12,
          w: r.width / k + 24,
          h: r.height / k + 24,
        };
      },
    );
    // The boards in view: a card over empty canvas hides nothing, over a board it hides design.
    const boards = [...root.querySelectorAll<HTMLElement>(".pz-film-board")]
      .filter((b) => b.style.display !== "none")
      .map((b) => {
        const r = b.getBoundingClientRect();
        return {
          x: (r.left - frame.left) / k,
          y: (r.top - frame.top) / k,
          w: r.width / k,
          h: r.height / k,
        };
      });
    const overBoards = (x: number, y: number) =>
      boards.reduce(
        (a, b) =>
          a +
          Math.max(0, Math.min(x + w, b.x + b.w) - Math.max(x, b.x)) *
            Math.max(0, Math.min(y + h, b.y + b.h) - Math.max(y, b.y)),
        0,
      ) /
      (w * h);
    const cost = (o: { x: number; y: number }) => {
      const x = clampX(o.x);
      const y = clampY(o.y);
      const onCorner = blocked.some(
        (b) => x < b.x + b.w && x + w > b.x && y < b.y + b.h && y + h > b.y,
      );
      const moved = Math.hypot(x - o.x, y - o.y);
      let cover = 0;
      if (subj) {
        const ix = Math.max(0, Math.min(x + w, subj.x + subj.w) - Math.max(x, subj.x));
        const iy = Math.max(0, Math.min(y + h, subj.y + subj.h) - Math.max(y, subj.y));
        cover = (ix * iy) / Math.max(1, Math.min(w * h, subj.w * subj.h));
      }
      // Covering the pin is worst; then covering what it's about; then far from the pin.
      const pinHit = px > x - 8 && px < x + w + 8 && py > y - 8 && py < y + h + 8 ? 1 : 0;
      const far = Math.hypot(x + w / 2 - px, y + h / 2 - py) / Math.max(view.w, view.h);
      // A tall frame reads top to bottom: a card above or below its subject, not beside it.
      const beside = view.h > view.w && (x + w <= px - 8 || x >= px + 8) ? 0.8 : 0;
      return (
        pinHit * 10 +
        (onCorner ? 6 : 0) +
        cover * 14 +
        beside +
        Math.min(1, overBoards(x, y)) * 2.5 +
        moved / 120 +
        far * 1.5
      );
    };
    const best = options.reduce((a, o) => (cost(o) < cost(a) ? o : a));
    const tx = clampX(best.x);
    const ty = clampY(best.y);
    // The card's own position now (it's laid out at right-of-pin by its class).
    const cx = (r.left - frame.left) / k;
    const cy = (r.top - frame.top) / k;
    // Translate is in the card's own px, which its wrap's zoom scales: undo that.
    const local = r.width / k / (card.offsetWidth || w);
    card.style.translate = `${(tx - cx) / local}px ${(ty - cy) / local}px`;
  }
}

/* ------------------------------------------------------------------ */
/* Wayfinding and the end card                                         */
/* ------------------------------------------------------------------ */

/** The one overlay: the slice / file / page, in the corner. */
export function Wayfinding({ model, doc, pageId }: { model: FilmLook; doc: Doc; pageId: string }) {
  const page = doc.pages.find((p) => p.id === pageId);
  const k = model.view.w < model.view.h ? 1.08 : 1;
  return (
    <div
      className="pz-film-way pz:absolute pz:flex pz:items-center pz:rounded-xl pz:bg-bar pz:text-foreground pz:shadow-bar pz:backdrop-blur-[18px] pz:backdrop-saturate-[1.6]"
      style={{
        left: 14,
        top: 14,
        gap: 7 * k,
        padding: `${6 * k}px ${10 * k}px`,
        fontSize: 12.5 * k,
        lineHeight: 1,
      }}
    >
      <Slice size={14 * k} dark={model.theme === "dark"} />
      <span className="pz:text-faint">/</span>
      <span className="pz:inline-flex pz:items-center pz:gap-1.5 pz:font-medium">
        <Icon name="blank" size={13 * k} />
        {model.name}
      </span>
      {page && (
        <>
          <span className="pz:text-faint">/</span>
          <span className="pz:inline-flex pz:items-center pz:gap-1.5 pz:text-muted-foreground">
            <Icon name={page.icon ?? "board"} size={13 * k} />
            {page.name}
          </span>
        </>
      )}
    </div>
  );
}

function Slice({ size, dark, style }: { size: number; dark: boolean; style?: CSSProperties }) {
  const fill = dark ? "#f4f3ef" : "#111110";
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" style={style} aria-hidden>
      <g fill={fill} stroke={fill} strokeWidth={SLICE_STROKE} strokeLinejoin="round">
        {SLICE.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
    </svg>
  );
}

/**
 * The film's opening line: what the person asked for, as a message to the agent, typed into a
 * composer at the bottom of an empty frame and sent. Ponzu's own surfaces, not an agent's app:
 * the bar the canvas uses, the agent's mark, the person's words.
 */
export function Prompt({
  model,
  state,
}: {
  model: FilmLook;
  state: { typed: number; sent: number; out: number };
}) {
  const { view } = model;
  const text = model.prompt!.text;
  const tall = view.h > view.w;
  // Read on a phone: the frame shows at about 390px wide, so the words are set large.
  const k = tall ? 1.55 : 2.25;
  const n = Math.round(text.length * state.typed);
  const w = Math.min(view.w - 40, tall ? view.w - 36 : 860);
  const sentAt = state.sent;
  // Sent: the message lifts into place above the composer, and the agent starts.
  const lift = ease.out(sentAt);
  return (
    <div
      className="pz:pointer-events-none pz:absolute pz:inset-0 pz:z-[6] pz:flex pz:flex-col pz:items-center pz:justify-end"
      style={{
        paddingBottom: tall ? 120 : 56,
        opacity: 1 - state.out,
        filter: state.out > 0 ? `blur(${state.out * 4}px)` : undefined,
        translate: `0 ${-state.out * 14}px`,
      }}
    >
      <div
        className="pz:flex pz:flex-col pz:gap-3"
        style={{ width: w, fontSize: 15 * k, lineHeight: 1.45 }}
      >
        {/* The message, once sent. */}
        <div
          className="pz:self-end pz:rounded-2xl pz:bg-card pz:px-4 pz:py-2.5 pz:text-foreground pz:shadow-popover"
          style={{
            maxWidth: w * 0.86,
            opacity: lift,
            translate: `0 ${(1 - lift) * 18}px`,
            scale: String(0.97 + 0.03 * lift),
            transformOrigin: "100% 100%",
          }}
        >
          {text}
        </div>
        {/* The agent, on it. */}
        <div
          className="pz:flex pz:items-center pz:gap-2 pz:text-muted-foreground"
          style={{
            opacity: progress(sentAt, 0.4, 1, ease.out),
            fontSize: 13 * k,
          }}
        >
          <AgentMark client={model.prompt!.who.client} size={16 * k} />
          <span className="pz-shimmer">{model.prompt!.who.name} is designing</span>
        </div>
        {/* The composer, where it's typed. */}
        <div
          className="pz:flex pz:items-end pz:gap-3 pz:rounded-2xl pz:bg-card pz:px-4 pz:py-3 pz:shadow-popover"
          style={{ opacity: 1 - lift * 0.55 }}
        >
          <span className="pz:min-w-0 pz:flex-1 pz:text-foreground">
            {sentAt > 0 ? (
              <span className="pz:text-faint">Reply…</span>
            ) : (
              <>
                {text.slice(0, n)}
                <span
                  className="pz:inline-block pz:align-[-0.15em] pz:bg-foreground"
                  style={{ width: 1.6, height: "1.05em", marginLeft: 1 }}
                />
                <span style={{ color: "transparent" }}>{text.slice(n)}</span>
              </>
            )}
          </span>
          <span
            className="pz:grid pz:shrink-0 pz:place-items-center pz:rounded-full"
            style={{
              width: 28 * k,
              height: 28 * k,
              background: n > 0 && sentAt === 0 ? "var(--pz-ink)" : "var(--pz-rule)",
              color: n > 0 && sentAt === 0 ? "var(--pz-surface)" : "var(--pz-muted)",
              scale: String(1 - 0.12 * Math.sin(Math.PI * clamp01(sentAt * 1.8))),
            }}
          >
            <Icon name="send" size={14 * k} strokeWidth={2} />
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * The brand's bloom on the canvas colour: the six segments bloom in, "ponzu"
 * wipes on, the slice turns one segment, then ponzu.design fades in.
 */
export function EndCard({ model, t, opacity }: { model: FilmLook; t: number; opacity: number }) {
  const ink = model.theme === "dark" ? "#f4f3ef" : "#111110";
  const short = Math.min(model.view.w, model.view.h);
  const mark = Math.round(short * 0.13);
  const word = Math.round(mark * 0.62);
  const turn = 60 * progress(t, 0.7, 1.0, ease.out);
  const wipe = progress(t, 0.26, 0.66, ease.out);
  const url = progress(t, 0.62, 0.9, ease.out);
  return (
    <div
      className="pz:absolute pz:inset-0 pz:z-[10] pz:flex pz:flex-col pz:items-center pz:justify-center pz:bg-background"
      style={{ opacity }}
    >
      <div className="pz:flex pz:items-center" style={{ gap: mark * 0.3 }}>
        <svg
          width={mark}
          height={mark}
          viewBox="0 0 64 64"
          style={{ overflow: "visible" }}
          aria-hidden
        >
          <g
            fill={ink}
            stroke={ink}
            strokeWidth={SLICE_STROKE}
            strokeLinejoin="round"
            style={{
              transformBox: "view-box",
              transformOrigin: "32px 32px",
              transform: `rotate(${turn}deg)`,
            }}
          >
            {SLICE.map((d, i) => {
              // The segments bloom close together, from a moment after the canvas has gone.
              // All six from the same frame, from the centre: never a lone wedge.
              void i;
              const p = progress(t, 0.04, 0.5, ease.out);
              return (
                <path
                  key={d}
                  d={d}
                  style={{
                    transformBox: "view-box",
                    transformOrigin: "32px 32px",
                    transform: `scale(${0.35 + 0.65 * p})`,
                    opacity: clamp01(p * 2.5),
                  }}
                />
              );
            })}
          </g>
        </svg>
        <span
          style={{
            font: `700 ${word}px/1 "Funnel Display", Inter, sans-serif`,
            letterSpacing: "-0.05em",
            color: ink,
            opacity: clamp01(wipe * 2),
            transform: `translateX(${-14 * (1 - wipe)}px)`,
            clipPath: `inset(-10% ${100 - wipe * 100}% -10% 0)`,
            paddingRight: 2,
          }}
        >
          ponzu
        </span>
      </div>
      <div
        style={{
          marginTop: mark * 0.42,
          font: `500 ${Math.round(short * 0.042)}px/1 "IBM Plex Mono", ui-monospace, monospace`,
          letterSpacing: "0.01em",
          color: model.theme === "dark" ? "#c9c5bc" : "#4a4741",
          opacity: url,
          transform: `translateY(${4 * (1 - url)}px)`,
        }}
      >
        ponzu.design
      </div>
    </div>
  );
}
