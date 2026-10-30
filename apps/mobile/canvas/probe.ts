/*
 * The canvas measuring itself on the phone: for the share of gestures the app asks for (`probe`),
 * the frames from the first touch until the camera comes to rest, counted as the harness counts
 * them (apps/mobile/perf: `frames.ts`, `metrics.ts`), and one `perf` message to the app when it's
 * over. Nothing runs while nobody touches the canvas, and nothing at all at a rate of 0.
 */
import { watchFrames } from "../perf/frames.ts";
import { gesture } from "../perf/metrics.ts";
import { SLOP } from "./gestures.ts";
import type { GesturePerf } from "./protocol.ts";
import { probeRate, send } from "./store.ts";

/** Frames in a row without a move, every finger up: the camera is at rest. Half a second. */
const REST_FRAMES = 30;
/** A gesture still going after this long (a finger left resting on the glass) isn't measured. */
const LONGEST_MS = 20_000;

interface Measuring {
  start: number;
  watch: ReturnType<typeof watchFrames>;
  /** Where each finger landed; the most down at once; whether one dragged. */
  from: Map<number, { x: number; y: number }>;
  fingers: number;
  dragged: boolean;
  down: number;
  still: number;
  long: { count: number; max: number } | null;
  observer: PerformanceObserver | null;
}

let now: Measuring | null = null;
/** Fingers down on a gesture the sample left out. */
let skipping = false;

const longTasks = () =>
  typeof PerformanceObserver !== "undefined" &&
  (PerformanceObserver.supportedEntryTypes ?? []).includes("longtask");

function begin() {
  const m: Measuring = {
    start: performance.now(),
    watch: watchFrames((t, moved) => {
      if (moved) m.still = 0;
      else if (!m.down) m.still++;
      if (m.still >= REST_FRAMES) finish();
      else if (t - m.start > LONGEST_MS) drop();
    }),
    from: new Map(),
    fingers: 0,
    dragged: false,
    down: 0,
    still: 0,
    long: null,
    observer: null,
  };
  if (longTasks()) {
    const long = { count: 0, max: 0 };
    m.long = long;
    m.observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        long.count++;
        long.max = Math.max(long.max, e.duration);
      }
    });
    m.observer.observe({ type: "longtask" });
  }
  now = m;
}

function drop() {
  now?.watch.stop();
  now?.observer?.disconnect();
  now = null;
}

function finish() {
  const m = now;
  drop();
  if (!m || m.watch.moves.length < 2) return;
  const g: GesturePerf = {
    kind: m.fingers > 1 ? "pinch" : m.dragged ? "pan" : "focus",
    ...gesture(m.watch.t, m.watch.moves, m.start),
    boards: document.querySelectorAll("[data-artboard-host]").length,
    ...(m.long ? { longTasks: m.long.count, longestTaskMs: Math.round(m.long.max) } : {}),
  };
  send({ t: "perf", gesture: g });
}

/** Listens for touches on the canvas; measures nothing until the app sets a rate. */
export function probe() {
  const opts = { capture: true, passive: true };
  window.addEventListener(
    "touchstart",
    (e) => {
      // A touch while the last gesture's glide plays out ends it, and starts the next.
      if (now && !now.down) finish();
      if (!now && !skipping) {
        if (Math.random() >= probeRate()) {
          skipping = true;
          return;
        }
        begin();
      }
      if (!now) return;
      for (const t of Array.from(e.changedTouches))
        now.from.set(t.identifier, { x: t.clientX, y: t.clientY });
      now.down = e.touches.length;
      now.fingers = Math.max(now.fingers, e.touches.length);
      now.still = 0;
    },
    opts,
  );
  const up = (e: TouchEvent) => {
    if (!now) {
      if (!e.touches.length) skipping = false;
      return;
    }
    for (const t of Array.from(e.changedTouches)) {
      const p = now.from.get(t.identifier);
      if (p && Math.hypot(t.clientX - p.x, t.clientY - p.y) > SLOP) now.dragged = true;
    }
    now.down = e.touches.length;
  };
  window.addEventListener("touchend", up, opts);
  window.addEventListener("touchcancel", up, opts);
}
