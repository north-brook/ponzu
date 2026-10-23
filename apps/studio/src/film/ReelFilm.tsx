import { bezier, clamp01, ease, progress } from "@ponzu/core";
import {
  ARRIVE_EASING,
  ARRIVE_LAG_MS,
  ARRIVE_MS,
  Icon,
  pinClass,
  pinWrapClass,
  SLICE,
  SLICE_STROKE,
  Trace,
} from "@ponzu/react";
import { useLayoutEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { applyRise, FilmBoard } from "./Film.tsx";
import type { Reel, ReelComment } from "./reel.ts";

/** A revision's old pieces fade off over this long while the new arrive. */
const OUT = 0.15;
/** A shot's lean runs on a touch past its cut (s). */
const CUT = 0.16;

const arriveEase = (() => {
  const m = ARRIVE_EASING.match(/[\d.]+/g)!.map(Number) as [number, number, number, number];
  return bezier(...m);
})();
/** How far a sheet's sweep has got, `ms` after its first piece's write. */
const sweep = (ms: number) => arriveEase(clamp01((ms - ARRIVE_LAG_MS) / ARRIVE_MS));

/** The segment playing at `f`. Shots cut: a dissolve between two compositions is a muddy frame. */
function segmentAt(r: Reel, f: number) {
  let i = 0;
  while (i + 1 < r.segments.length && r.segments[i + 1]!.t0 <= f) i++;
  return r.segments[i]!;
}

/** One shot of the reel, at film time `f`. */
function Shot({ r, k, f, live }: { r: Reel; k: number; f: number; live: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const shot = r.shots[k]!;
  const { view } = r;
  const cam = shot.cam;
  const segs = r.segments.filter((s) => s.shot === k);
  const t0 = Math.min(...segs.map((s) => s.t0));
  const t1 = Math.max(...segs.map((s) => s.t1));
  // A shot leans in a touch while it's on, so it never sits still.
  const zoom = cam.zoom * (1 + 0.022 * progress(f, t0, t1 + CUT, ease.inOut));
  // Screens that share a shot arrive one after another: the frame centres what's there so far,
  // easing across as each next one comes, so the first is never alone at the edge.
  const cx = (() => {
    const build = segs.find((s) => s.kind === "build");
    if (shot.boards.length < 2 || !build || f >= build.t1) return cam.cx;
    const centre = (n: number) => {
      const xs = shot.boards.slice(0, n).map((id) => shot.place.get(id)!.x);
      const x1s = shot.boards.slice(0, n).map((id) => shot.place.get(id)!.x + r.boards.get(id)!.w);
      return (Math.min(...xs) + Math.max(...x1s)) / 2;
    };
    let x = centre(1);
    shot.boards.forEach((id, j) => {
      if (j === 0) return;
      const a = (r.boardAt.get(id) ?? 0) - 0.25;
      const p = ease.inOut(clamp01((f - a) / 0.45));
      x += (centre(j + 1) - centre(j)) * p;
    });
    return x;
  })();
  const tx = view.w / 2 - cx * zoom;
  const ty = view.h / 2 - cam.cy * zoom;
  const result = segs.some((s) => s.kind === "result");

  // Per board: which look, which pieces are still arriving, what's fading off.
  const states = shot.boards.map((id) => {
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
        at.push((f - rev.at - 0.05 - Math.min(j, 8) * 0.04) * 1000);
      });
    const fading = rev && !result && revised ? progress(f, rev.at, rev.at + OUT, ease.in) : 1;
    const sheet = result ? 1 : sweep((f - (r.boardAt.get(id) ?? 0)) * 1000);
    const working =
      !result && f >= (r.boardAt.get(id) ?? 0) && f < (r.lastAt.get(id) ?? 0) + ARRIVE_MS / 1000;
    return { id, b, rev, look, ids, at, fading, sheet, working };
  });

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    applyRise(el, {
      ids: states.flatMap((s) => s.ids),
      at: states.flatMap((s) => s.at),
    });
  });

  const pins = live && !result ? r.comments.filter((c) => shot.boards.includes(c.board)) : [];
  return (
    <div ref={root} className="pz:absolute pz:inset-0">
      {states.map(({ id, b, rev, look, fading, sheet }) => {
        if (sheet <= 0) return null;
        const p = shot.place.get(id)!;
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
              clipPath: sheet < 1 ? `inset(-40px ${(1 - sheet) * 100}% -40px -40px)` : undefined,
            }}
          >
            <div
              className="pz:absolute pz:left-0 pz:right-0 pz:truncate pz:whitespace-nowrap pz:leading-[1.4] pz:text-muted-foreground"
              style={{ fontSize: 11.5 / zoom, top: -20 / zoom }}
            >
              {b.name}
            </div>
            <FilmBoard artboard={look.ab} doc={look.doc} model={r} />
            {rev && fading < 1 && (
              <div
                style={{ position: "absolute", left: 0, top: 0, width: b.w, opacity: 1 - fading }}
              >
                <FilmBoard
                  artboard={b.before.ab}
                  doc={b.before.doc}
                  model={r}
                  only={rev.recolor ? undefined : rev.gone}
                />
              </div>
            )}
          </div>
        );
      })}
      {live && (
        <div className="pz:pointer-events-none pz:absolute pz:inset-0">
          {states
            .filter((s) => s.working && s.sheet >= 1)
            .map(({ id, b, look }) => {
              const p = shot.place.get(id)!;
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
                x: (shot.place.get(c.board)!.x + c.x) * zoom + tx,
                y: (shot.place.get(c.board)!.y + c.y) * zoom + ty,
              }}
              view={view}
            />
          ))}
        </div>
      )}
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
  const seg = segmentAt(r, Math.max(f, times.build));
  const showing = f >= times.build;
  return (
    <div
      className={cn("pz-root pz-film", `pz-${r.theme}`)}
      style={{ width: view.w, height: view.h }}
      data-film-frame={Math.round(f * 1000)}
    >
      <div className="pz:absolute pz:inset-0 pz:overflow-hidden">
        {showing && <Shot key={seg.shot} r={r} k={seg.shot} f={f} live />}
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
