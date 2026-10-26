/*
 * The numbers a run reports, from what the probe recorded. Plain functions, so they're tested
 * without a browser.
 */

/** rAF frames over a window: how many a second, and the longest gap between two. */
export function frames(t: number[], wallMs?: number) {
  const dt = t.slice(1).map((v, i) => v - t[i]!);
  const total = wallMs ?? (t.length > 1 ? t.at(-1)! - t[0]! : 0);
  return {
    fps: total > 0 ? round((dt.length / total) * 1000) : 0,
    p95: round(quantile(dt, 0.95)),
    max: round(Math.max(0, ...dt)),
    jank: dt.filter((d) => d > 33.4).length,
  };
}

/**
 * What the person sees while the camera moves: frames in which it actually moved, per second of
 * moving, and the longest wait between two of them. `spans` are the gestures, each from its first
 * touch until the camera came to rest; only moves inside one count, and a span's clock runs from
 * its first move to its last, so the pause between gestures isn't counted as a gap.
 */
export function cameraMoves(moves: number[], spans: [number, number][]) {
  let count = 0;
  let time = 0;
  let maxGap = 0;
  for (const [a, b] of spans) {
    const m = moves.filter((t) => t >= a && t <= b);
    if (m.length < 2) continue;
    count += m.length - 1;
    time += m.at(-1)! - m[0]!;
    for (let i = 1; i < m.length; i++) maxGap = Math.max(maxGap, m[i]! - m[i - 1]!);
  }
  return { movesPerS: time > 0 ? round((count / time) * 1000) : 0, maxGapMs: round(maxGap) };
}

/**
 * The frames after fingers lift from a pinch: when the first one came, and the longest one in
 * the following second (the canvas drops `will-change` 150 ms after the camera stops, and the
 * boards redraw sharp at the new zoom). The first frame past the second counts too: a stall that
 * runs over its end is still a stall.
 */
export function settle(t: number[], lift: number, windowMs = 1000) {
  const later = t.filter((v) => v >= lift);
  const inside = later.filter((v) => v <= lift + windowMs).length;
  const after = later.slice(0, inside + 1);
  if (!after.length) return { firstMs: null, maxMs: null };
  const all = [lift, ...after];
  let max = 0;
  for (let i = 1; i < all.length; i++) max = Math.max(max, all[i]! - all[i - 1]!);
  return { firstMs: round(after[0]! - lift), maxMs: round(max) };
}

export interface TimelineRecord {
  type: string;
  startTime: number;
  endTime?: number;
  children?: TimelineRecord[];
}

const STAGE: Record<string, string> = {
  FunctionCall: "script",
  EvaluateScript: "script",
  TimerFire: "script",
  EventDispatch: "script",
  FireAnimationFrame: "script",
  ObserverCallback: "script",
  RecalculateStyles: "style",
  Layout: "layout",
  Paint: "paint",
};

/**
 * Main-thread time by stage over a Web Inspector timeline: each record's own time, less its
 * children's, so nested script isn't counted twice. Seconds in, ms out. Composite records
 * overlap one another, so they aren't summed.
 */
export function stages(records: TimelineRecord[]) {
  const out: Record<string, number> = {};
  const walk = (r: TimelineRecord) => {
    const kids = r.children ?? [];
    const span = r.endTime !== undefined ? r.endTime - r.startTime : 0;
    const inner = kids.reduce(
      (s, c) => s + (c.endTime !== undefined ? c.endTime - c.startTime : 0),
      0,
    );
    const stage = STAGE[r.type];
    if (stage && span > 0) out[stage] = (out[stage] ?? 0) + Math.max(0, span - inner) * 1000;
    for (const c of kids) walk(c);
  };
  for (const r of records) walk(r);
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, round(v)]));
}

/** CPU time `ps` reports (`[[dd-]hh:]mm:ss.cc`), in ms. */
export function cpuTime(text: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text.trim());
  if (!m) return Number.NaN;
  const [, d = "0", h = "0", min = "0", s = "0"] = m;
  return (((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(s)) * 1000;
}

function quantile(v: number[], q: number) {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]!;
}

export function round(n: number, digits = 1) {
  const k = 10 ** digits;
  return Math.round(n * k) / k;
}
