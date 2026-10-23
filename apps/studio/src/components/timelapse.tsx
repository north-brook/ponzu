import { type FilmShape, lastSession, parseJournal, type Range } from "@ponzu/core";
import { Icon, type SocketSource, Tip, useSource } from "@ponzu/react";
import { Dialog as DialogPrimitive } from "radix-ui";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { journalText } from "@/film/page";
import { ReelFilm } from "@/film/ReelFilm";
import { buildReel, type Reel } from "@/film/reel";
import { cn } from "@/lib/utils";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./ui/hover-card";

/*
 * Timelapse in the studio: one clock button at the start of the canvas's
 * Controls bar. It opens the composer; while a film renders it shows a ring
 * and a percentage, and hovering it shows the poster filling in; once done
 * it shows a check and opens the film. The film itself is made by the
 * server (packages/server/src/timelapse.ts), so it carries on with the sheet closed.
 */

type JobState =
  | { status: "rendering"; done: number; started: number; left?: number }
  | { status: "done"; path: string; mime: string; codec: string; bytes: number; duration: number }
  | { status: "failed"; error: string }
  | { status: "cancelled" };

export interface TimelapseJob {
  id: string;
  file: string;
  request: { shape: FilmShape; length?: number; range?: Range; theme: "light" | "dark" };
  state: JobState;
  poster: boolean;
}

const NUDGE_MS = 4000;

/** A finished film to watch: just made, or one of the past ones in exports/. */
interface FilmView {
  name: string;
  path: string;
  src: string;
  duration?: number;
  /** What it covered, when it was just made here (for its comment ticks). */
  range?: Range;
  theme?: "light" | "dark";
}

/** A film in the design's exports/ folder. */
interface PastFilm {
  name: string;
  path: string;
  bytes: number;
  at: number;
  /** The stretch of history it covered, when kept beside it. */
  range?: Range;
  duration?: number;
}

/** The latest film for a file, polled while one renders. */
function useJob(origin: string, file: string) {
  const [job, setJob] = useState<TimelapseJob | null>(null);
  const refresh = useCallback(async () => {
    const res = await fetch(`${origin}/api/timelapse/status?file=${encodeURIComponent(file)}`);
    if (res.ok) setJob((await res.json()) as TimelapseJob | null);
  }, [origin, file]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const rendering = job?.state.status === "rendering";
  useEffect(() => {
    if (!rendering) return;
    const t = setInterval(() => void refresh(), 400);
    return () => clearInterval(t);
  }, [rendering, refresh]);
  return { job, setJob, refresh };
}

/**
 * The nudge: when an agent resolves the last open comment a person left, once
 * per session per file, the clock glows yuzu and says what it's for.
 */
function useNudge(source: SocketSource, file: string): boolean {
  const state = useSource(source);
  const [on, setOn] = useState(false);
  const open = useRef<number | null>(null);
  useEffect(() => {
    const doc = state.doc;
    if (!doc) return;
    const count = doc.threads.filter(
      (t) => t.status === "open" && t.messages[0]?.author.kind === "user",
    ).length;
    const before = open.current;
    open.current = count;
    if (before === null || before === 0 || count !== 0) return;
    if (state.lastOrigin?.kind !== "agent") return;
    const key = `ponzu.timelapse.nudged:${file}`;
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, "1");
    setOn(true);
  }, [state.doc, state.lastOrigin, file]);
  useEffect(() => {
    if (!on) return;
    const t = setTimeout(() => setOn(false), NUDGE_MS);
    return () => clearTimeout(t);
  }, [on]);
  return on;
}

/** The Controls bar's clock: composer, progress, and the finished film. */
export function TimelapseButton({
  origin,
  file,
  name,
  source,
  theme,
}: {
  origin: string;
  file: string;
  name: string;
  source: SocketSource;
  theme: "light" | "dark";
}) {
  const { job, setJob, refresh } = useJob(origin, file);
  const [composing, setComposing] = useState(false);
  /** The film the done dialog is showing: one just made, or one picked from the past ones. */
  const [viewing, setViewing] = useState<FilmView | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const nudge = useNudge(source, file);
  const state = job?.state;
  const rendering = state?.status === "rendering";

  // A film that finishes while you're here opens on its own: no badge to notice and click.
  const watched = useRef<string | null>(null);
  useEffect(() => {
    if (!job) return;
    if (job.state.status === "rendering") watched.current = job.id;
    else if (job.state.status === "done" && watched.current === job.id) {
      watched.current = null;
      const done = job.state;
      setViewing({
        name: done.path.split("/").pop() ?? "timelapse.mp4",
        path: done.path,
        src: `${origin}/api/timelapse/video?id=${job.id}`,
        duration: done.duration,
        range: job.request.range,
        theme: job.request.theme,
      });
    }
  }, [job, origin]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.code !== "KeyT") return;
      e.preventDefault();
      if (!rendering) setComposing(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rendering]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const start = async (req: TimelapseJob["request"]) => {
    const res = await fetch(`${origin}/api/timelapse?file=${encodeURIComponent(file)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });
    const body = await res.json();
    if (!res.ok) {
      setToast((body as { error: string }).error);
      return;
    }
    setJob(body as TimelapseJob);
    setComposing(false);
  };
  const cancel = async () => {
    if (!job) return;
    await fetch(`${origin}/api/timelapse/cancel?id=${job.id}`, { method: "POST" });
    await refresh();
  };

  const onClick = () => {
    if (!rendering) setComposing(true);
  };

  const button = (
    <button
      type="button"
      aria-label="Timelapse"
      data-timelapse-button
      data-state-kind={rendering ? "rendering" : nudge ? "nudge" : "rest"}
      onClick={onClick}
      className={cn(
        "pz:relative pz:flex pz:h-7 pz:items-center pz:gap-1.5 pz:rounded-lg pz:text-muted-foreground pz:outline-none pz:hover:bg-accent pz:hover:text-foreground",
        rendering ? "pz:pr-2 pz:pl-1" : "pz:w-7 pz:justify-center",
        nudge && "tl-nudge pz:text-foreground",
      )}
    >
      {rendering ? (
        <>
          <Ring done={state.done} />
          <span className="pz:text-[12px] pz:text-foreground pz:tabular-nums">
            {Math.floor(state.done * 100)}%
          </span>
        </>
      ) : (
        <Icon name="clock" size={16} />
      )}
    </button>
  );

  return (
    <>
      {rendering && job ? (
        <HoverCard openDelay={120} closeDelay={160}>
          <HoverCardTrigger asChild>{button}</HoverCardTrigger>
          <HoverCardContent side="top" align="start" sideOffset={10} className="w-[264px] p-2.5">
            <RenderingCard origin={origin} job={job} onCancel={cancel} />
          </HoverCardContent>
        </HoverCard>
      ) : nudge ? (
        <NudgeTip>{button}</NudgeTip>
      ) : (
        <Tip label="Timelapse" keys={["⇧", "⌘", "T"]}>
          {button}
        </Tip>
      )}
      <Composer
        open={composing}
        onOpenChange={setComposing}
        origin={origin}
        file={file}
        name={name}
        theme={theme}
        onExport={start}
        onWatch={(film) => {
          setComposing(false);
          setViewing(film);
        }}
      />
      {viewing && (
        <Ready
          open
          onOpenChange={(o) => !o && setViewing(null)}
          file={file}
          film={viewing}
          name={name}
          onToast={setToast}
        />
      )}
      {(toast || state?.status === "failed") && (
        <Toast
          text={toast ?? (state?.status === "failed" ? `Timelapse failed: ${state.error}` : "")}
          onClose={() => {
            setToast(null);
            if (state?.status === "failed") setJob(null);
          }}
        />
      )}
    </>
  );
}

/** The nudge's tip: up on its own for a few seconds, no hover needed. */
function NudgeTip({ children }: { children: ReactNode }) {
  return (
    <span className="pz:relative pz:inline-flex">
      {children}
      <span
        role="status"
        className="pz-tip tl-nudge-tip pz:pointer-events-none pz:absolute pz:bottom-[calc(100%+8px)] pz:left-0 pz:z-50 pz:flex pz:h-[26px] pz:items-center pz:gap-2 pz:whitespace-nowrap pz:rounded-[7px] pz:bg-[#1c1c1b] pz:pr-1.5 pz:pl-[9px] pz:text-[12px] pz:text-white pz:shadow-[0_0_0_0.5px_rgba(255,255,255,0.1),0_4px_14px_rgba(0,0,0,0.18)]"
      >
        Make a timelapse of this session
        <span className="pz:flex pz:gap-0.5">
          {["⇧", "⌘", "T"].map((k) => (
            <kbd
              key={k}
              className="pz:min-w-4 pz:rounded pz:bg-white/15 pz:px-1 pz:text-center pz:text-[11px] pz:text-white/85 pz:leading-4"
            >
              {k}
            </kbd>
          ))}
        </span>
      </span>
    </span>
  );
}

function Ring({ done }: { done: number }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <svg width={18} height={18} viewBox="0 0 18 18" aria-hidden className="pz:-rotate-90">
      <circle
        cx={9}
        cy={9}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.18}
        strokeWidth={2}
      />
      <circle
        cx={9}
        cy={9}
        r={r}
        fill="none"
        stroke="#ffc81e"
        strokeWidth={2}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - done)}
        style={{ transition: "stroke-dashoffset .35s linear" }}
      />
    </svg>
  );
}

function RenderingCard({
  origin,
  job,
  onCancel,
}: {
  origin: string;
  job: TimelapseJob;
  onCancel: () => void;
}) {
  const state = job.state.status === "rendering" ? job.state : null;
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1500);
    return () => clearInterval(t);
  }, []);
  const [w, h] = aspect(job.request.shape);
  const done = state?.done ?? 1;
  return (
    <div className="flex flex-col gap-2.5">
      <div
        className="relative overflow-hidden rounded-lg bg-canvas"
        style={{
          aspectRatio: `${w} / ${h}`,
          maxHeight: 280,
          margin: "0 auto",
          width: w >= h ? "100%" : undefined,
          height: w < h ? 280 : undefined,
        }}
      >
        {job.poster && (
          <img
            alt=""
            src={`${origin}/api/timelapse/poster?id=${job.id}&t=${tick}`}
            className="absolute inset-0 size-full object-cover"
          />
        )}
        {/* The film fills in: what's still to render sits under a veil. */}
        <div
          className="absolute inset-y-0 right-0 bg-canvas/70 backdrop-blur-[2px] transition-[width] duration-300"
          style={{ width: `${(1 - done) * 100}%` }}
        />
      </div>
      <div className="flex items-center gap-2 px-0.5">
        <span className="text-[12.5px] text-muted-foreground tabular-nums">
          Rendering{state?.left ? ` · about ${state.left}s left` : ""}
        </span>
        <button
          type="button"
          onClick={onCancel}
          className="ml-auto h-7 rounded-lg px-2.5 text-[12.5px] font-medium text-foreground hover:bg-accent"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function aspect(shape: FilmShape): [number, number] {
  return shape === "1:1" ? [1, 1] : shape === "9:16" ? [9, 16] : [16, 9];
}

/* ------------------------------------------------------------------ */
/* The sheet                                                           */
/* ------------------------------------------------------------------ */

function Sheet({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100%-48px)] w-[min(992px,calc(100%-48px))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-2xl bg-card p-6 pt-5 text-foreground shadow-[0_1px_2px_rgba(17,17,16,0.08),0_24px_64px_rgba(17,17,16,0.18)] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98]"
        >
          <div className="flex h-7 items-center gap-2">
            <DialogPrimitive.Title className="flex min-w-0 items-baseline gap-2 text-[14px] font-semibold">
              {title}
            </DialogPrimitive.Title>
            <DialogPrimitive.Close className="ml-auto grid size-7 place-items-center rounded-lg text-muted-foreground outline-none hover:bg-accent hover:text-foreground">
              <Icon name="close" size={15} />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          </div>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** Plays a film model in real time, or holds still. */
function usePlayer(duration: number, playing: boolean, loop = true) {
  const [t, setT] = useState(0);
  const at = useRef(0);
  useEffect(() => {
    at.current = t;
  }, [t]);
  useEffect(() => {
    if (!playing || !duration) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      let next = at.current + dt;
      if (next >= duration) next = loop ? 0 : duration;
      at.current = next;
      setT(next);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, duration, loop]);
  return [t, (v: number) => setT(Math.max(0, Math.min(duration, v)))] as const;
}

/** A film model fitted into a box, at its own size scaled down. */
function Stage({ model, t }: { model: Reel; t: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [k, setK] = useState(0.5);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setK(Math.min(el.clientWidth / model.view.w, el.clientHeight / model.view.h));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [model]);
  return (
    <div ref={box} className="relative grid min-h-0 flex-1 place-items-center overflow-hidden">
      <div style={{ width: model.view.w * k, height: model.view.h * k }}>
        <div
          style={{
            width: model.view.w,
            height: model.view.h,
            transform: `scale(${k})`,
            transformOrigin: "0 0",
          }}
        >
          <ReelFilm model={model} f={t} />
        </div>
      </div>
    </div>
  );
}

/**
 * Where a new film starts: the newest stretch of history no film has covered yet (from the end
 * of the latest film's range to now), so the next film picks up where the last left off. With no
 * films, or nothing new since, the last session.
 */
function nextRange(entries: ReturnType<typeof parseJournal>, films: PastFilm[]): Range | null {
  const session = lastSession(entries);
  const ops = entries.filter((e) => e.kind === "op");
  const end = ops.at(-1)?.t;
  const covered = Math.max(0, ...films.map((f) => f.range?.to ?? 0));
  if (!session || end === undefined || !covered || covered >= end) return session;
  const from = ops.find((e) => e.t > covered)?.t;
  return from !== undefined ? { from, to: end } : session;
}

/** When the person left each of their comments (real time). */
function commentTimes(entries: ReturnType<typeof parseJournal>): number[] {
  return entries.flatMap((e) =>
    e.kind === "op" &&
    e.origin.kind === "user" &&
    (e.op.op === "thread.create" ||
      (e.op.op === "batch" && e.op.ops.some((o) => o.op === "thread.create")))
      ? [e.t]
      : [],
  );
}

function fmt(s: number) {
  const v = Math.max(0, Math.round(s));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`;
}

function Composer({
  open,
  onOpenChange,
  origin,
  file,
  name,
  theme,
  onExport,
  onWatch,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  origin: string;
  file: string;
  name: string;
  theme: "light" | "dark";
  onExport: (req: TimelapseJob["request"]) => void;
  onWatch: (film: FilmView) => void;
}) {
  const [journal, setJournal] = useState<string | null>(null);
  const [past, setPast] = useState<PastFilm[]>([]);
  const [range, setRange] = useState<Range | null>(null);
  const [model, setModel] = useState<Reel | null>(null);
  const [playing, setPlaying] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const entries = useMemo(() => (journal ? parseJournal(journal) : []), [journal]);
  const ops = useMemo(() => entries.filter((e) => e.kind === "op").map((e) => e.t), [entries]);
  const comments = useMemo(() => commentTimes(entries), [entries]);
  const bounds = ops.length ? { from: ops[0]!, to: ops[ops.length - 1]! } : null;

  useEffect(() => {
    if (!open) return;
    setError(null);
    void Promise.all([
      journalText(file),
      fetch(`${origin}/api/timelapse/films?file=${encodeURIComponent(file)}`)
        .then((r) => (r.ok ? (r.json() as Promise<PastFilm[]>) : []))
        .catch(() => [] as PastFilm[]),
    ])
      .then(([text, films]) => {
        setJournal(text);
        setPast(films);
        setRange(nextRange(parseJournal(text), films));
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [open, origin, file]);

  useEffect(() => {
    if (!open || !entries.length || !range) return;
    let live = true;
    const t = setTimeout(() => {
      void buildReel({
        name,
        entries,
        shape: "16:9",
        range,
        theme,
        assetBase: `${origin}/files/${encodeURIComponent(file)}`,
      }).then((m) => live && setModel(m));
    }, 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [open, entries, range, theme, origin, file, name]);

  const duration = model?.times.duration ?? 0;
  const [t, seek] = usePlayer(duration, open && playing && Boolean(model));
  const empty = journal !== null && !ops.length;

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={
        <>
          Timelapse<span className="truncate font-normal text-muted-foreground">{name}</span>
        </>
      }
    >
      {/* The film is always 16:9: its box is the film, edge to edge. */}
      <div className="relative mx-auto flex aspect-video max-h-[calc(100vh-300px)] w-full max-w-[calc((100vh-300px)*16/9)] flex-col overflow-hidden rounded-[10px] bg-canvas shadow-[0_0_0_1px_var(--hairline)]">
        {model ? (
          <Stage model={model} t={t} />
        ) : (
          <div className="grid flex-1 place-items-center text-[13px] text-muted-foreground">
            {error ??
              (empty ? "Nothing to film yet: this file has no history." : "Loading the history…")}
          </div>
        )}
      </div>
      {bounds && range && (
        <Track
          bounds={bounds}
          ops={ops}
          ticks={comments}
          range={range}
          onRange={setRange}
          films={past.filter((f) => f.range)}
          onWatch={(f) =>
            onWatch({
              name: f.name,
              path: f.path,
              src: `${origin}/api/timelapse/film?file=${encodeURIComponent(file)}&name=${encodeURIComponent(f.name)}`,
              duration: f.duration,
              range: f.range,
            })
          }
          playhead={null}
          onSeek={() => {}}
        />
      )}
      <div className="flex items-center gap-2">
        <PlayButton playing={playing} onClick={() => setPlaying((p) => !p)} />
        <button
          type="button"
          aria-label="From the start"
          onClick={() => seek(0)}
          className="font-mono text-[12px] tabular-nums"
        >
          {fmt(t)} <span className="text-faint">/ {fmt(duration)}</span>
        </button>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            disabled={!model || !range}
            onClick={() => range && onExport({ shape: "16:9", range, theme })}
            className="flex h-8 items-center gap-1.5 rounded-[9px] bg-foreground px-3 text-[13px] font-medium text-background hover:bg-foreground/90 disabled:opacity-40"
          >
            <Icon name="download" size={15} />
            Export
          </button>
        </div>
      </div>
    </Sheet>
  );
}

function PlayButton({ playing, onClick }: { playing: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={playing ? "Pause" : "Play"}
      onClick={onClick}
      className="grid size-8 place-items-center rounded-lg text-foreground hover:bg-accent"
    >
      <Icon name={playing ? "pause" : "play"} size={16} />
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* The activity track                                                  */
/* ------------------------------------------------------------------ */

/**
 * The file's history along a line, cut down to where something happened:
 * idle stretches are squeezed so a day of gaps doesn't hide a session.
 * Activity as a soft hill, yuzu ticks for your comments, trim ends and a playhead.
 */
function Track({
  bounds,
  ops,
  ticks,
  range,
  onRange,
  playhead,
  onSeek,
  trims = true,
  films = [],
  onWatch,
}: {
  bounds: Range;
  ops: number[];
  ticks: number[];
  range?: Range;
  onRange?: (r: Range) => void;
  playhead: number | null;
  onSeek: (real: number) => void;
  trims?: boolean;
  /** Films already made, each over the stretch it covered. */
  films?: PastFilm[];
  onWatch?: (f: PastFilm) => void;
}) {
  const line = useRef<HTMLDivElement>(null);
  const scale = useMemo(() => compressedScale(ops), [ops]);
  const x = (t: number) => scale.toX(t) * 100;
  const fromX = (px: number) => {
    const el = line.current!;
    const r = el.getBoundingClientRect();
    return scale.fromX(Math.min(1, Math.max(0, (px - r.left) / r.width)));
  };
  const drag = (which: "from" | "to" | "seek") => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const real = fromX(ev.clientX);
      if (which === "seek") onSeek(real);
      else if (range && onRange) {
        if (which === "from") onRange({ from: Math.min(real, range.to - 1000), to: range.to });
        else onRange({ from: range.from, to: Math.max(real, range.from + 1000) });
      }
    };
    move(e.nativeEvent);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const hill = useMemo(() => activityPath(ops, scale), [ops, scale]);
  void bounds;
  return (
    <div className="flex flex-col gap-1.5">
      <div
        ref={line}
        className="relative h-10 cursor-pointer select-none rounded-[10px] bg-secondary"
        onPointerDown={drag("seek")}
      >
        <svg
          className="absolute inset-0 size-full overflow-visible"
          viewBox="0 0 100 10"
          preserveAspectRatio="none"
          aria-hidden
        >
          <path d={hill} fill="var(--hairline-strong)" />
        </svg>
        {range && trims && (
          <>
            <div
              className="absolute inset-y-0 left-0 rounded-l-[10px] bg-background/55"
              style={{ width: `${x(range.from)}%` }}
            />
            <div
              className="absolute inset-y-0 right-0 rounded-r-[10px] bg-background/55"
              style={{ width: `${100 - x(range.to)}%` }}
            />
            <div
              className="absolute inset-y-0 rounded-[8px] shadow-[inset_0_0_0_1.5px_var(--foreground)]"
              style={{ left: `${x(range.from)}%`, width: `${x(range.to) - x(range.from)}%` }}
            />
            {(["from", "to"] as const).map((w) => (
              <div
                key={w}
                role="slider"
                aria-label={w === "from" ? "Start" : "End"}
                aria-valuenow={range[w]}
                tabIndex={0}
                onPointerDown={drag(w)}
                className="absolute inset-y-0 z-[2] w-3 -translate-x-1/2 cursor-ew-resize"
                style={{ left: `${x(range[w])}%` }}
              >
                <span className="absolute inset-y-1.5 left-1/2 w-[5px] -translate-x-1/2 rounded-full bg-foreground" />
              </div>
            ))}
          </>
        )}
        {clusterTicks(ticks.map(x)).map((c) => (
          <span
            key={c.at}
            className="absolute top-1.5 h-2 -translate-x-1/2 rounded-full bg-[#ffc81e] shadow-[0_0_0_1px_rgba(17,17,16,0.18)]"
            style={{ left: `${c.at}%`, width: `calc(0.5rem + ${c.span}%)` }}
            title={c.n > 1 ? `${c.n} comments` : "A comment"}
          />
        ))}
        {playhead !== null && (
          <span
            className="pointer-events-none absolute -inset-y-1 z-[1] w-[2px] -translate-x-1/2 rounded-full bg-foreground"
            style={{ left: `${x(playhead)}%` }}
          />
        )}
      </div>
      {films.length > 0 && (
        // The films already made, each under the stretch it covered: click one to watch it.
        <div className="relative h-6">
          {films.map((f) => {
            const r = f.range!;
            const left = x(r.from);
            const w = Math.max(1.2, x(r.to) - left);
            return (
              <Tip key={f.name} label={`Watch the ${filmDate(f.at)} film`}>
                <button
                  type="button"
                  onClick={() => onWatch?.(f)}
                  className="absolute inset-y-0 flex min-w-6 items-center justify-center gap-1 overflow-hidden rounded-[7px] bg-secondary px-1.5 text-[11px] text-muted-foreground shadow-[inset_0_0_0_1px_var(--hairline-strong)] hover:bg-accent hover:text-foreground"
                  style={{ left: `${left}%`, width: `${w}%` }}
                >
                  <Icon name="play" size={10} />
                  <span className="truncate tabular-nums">{filmDate(f.at)}</span>
                </button>
              </Tip>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** “Today, 4:12 PM”, “Yesterday, 9:02 AM”, else “Oct 18”. */
function filmDate(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 86_400_000);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Ticks closer than about a tick's width merge into one longer mark, so a run of comments reads as a run. */
function clusterTicks(xs: number[]): { at: number; span: number; n: number }[] {
  const sorted = [...xs].sort((a, b) => a - b);
  const out: { from: number; to: number; n: number }[] = [];
  for (const v of sorted) {
    const last = out[out.length - 1];
    if (last && v - last.to < 1.6) {
      last.to = v;
      last.n++;
    } else out.push({ from: v, to: v, n: 1 });
  }
  return out.map((c) => ({ at: (c.from + c.to) / 2, span: c.to - c.from, n: c.n }));
}

/** A time scale where gaps over a minute count as a minute, so sessions get the room. */
function compressedScale(ops: number[]) {
  const CAP = 60_000;
  const marks: { t: number; u: number }[] = [];
  let u = 0;
  for (let i = 0; i < ops.length; i++) {
    if (i > 0) u += Math.min(CAP, ops[i]! - ops[i - 1]!);
    marks.push({ t: ops[i]!, u });
  }
  const total = Math.max(1, u);
  const pad = 0.02;
  const toX = (t: number) => {
    if (!marks.length) return 0;
    if (t <= marks[0]!.t) return pad;
    for (let i = 1; i < marks.length; i++) {
      const a = marks[i - 1]!;
      const b = marks[i]!;
      if (t <= b.t) {
        const p = b.t === a.t ? 1 : (t - a.t) / (b.t - a.t);
        return pad + ((a.u + (b.u - a.u) * p) / total) * (1 - 2 * pad);
      }
    }
    return 1 - pad;
  };
  const fromX = (x: number) => {
    if (!marks.length) return 0;
    const target = ((x - pad) / (1 - 2 * pad)) * total;
    if (target <= 0) return marks[0]!.t;
    for (let i = 1; i < marks.length; i++) {
      const a = marks[i - 1]!;
      const b = marks[i]!;
      if (target <= b.u) {
        const p = b.u === a.u ? 1 : (target - a.u) / (b.u - a.u);
        return a.t + (b.t - a.t) * p;
      }
    }
    return marks[marks.length - 1]!.t;
  };
  return { toX, fromX };
}

function activityPath(ops: number[], scale: { toX: (t: number) => number }): string {
  const N = 80;
  const bins = new Array(N).fill(0);
  for (const t of ops) bins[Math.min(N - 1, Math.floor(scale.toX(t) * N))]++;
  // Smooth.
  const sm = bins.map((_, i) => {
    let s = 0;
    let w = 0;
    for (let k = -3; k <= 3; k++) {
      const v = bins[i + k];
      if (v === undefined) continue;
      const wt = 4 - Math.abs(k);
      s += v * wt;
      w += wt;
    }
    return s / w;
  });
  const max = Math.max(1, ...sm);
  const pts = sm.map((v, i) => `${((i + 0.5) / N) * 100},${10 - (v / max) * 5.5}`);
  return `M0,10 L${pts.join(" L")} L100,10 Z`;
}

/* ------------------------------------------------------------------ */
/* Done                                                                */
/* ------------------------------------------------------------------ */

function Ready({
  open,
  onOpenChange,
  file,
  film,
  name,
  onToast,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  file: string;
  film: FilmView;
  name: string;
  onToast: (s: string) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(true);
  const [t, setT] = useState(0);
  const [ticks, setTicks] = useState<number[]>([]);
  const [length, setLength] = useState(film.duration ?? 0);
  const src = film.src;
  const desktop = window.ponzuDesktop;

  // Ticks on the film's own clock, where the comments sweep in: known for a film just made
  // here (a past one's range isn't kept, so it plays without them).
  useEffect(() => {
    if (!open || !film.range) return;
    let live = true;
    void journalText(file).then(async (text) => {
      const entries = parseJournal(text);
      const m = await buildReel({
        name,
        entries,
        shape: "16:9",
        range: film.range ?? lastSession(entries) ?? undefined,
        theme: film.theme ?? "light",
      }).catch(() => null);
      if (live && m) setTicks(m.comments.map((c) => c.at));
    });
    return () => {
      live = false;
    };
  }, [open, film, file, name]);

  const duration = length;
  const copy = async (): Promise<boolean> => {
    if (desktop?.copyFile) {
      await desktop.copyFile(film.path);
      return true;
    }
    try {
      const blob = await (await fetch(src)).blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      return true;
    } catch {
      return false;
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={
        film.range ? (
          "Timelapse ready"
        ) : (
          <>
            Timelapse
            <span className="truncate font-normal text-muted-foreground">{film.name}</span>
          </>
        )
      }
    >
      <div className="relative mx-auto aspect-video max-h-[calc(100vh-300px)] w-full max-w-[calc((100vh-300px)*16/9)] overflow-hidden rounded-[10px] bg-canvas shadow-[0_0_0_1px_var(--hairline)]">
        <video
          ref={video}
          src={src}
          autoPlay
          loop
          playsInline
          muted
          onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => setLength(e.currentTarget.duration || length)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          className="block size-full"
        />
      </div>
      <FilmTrack
        duration={duration}
        t={t}
        ticks={ticks}
        onSeek={(s) => {
          if (video.current) video.current.currentTime = s;
          setT(s);
        }}
      />
      <div className="flex items-center gap-2">
        <PlayButton
          playing={playing}
          onClick={() => {
            const v = video.current;
            if (!v) return;
            if (v.paused) void v.play();
            else v.pause();
          }}
        />
        <span className="font-mono text-[12px] tabular-nums">
          {fmt(t)} <span className="text-faint">/ {fmt(duration)}</span>
        </span>
        <div className="ml-auto flex items-center gap-2">
          {desktop ? (
            <button
              type="button"
              onClick={() => desktop.reveal(film.path)}
              className="flex h-8 items-center gap-1.5 rounded-[9px] px-3 text-[13px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Icon name="folderOpen" size={15} />
              Show in Finder
            </button>
          ) : (
            <a
              href={src}
              download={film.name}
              className="flex h-8 items-center gap-1.5 rounded-[9px] px-3 text-[13px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Icon name="download" size={15} />
              Download
            </a>
          )}
          <button
            type="button"
            onClick={async () => {
              const copied = await copy();
              const text = encodeURIComponent(`Made in Ponzu: ${name}`);
              window.open(`https://x.com/intent/post?text=${text}`, "_blank", "noopener");
              onToast(
                copied
                  ? "Video copied, paste it into your post"
                  : "Download the video, then attach it to your post",
              );
            }}
            className="flex h-8 items-center gap-1.5 rounded-[9px] bg-secondary px-3 text-[13px] font-medium text-foreground shadow-[0_0_0_0.5px_var(--hairline-strong)] hover:bg-accent"
          >
            <Icon name="x" size={14} />
            Post
          </button>
          <button
            type="button"
            onClick={async () =>
              onToast(
                (await copy()) ? "Video copied" : "This browser can’t copy video; use Download",
              )
            }
            className="flex h-8 items-center gap-1.5 rounded-[9px] bg-foreground px-3 text-[13px] font-medium text-background hover:bg-foreground/90"
          >
            <Icon name="copy" size={15} />
            Copy video
          </button>
        </div>
      </div>
    </Sheet>
  );
}

/** The done dialog's track: the film's own time, comment ticks and a playhead, no trims. */
function FilmTrack({
  duration,
  t,
  ticks,
  onSeek,
}: {
  duration: number;
  t: number;
  ticks: number[];
  onSeek: (s: number) => void;
}) {
  const line = useRef<HTMLDivElement>(null);
  const at = (clientX: number) => {
    const r = line.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * duration;
  };
  return (
    <div
      ref={line}
      role="slider"
      aria-label="Seek"
      aria-valuenow={t}
      tabIndex={0}
      className="relative h-10 cursor-pointer select-none rounded-[10px] bg-secondary"
      onPointerDown={(e) => {
        (e.target as Element).setPointerCapture(e.pointerId);
        onSeek(at(e.clientX));
        const move = (ev: PointerEvent) => onSeek(at(ev.clientX));
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
    >
      <div
        className="absolute inset-y-0 left-0 rounded-l-[10px] bg-foreground/[0.06]"
        style={{ width: `${(t / Math.max(0.001, duration)) * 100}%` }}
      />
      {ticks.map((s) => (
        <span
          key={s}
          className="absolute top-1.5 size-2 -translate-x-1/2 rounded-full bg-[#ffc81e] shadow-[0_0_0_1px_rgba(17,17,16,0.18)]"
          style={{ left: `${(s / duration) * 100}%` }}
        />
      ))}
      <span
        className="pointer-events-none absolute -inset-y-1 w-[2px] -translate-x-1/2 rounded-full bg-foreground"
        style={{ left: `${(t / Math.max(0.001, duration)) * 100}%` }}
      />
    </div>
  );
}

function Toast({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <div
      role="status"
      className="fixed bottom-6 left-1/2 z-[60] flex h-10 -translate-x-1/2 items-center gap-3.5 rounded-xl bg-foreground pr-2 pl-3.5 text-[13px] text-home shadow-[0_1px_2px_rgba(0,0,0,0.06),0_8px_28px_rgba(0,0,0,0.1)]"
    >
      <span>{text}</span>
      <button type="button" aria-label="Dismiss" onClick={onClose} className="px-1.5 opacity-70">
        <Icon name="close" size={13} />
      </button>
    </div>
  );
}
