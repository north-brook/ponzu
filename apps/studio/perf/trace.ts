/*
 * Chrome's own account of where the time went: a trace of the page while a scenario runs, read
 * into totals by phase. The counts here (elements restyled, layout objects, paints) are what
 * Chrome did, not how long it took, so they hold from one machine to the next and are what a
 * pull request's comment can compare without noise. The times are this machine's.
 */
import type { Page } from "@ponzu/render/testing";

/** Playwright's CDP session, named through @ponzu/render, which is what depends on Playwright. */
export type CDPSession = Awaited<ReturnType<ReturnType<Page["context"]>["newCDPSession"]>>;

const CATEGORIES = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "blink",
  "cc",
  "gpu",
  "toplevel",
  "v8",
].join(",");

/**
 * Profiling (`run.ts --profile`): every trace also records why style and layout were
 * invalidated, which costs time of its own, and is handed to `sink` once it is complete.
 */
export const profiling: { on: boolean; sink: ((events: TraceEvent[]) => void) | null } = {
  on: false,
  sink: null,
};

export interface TraceEvent {
  name: string;
  ph: string;
  pid: number;
  tid: number;
  ts: number;
  dur?: number;
  args?: Record<string, any>;
}

/** Traces whatever `run` does, and returns its result with the trace's events. */
export async function traced<T>(
  cdp: CDPSession,
  run: () => Promise<T>,
): Promise<{ value: T; events: TraceEvent[] }> {
  const events: TraceEvent[] = [];
  const collect = (e: { value: object[] }) => {
    for (const v of e.value) events.push(v as TraceEvent);
  };
  cdp.on("Tracing.dataCollected", collect);
  const categories = profiling.on
    ? `${CATEGORIES},disabled-by-default-devtools.timeline.invalidationTracking,disabled-by-default-v8.cpu_profiler`
    : CATEGORIES;
  await cdp.send("Tracing.start", { categories, transferMode: "ReportEvents" });
  let value: T;
  try {
    value = await run();
  } finally {
    const complete = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve));
    await cdp.send("Tracing.end");
    await complete;
    cdp.off("Tracing.dataCollected", collect);
  }
  profiling.sink?.(events);
  return { value, events };
}

/** What a trace says the page did. Times in ms; the rest are counts. */
export interface TraceSummary {
  /** The renderer's main thread busy, in tasks. */
  mainMs: number;
  scriptMs: number;
  styleMs: number;
  layoutMs: number;
  /** Pre-paint, paint and layerizing: what the main thread does to hand a frame over. */
  paintMs: number;
  gcMs: number;
  /** Raster on the renderer's workers. */
  rasterMs: number;
  /** The GPU process's main thread. */
  gpuMs: number;
  /** Tiles rastered (out of process, on the GPU's main thread): what a redraw cost, as a count. */
  tiles: number;
  /** When the last tile was rastered, in the trace's µs (0 for none). */
  lastTileTs: number;
  /** Style recalculations, and how many elements they restyled in all. */
  recalcs: number;
  restyled: number;
  /** Layouts, and how many layout objects were dirty across them. */
  layouts: number;
  laidOut: number;
  paints: number;
  /** The longest single task on the main thread. */
  longestTaskMs: number;
}

/**
 * The trace's time of the first `console.timeStamp(label)` the page made, in µs; NaN if none.
 * The gestures mark where they end, so the rest after can be told from the gesture.
 */
export function stamp(events: TraceEvent[], label: string): number {
  const e = events.find((e) => e.name === "TimeStamp" && e.args?.data?.message === label);
  return e ? e.ts : Number.NaN;
}

/** `summarize` over what started at or after `ts` (µs) only. */
export function summarizeAfter(events: TraceEvent[], ts: number): TraceSummary {
  return summarize(events.filter((e) => e.ph === "M" || e.ts >= ts));
}

export function summarize(events: TraceEvent[]): TraceSummary {
  const threads = new Map<string, string>();
  const processes = new Map<number, string>();
  for (const e of events) {
    if (e.ph !== "M") continue;
    if (e.name === "thread_name") threads.set(`${e.pid}:${e.tid}`, e.args?.name);
    if (e.name === "process_name") processes.set(e.pid, e.args?.name);
  }
  const s: TraceSummary = {
    mainMs: 0,
    scriptMs: 0,
    styleMs: 0,
    layoutMs: 0,
    paintMs: 0,
    gcMs: 0,
    rasterMs: 0,
    gpuMs: 0,
    tiles: 0,
    lastTileTs: 0,
    recalcs: 0,
    restyled: 0,
    layouts: 0,
    laidOut: 0,
    paints: 0,
    longestTaskMs: 0,
  };
  for (const e of events) {
    if (e.ph !== "X" || !e.dur) continue;
    const ms = e.dur / 1000;
    const thread = threads.get(`${e.pid}:${e.tid}`);
    if (thread === "CrRendererMain") {
      switch (e.name) {
        case "ThreadControllerImpl::RunTask":
          s.mainMs += ms;
          s.longestTaskMs = Math.max(s.longestTaskMs, ms);
          break;
        case "FunctionCall":
        case "EvaluateScript":
        case "v8.compile":
          s.scriptMs += ms;
          break;
        case "UpdateLayoutTree":
          s.styleMs += ms;
          s.recalcs++;
          s.restyled += Number(e.args?.elementCount ?? 0);
          break;
        case "Layout":
          s.layoutMs += ms;
          s.layouts++;
          s.laidOut += Number(e.args?.beginData?.dirtyObjects ?? 0);
          break;
        case "PrePaint":
        case "Layerize":
          s.paintMs += ms;
          break;
        case "Paint":
          s.paintMs += ms;
          s.paints++;
          break;
        case "MajorGC":
        case "MinorGC":
          s.gcMs += ms;
          break;
      }
    } else if (e.name === "RasterTask") {
      s.rasterMs += ms;
    } else if (e.name === "RasterDecoderImpl::DoRasterCHROMIUM") {
      s.tiles++;
      s.lastTileTs = Math.max(s.lastTileTs, e.ts + e.dur);
    } else if (
      thread === "CrGpuMain" &&
      e.name === "ThreadControllerImpl::RunTask" &&
      processes.get(e.pid) !== "Browser"
    ) {
      s.gpuMs += ms;
    }
  }
  return s;
}

/**
 * Why a trace's frames cost what they did, in words: the longest tasks, the script that ran
 * most, and what invalidated style and layout (with `profiling.on`), most frequent first. The
 * first thing to read when a number in the comment moves.
 */
export function explain(events: TraceEvent[], top = 8): string {
  const threads = new Map<string, string>();
  for (const e of events)
    if (e.ph === "M" && e.name === "thread_name") threads.set(`${e.pid}:${e.tid}`, e.args?.name);
  const main = (e: TraceEvent) => threads.get(`${e.pid}:${e.tid}`) === "CrRendererMain";
  const tally = new Map<string, { n: number; ms: number }>();
  const add = (k: string, ms: number) => {
    const t = tally.get(k) ?? { n: 0, ms: 0 };
    t.n++;
    t.ms += ms;
    tally.set(k, t);
  };
  const where = (f?: {
    functionName?: string;
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
  }) =>
    f
      ? `${f.functionName || "(anonymous)"} ${String(f.url ?? "")
          .split("/")
          .pop()}:${f.lineNumber}:${f.columnNumber}`
      : "";
  for (const e of events) {
    if (!main(e)) continue;
    if (e.ph === "X" && e.name === "FunctionCall")
      add(`script  ${where(e.args?.data)}`, (e.dur ?? 0) / 1000);
    if (e.name.endsWith("InvalidationTracking")) {
      const d = e.args?.data ?? {};
      const what = d.changedAttribute ?? d.changedClass ?? d.changedId ?? d.changedPseudo ?? "";
      const node = String(d.nodeName ?? "").slice(0, 70);
      add(
        `${e.name.replace("InvalidationTracking", "")}  ${d.reason ?? ""} ${what} on ${node} ${where(d.stackTrace?.[0])}`,
        0,
      );
    }
  }
  const tasks = events
    .filter((e) => main(e) && e.ph === "X" && e.name === "ThreadControllerImpl::RunTask")
    .map((e) => (e.dur ?? 0) / 1000)
    .sort((a, b) => b - a)
    .slice(0, 5)
    .map((ms) => ms.toFixed(1));
  const lines = [`  longest tasks: ${tasks.join(", ")} ms`];
  const scripts = [...tally]
    .filter(([k]) => k.startsWith("script"))
    .sort((a, b) => b[1].ms - a[1].ms);
  for (const [k, t] of scripts.slice(0, top))
    lines.push(`  ${t.ms.toFixed(0).padStart(5)} ms ${String(t.n).padStart(5)}×  ${k}`);
  const why = [...tally].filter(([k]) => !k.startsWith("script")).sort((a, b) => b[1].n - a[1].n);
  for (const [k, t] of why.slice(0, top)) lines.push(`  ${String(t.n).padStart(14)}×  ${k}`);
  return lines.join("\n");
}
