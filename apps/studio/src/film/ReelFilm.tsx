import { bezier, type Cam, clamp01, ease, flyTo, progress } from "@ponzu/core";
import { Icon, pinClass, pinWrapClass, SLICE, SLICE_STROKE, Trace } from "@ponzu/react";
import { useLayoutEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { applyRise, FilmBoard } from "./Film.tsx";
import { PIECE_MS, type Reel, type ReelComment, SHEET_LEAD } from "./reel.ts";

/** Between one new piece of a revision and the next (s). */
const REV_STEP = 0.07;
/** A revision's old pieces fade off over this long while the new arrive. */
const OUT = 0.15;
/** A pan from one group of screens to the next, through the canvas (s). */
const PAN = 0.7;
/** The zoom out to every screen at the end (s). */
const ZOOM_OUT = 1.1;

/** The segment playing at `f`. */
function segmentAt(r: Reel, f: number) {
  let i = 0;
  while (i + 1 < r.segments.length && r.segments[i + 1]!.t0 <= f) i++;
  return i;
}

/** Where a shot's camera rests: on its screens, leaning in a touch while it's on (never a still). */
function restingCam(r: Reel, k: number, f: number): Cam {
  const shot = r.shots[k]!;
  const segs = r.segments.filter((s) => s.shot === k);
  const t0 = Math.min(...segs.map((s) => s.t0));
  const t1 = Math.max(...segs.map((s) => s.t1));
  const cam = shot.cam;
  const zoom = cam.zoom * (1 + 0.022 * progress(f, t0, t1, ease.inOut));
  // Screens that share a shot arrive one after another: the frame centres what's there so far,
  // easing across as each next one comes, so the first is never alone at the edge.
  const build = segs.find((s) => s.kind === "build");
  if (shot.boards.length < 2 || !build || f >= build.t1) return { ...cam, zoom };
  const centre = (n: number) => {
    const xs = shot.boards.slice(0, n).map((id) => shot.place.get(id)!.x);
    const x1s = shot.boards.slice(0, n).map((id) => shot.place.get(id)!.x + r.boards.get(id)!.w);
    return (Math.min(...xs) + Math.max(...x1s)) / 2;
  };
  let cx = centre(1);
  shot.boards.forEach((id, j) => {
    if (j === 0) return;
    const a = (r.boardAt.get(id) ?? 0) - 0.25;
    cx += (centre(j + 1) - centre(j)) * ease.inOut(clamp01((f - a) / 0.45));
  });
  return { ...cam, cx, zoom };
}

/**
 * The one camera: at rest on the shot that's on, and between shots a glide across the canvas to
 * the next, landing as its first screen appears. Into the last shot it zooms out to every screen.
 */
function camAt(r: Reel, f: number): Cam {
  const i = segmentAt(r, f);
  const seg = r.segments[i]!;
  const next = r.segments[i + 1];
  if (next && next.shot !== seg.shot) {
    const last = next.kind === "result";
    const span = last ? ZOOM_OUT : PAN;
    const start = next.t0 - (last ? 0 : span * 0.55);
    if (f >= start) {
      const p = ease.inOut(clamp01((f - start) / span));
      return flyTo(
        restingCam(r, seg.shot, start),
        restingCam(r, next.shot, start + span),
        p,
        r.view,
      );
    }
  }
  const prev = r.segments[i - 1];
  if (prev && prev.shot !== seg.shot) {
    const last = seg.kind === "result";
    const span = last ? ZOOM_OUT : PAN;
    const start = seg.t0 - (last ? 0 : span * 0.55);
    if (f < start + span) {
      const p = ease.inOut(clamp01((f - start) / span));
      return flyTo(
        restingCam(r, prev.shot, start),
        restingCam(r, seg.shot, start + span),
        p,
        r.view,
      );
    }
  }
  return restingCam(r, seg.shot, f);
}

/** The canvas at film time `f`: every screen at its place, under the one camera. */
function Canvas({ r, f }: { r: Reel; f: number }) {
  const root = useRef<HTMLDivElement>(null);
  const { view } = r;
  const cam = camAt(r, f);
  const zoom = cam.zoom;
  const tx = view.w / 2 - cam.cx * zoom;
  const ty = view.h / 2 - cam.cy * zoom;
  const seg = r.segments[segmentAt(r, f)]!;
  const result = seg.kind === "result";
  const home = r.shots.at(-1)!;

  // Per board: which look, which pieces are still arriving, what's fading off.
  const states = home.boards.map((id) => {
    const b = r.boards.get(id)!;
    const rev = r.revisions.get(id);
    const revised = result || Boolean(rev && f >= rev.at);
    const look = revised ? b.after : b.before;
    const ids: string[] = [];
    const at: number[] = [];
    if (!revised)
      for (const p of r.pieces.get(id) ?? []) {
        ids.push(p.id);
        at.push((f - p.at) * 1000);
      }
    else if (rev && !result && f < rev.at + 1.2)
      rev.fresh.forEach((id2, j) => {
        ids.push(id2);
        at.push((f - rev.at - 0.05 - j * REV_STEP) * 1000);
      });
    // A board changed later with no revise shot of its own settles into its final look as the
    // camera zooms out (a crossfade, never a pop).
    const fading =
      rev && !result && revised
        ? progress(f, rev.at, rev.at + OUT, ease.in)
        : result && !rev
          ? progress(f, seg.t0, seg.t0 + 0.5, ease.inOut)
          : 1;
    // The blank sheet is just there a beat before its first piece (no sweep or fade of its own:
    // a dark one would pass through grey), then the screen is assembled on it.
    const from = (r.boardAt.get(id) ?? 0) - SHEET_LEAD;
    // The sheet is on the canvas by the time the camera heads for it: a pan lands on it, it
    // never pops in mid-glide.
    const sheet = result ? 1 : f >= from - PAN * 0.6 ? 1 : 0;
    // Working: the trace runs from the sheet until its last piece has landed, and again from a
    // beat before a revision lands until its last new piece has.
    const piece = PIECE_MS / 1000;
    const building = f >= from && f < (r.lastAt.get(id) ?? 0) + piece;
    const revising =
      rev &&
      f >= rev.at - 0.4 &&
      f < rev.at + 0.05 + Math.max(0, rev.fresh.length - 1) * REV_STEP + piece;
    const working = !result && (building || Boolean(revising));
    return { id, b, rev, look, ids, at, fading, sheet, working };
  });
  // The comments of the shot that's revising, if one is.
  const revising = seg.kind === "revise" ? r.shots[seg.shot]!.boards : [];

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    applyRise(el, { ids: states.flatMap((s) => s.ids), at: states.flatMap((s) => s.at) }, PIECE_MS);
  });

  const pins = r.comments.filter((c) => revising.includes(c.board));
  return (
    <div ref={root} className="pz:absolute pz:inset-0">
      {states.map(({ id, b, rev, look, fading, sheet }) => {
        if (sheet <= 0) return null;
        const p = home.place.get(id)!;
        // Off the frame: not drawn (a board is drawn once it comes into view).
        const x0 = p.x * zoom + tx;
        const y0 = p.y * zoom + ty;
        if (
          x0 > view.w + 40 ||
          y0 > view.h + 40 ||
          x0 + b.w * zoom < -40 ||
          y0 + look.h * zoom < -40
        )
          return null;
        return (
          <div
            key={id}
            className="pz-film-board pz:absolute pz:shadow-board"
            style={{
              left: 0,
              top: 0,
              transform: `translate(${p.x * zoom + tx}px, ${p.y * zoom + ty}px) scale(${zoom})`,
              transformOrigin: "0 0",
              width: b.w,
              height: look.h,
              opacity: sheet < 1 ? sheet : undefined,
            }}
          >
            <div
              className="pz:absolute pz:left-0 pz:right-0 pz:truncate pz:whitespace-nowrap pz:leading-[1.4] pz:text-muted-foreground"
              style={{ fontSize: 11.5 / zoom, top: -20 / zoom }}
            >
              {b.name}
            </div>
            <FilmBoard artboard={look.ab} doc={look.doc} model={r} />
            {fading < 1 && (
              <div
                style={{ position: "absolute", left: 0, top: 0, width: b.w, opacity: 1 - fading }}
              >
                <FilmBoard
                  artboard={b.before.ab}
                  doc={b.before.doc}
                  model={r}
                  only={rev && !rev.recolor ? rev.gone : undefined}
                />
              </div>
            )}
          </div>
        );
      })}
      <div className="pz:pointer-events-none pz:absolute pz:inset-0">
        {states
          .filter((s) => s.working && s.sheet > 0)
          .map(({ id, b, look }) => {
            const p = home.place.get(id)!;
            return (
              <Trace
                key={id}
                x={p.x * zoom + tx}
                y={p.y * zoom + ty}
                w={b.w * zoom}
                h={look.h * zoom}
              />
            );
          })}
        {pins.map((c) => (
          <Pin
            key={c.thread}
            c={c}
            f={f}
            at={{
              x: (home.place.get(c.board)!.x + c.x) * zoom + tx,
              y: (home.place.get(c.board)!.y + c.y) * zoom + ty,
            }}
            view={view}
          />
        ))}
      </div>
    </div>
  );
}

/** A comment: its pin pops in with a glimpse of what was said, then checks off once it's done. */
function Pin({
  c,
  f,
  at,
  view,
}: {
  c: ReelComment;
  f: number;
  at: { x: number; y: number };
  view: { w: number; h: number };
}) {
  if (f < c.at) return null;
  const pop = clamp01((f - c.at) / 0.28);
  const resolve = clamp01((f - c.resolveAt) / 0.55);
  if (resolve >= 1) return null;
  const scale =
    resolve > 0
      ? resolve < 0.3
        ? 1 + 0.25 * ease.out(resolve / 0.3)
        : 1.25 * (1 - ease.in((resolve - 0.3) / 0.7))
      : pop < 0.6
        ? 0.5 + 0.62 * ease.out(pop / 0.6)
        : 1.12 - 0.12 * ease.inOut((pop - 0.6) / 0.4);
  const card =
    progress(f, c.at + 0.08, c.at + 0.3, ease.out) *
    (1 - progress(f, c.cardOut - 0.18, c.cardOut, ease.in));
  // The card sits on the side with more room.
  const left = at.x > view.w * 0.62;
  return (
    <div className={cn(pinWrapClass, "pz:z-[3]")} style={{ left: at.x + 9, top: at.y - 9 }}>
      <span
        className={cn(pinClass, "pz-film-pin pz:bg-comment pz:text-comment-foreground")}
        style={{ scale: String(scale), opacity: clamp01(pop * 3) }}
      >
        {resolve > 0 ? <Icon name="check" size={13} strokeWidth={2.4} /> : 1}
      </span>
      {card > 0.01 && (
        <div
          className="pz:absolute pz:whitespace-nowrap pz:rounded-[10px] pz:bg-card pz:text-foreground pz:shadow-popover"
          style={{
            top: -4,
            ...(left ? { right: 18 } : { left: 18 }),
            padding: "6px 10px",
            font: "500 12.5px/1.3 Inter, system-ui, sans-serif",
            opacity: card,
            translate: `${(left ? 1 : -1) * (1 - card) * 6}px 0`,
            maxWidth: view.w * 0.46,
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {c.text}
        </div>
      )}
    </div>
  );
}

/** The slice: Ponzu's mark. */
function Mark({ size, ink }: { size: number; ink: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <g fill={ink} stroke={ink} strokeWidth={SLICE_STROKE} strokeLinejoin="round">
        {SLICE.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
    </svg>
  );
}

/**
 * The prompt: what the person asked for, set large and typed in, then sent. Just the words, no
 * agent's name: the film is the design.
 */
function Prompt({ r, f }: { r: Reel; f: number }) {
  const { view } = r;
  const text = r.prompt!.text;
  const d = r.times.prompt;
  const typed = progress(f, 0.05, d * 0.62, (x) => x);
  const sent = progress(f, d * 0.7, d * 0.7 + 0.14, ease.out);
  const out = progress(f, d - 0.3, d, ease.in);
  const n = Math.round(text.length * typed);
  const w = Math.min(view.w - 120, 700);
  return (
    <div
      className="pz:pointer-events-none pz:absolute pz:inset-0 pz:z-[6] pz:flex pz:items-center pz:justify-center"
      style={{
        opacity: 1 - out,
        translate: `0 ${-out * 18}px`,
        filter: out > 0 ? `blur(${out * 5}px)` : undefined,
      }}
    >
      <div
        className="pz:flex pz:items-end pz:gap-4 pz:rounded-[22px] pz:bg-card pz:px-6 pz:py-5 pz:text-foreground pz:shadow-popover"
        style={{
          width: w,
          fontSize: 30,
          lineHeight: 1.3,
          letterSpacing: "-0.01em",
          scale: String(1 - 0.02 * sent),
        }}
      >
        <span className="pz:min-w-0 pz:flex-1">
          {text.slice(0, n)}
          {sent === 0 && (
            <span
              className="pz:inline-block pz:align-[-0.12em] pz:bg-foreground"
              style={{ width: 2.5, height: "1.05em", marginLeft: 2 }}
            />
          )}
          <span style={{ color: "transparent" }}>{text.slice(n)}</span>
        </span>
        <span
          className="pz:grid pz:shrink-0 pz:place-items-center pz:rounded-full"
          style={{
            width: 44,
            height: 44,
            background: n > 0 ? "var(--pz-ink)" : "var(--pz-rule)",
            color: n > 0 ? "var(--pz-surface)" : "var(--pz-muted)",
            scale: String(1 - 0.14 * Math.sin(Math.PI * clamp01(sent * 1.6))),
          }}
        >
          <Icon name="send" size={20} strokeWidth={2} />
        </span>
      </div>
    </div>
  );
}

/**
 * The brand's bloom: each segment spins up into place from the centre a beat after the one before
 * (from scale 0 and −60°, 50ms apart), holds; then ponzu.design.
 */
function Bloom({ r, t, opacity }: { r: Reel; t: number; opacity: number }) {
  const ink = r.theme === "dark" ? "#f4f3ef" : "#111110";
  const short = Math.min(r.view.w, r.view.h);
  const mark = Math.round(short * 0.2);
  const spin = bezier(0.2, 0.8, 0.2, 1);
  const url = progress(t, 0.62, 0.95, ease.out);
  return (
    <div
      className="pz:absolute pz:inset-0 pz:z-[10] pz:flex pz:flex-col pz:items-center pz:justify-center pz:bg-background"
      style={{ opacity }}
    >
      <svg
        width={mark}
        height={mark}
        viewBox="0 0 64 64"
        style={{ overflow: "visible" }}
        aria-hidden
      >
        <g fill={ink} stroke={ink} strokeWidth={SLICE_STROKE} strokeLinejoin="round">
          {SLICE.map((d, i) => {
            const p = spin(clamp01((t - 0.05 - i * 0.05) / 0.7));
            return (
              <path
                key={d}
                d={d}
                style={{
                  transformBox: "view-box",
                  transformOrigin: "32px 32px",
                  scale: String(p),
                  rotate: `${-60 * (1 - p)}deg`,
                }}
              />
            );
          })}
        </g>
      </svg>
      <div
        style={{
          marginTop: mark * 0.34,
          font: `500 ${Math.round(short * 0.05)}px/1 "IBM Plex Mono", ui-monospace, monospace`,
          letterSpacing: "0.01em",
          color: r.theme === "dark" ? "#c9c5bc" : "#4a4741",
          opacity: url,
          transform: `translateY(${5 * (1 - url)}px)`,
        }}
      >
        ponzu.design
      </div>
    </div>
  );
}

/** A reel's frame at film time `f`. */
export function ReelFilm({ model: r, f }: { model: Reel; f: number }) {
  const { view, times } = r;
  const ink = r.theme === "dark" ? "#f4f3ef" : "#111110";
  const showing = f >= times.build;
  return (
    <div
      className={cn("pz-root pz-film", `pz-${r.theme}`)}
      style={{ width: view.w, height: view.h }}
      data-film-frame={Math.round(f * 1000)}
    >
      <div className="pz:absolute pz:inset-0 pz:overflow-hidden">
        {showing && <Canvas r={r} f={f} />}
        {/* Just the mark, top left: whose canvas this is. */}
        <div className="pz:absolute" style={{ left: 18, top: 16, opacity: 0.92 }}>
          <Mark size={20} ink={ink} />
        </div>
      </div>
      {r.prompt && f < times.prompt && <Prompt r={r} f={f} />}
      {f >= times.endCard - 0.25 && (
        <Bloom
          r={r}
          t={Math.max(0, f - times.endCard)}
          opacity={ease.out(clamp01((f - (times.endCard - 0.25)) / 0.25))}
        />
      )}
    </div>
  );
}
