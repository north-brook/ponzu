import {
  type Artboard,
  beatIndexAt,
  type Cam,
  camOnPath,
  clamp01,
  type Doc,
  ease,
  pageDipAt,
  progress,
  type Thread,
} from "@ponzu/core";
import {
  artboardMarkup,
  artboardSize,
  Icon,
  loadArtboardFonts,
  MemorySource,
  pinClass,
  pinWrapClass,
  SLICE,
  SLICE_STROKE,
  ThreadCard,
  Trace,
  type Worker,
  WorkingStatus,
} from "@ponzu/react";
import { type CSSProperties, memo, useLayoutEffect, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";
import { type FilmModel, fallbackCam, pinSpot, type Swap, schemeFor } from "./model.ts";

/** How long one piece takes to rise in, and how far. */
export const STREAM_MS = 500;
export const STREAM_RISE = 6;
/** The gap between pieces of one change, at most. */
const STAGGER = 0.07;
/** The old look of a changed part hands over to the new in this long. */
const HANDOFF = 0.12;
const PIN_IN = 0.32;
const PIN_OUT = 0.34;

/**
 * One frame of a timelapse, as a pure function of film time `f` (seconds):
 * the canvas with the real artboard renderer, pins, thread cards, trace and
 * working status, under a scripted camera; then the brand's end card.
 */
export function Film({ model, f }: { model: FilmModel; f: number }) {
  const { plan, view } = model;
  const k = beatIndexAt(plan, f);
  const doc = model.docs[k + 1]!;
  const heights = model.heights[k + 1]!;
  const cam: Cam = camOnPath(model.camera, f) ?? fallbackCam(model, doc);
  const page = doc.pages.find((p) => p.id === cam.page) ?? doc.pages[0];
  const end = f - model.plan.endCard;
  const root = useRef<HTMLDivElement>(null);
  const empty = useMemo(() => new MemorySource(model.docs[0]!), [model]);

  const tx = view.w / 2 - cam.cx * cam.zoom;
  const ty = view.h / 2 - cam.cy * cam.zoom;
  const toScreen = (x: number, y: number) => ({ x: x * cam.zoom + tx, y: y * cam.zoom + ty });

  const working = workingAt(model, f);
  const boards = page?.artboards ?? [];

  // Stream-in: the pieces of recent changes rise and fade in, one after another.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    applyStream(el, model, f);
    keepCardsInFrame(el, view);
  });

  // Pins: open ones, plus ones leaving after their thread resolved.
  const pins = pinsAt(model, f, cam.page);
  const cards = cardsAt(model, f);
  const dip = pageDipAt(model.camera, f);
  const canvasFade = end > -0.35 ? clamp01((end + 0.35) / 0.35) : 0;

  return (
    <div
      ref={root}
      className={cn("pz-root pz-film", `pz-${model.theme}`)}
      style={{ width: view.w, height: view.h }}
      data-film-frame={Math.round(f * 1000)}
    >
      <div className="pz:absolute pz:inset-0 pz:overflow-hidden">
        <div
          className="pz:absolute pz:top-0 pz:left-0 pz:origin-top-left"
          style={{ transform: `translate(${tx}px, ${ty}px) scale(${cam.zoom})` }}
        >
          {boards.map((ab) => {
            const appear = boardAppear(model, ab.id, f);
            if (appear === null) return null;
            const ghost = ghostFor(model, ab.id, f);
            const who = working.get(ab.id);
            const { w, h } = artboardSize(ab);
            return (
              <div
                key={ab.id}
                className="pz:absolute pz:shadow-board"
                style={{
                  left: ab.x,
                  top: ab.y,
                  width: w,
                  height: h ?? undefined,
                  // A new board arrives solid (a dark one never passes through grey): it grows
                  // in from slightly smaller, behind a quick fade of the first few frames.
                  opacity: Math.min(1, appear * 2.5),
                  scale: String(0.97 + 0.03 * appear),
                  transformOrigin: "50% 40%",
                }}
              >
                <div
                  className={cn(
                    "pz:absolute pz:left-0 pz:flex pz:items-center pz:gap-[0.5em] pz:whitespace-nowrap pz:leading-[1.4] pz:max-w-full",
                    who ? "pz:right-0 pz:text-foreground" : "pz:text-muted-foreground",
                  )}
                  style={{ fontSize: 12 / cam.zoom, top: -22 / cam.zoom }}
                >
                  <span className={cn("pz:min-w-0 pz:truncate", who && "pz-shimmer")}>
                    {ab.name}
                  </span>
                  {who && <WorkingStatus who={who} zoom={cam.zoom} />}
                </div>
                <FilmBoard artboard={ab} doc={doc} model={model} />
                {ghost && (
                  <div
                    className="pz:pointer-events-none pz:absolute pz:inset-0"
                    style={{
                      opacity: ghost.opacity,
                      clipPath: ghost.box
                        ? `inset(${ghost.box.y}px ${w - ghost.box.x - ghost.box.w}px calc(100% - ${ghost.box.y + ghost.box.h}px) ${ghost.box.x}px)`
                        : undefined,
                    }}
                  >
                    <FilmBoard artboard={ghost.artboard} doc={ghost.doc} model={model} />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="pz:pointer-events-none pz:absolute pz:inset-0">
          {boards.map((ab) => {
            if (!working.has(ab.id)) return null;
            const p = toScreen(ab.x, ab.y);
            const h = heights.get(ab.id) ?? artboardSize(ab).h ?? 900;
            return (
              <div key={ab.id} style={{ opacity: working.get(ab.id)?.[0] ? 1 : 0 }}>
                <Trace x={p.x} y={p.y} w={artboardSize(ab).w * cam.zoom} h={h * cam.zoom} />
              </div>
            );
          })}
          {pins.map(({ thread, spot, scale, opacity }) => {
            const p = toScreen(spot.x, spot.y);
            const card = cards.find((c) => c.thread.id === thread.id);
            const flip = p.x + 330 > view.w;
            // Low in the frame, the card opens upward so it isn't cut off.
            const up = p.y + 150 > view.h;
            return (
              <div
                key={thread.id}
                className={cn(pinWrapClass, card ? "pz:z-[3]" : "pz:z-[2]")}
                style={{ left: p.x, top: p.y }}
              >
                <span
                  className={cn(pinClass, "pz-film-pin pz:bg-comment pz:text-comment-foreground")}
                  style={{ scale: String(scale), opacity }}
                >
                  {thread.messages.length}
                </span>
                {card && (
                  <div
                    data-film-card
                    className={cn(
                      "pz-film-card",
                      flip && "pz-film-card-flip",
                      up && "pz-film-card-up",
                    )}
                    style={{
                      opacity: card.opacity,
                      translate: `0 ${(1 - card.opacity) * 4}px`,
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

        {dip > 0 && (
          <div className="pz:absolute pz:inset-0 pz:bg-background" style={{ opacity: dip }} />
        )}
        <Wayfinding model={model} doc={doc} pageId={cam.page} />
      </div>
      {canvasFade > 0 && (
        <EndCard model={model} t={Math.max(0, end)} opacity={ease.out(canvasFade)} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Boards                                                              */
/* ------------------------------------------------------------------ */

/**
 * One artboard, drawn the way the canvas draws it (ArtboardView's markup in a
 * shadow root). Replaces its markup only when the board changed.
 */
const FilmBoard = memo(function FilmBoard({
  artboard,
  doc,
  model,
}: {
  artboard: Artboard;
  doc: Doc;
  model: FilmModel;
}) {
  const host = useRef<HTMLDivElement>(null);
  const last = useRef("");
  const scheme = schemeFor(doc, artboard, model.theme);
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const root = el.shadowRoot ?? el.attachShadow({ mode: "open" });
    const { html, fonts } = artboardMarkup(artboard, doc.tokens, model.assetBase, scheme);
    if (html === last.current) return;
    last.current = html;
    loadArtboardFonts(fonts);
    root.innerHTML = html;
  }, [artboard, doc.tokens, model.assetBase, scheme]);
  return <div ref={host} data-artboard-host={artboard.id} style={{ display: "contents" }} />;
});

/** 0 → 1 as a new board arrives; null before it exists. Boards present at the start are just there. */
function boardAppear(model: FilmModel, id: string, f: number): number | null {
  const born = model.born.get(id);
  if (born === undefined) return 1;
  if (f < born) return null;
  return progress(f, born, born + STREAM_MS / 1000, ease.out);
}

/**
 * The board as it was before a change, over the new one. Never two layouts at
 * once for long: a restyle holds the old picture whole and hands over in a
 * blink; replaced contents keep the old picture of their box until the new
 * pieces start to rise, then it clears quickly, so nothing dips to empty.
 */
function ghostFor(
  model: FilmModel,
  id: string,
  f: number,
): { artboard: Artboard; doc: Doc; opacity: number; box?: Swap["box"] } | null {
  const k = beatIndexAt(model.plan, f);
  for (let j = k; j >= 0 && j > k - 3; j--) {
    const b = model.plan.beats[j]!;
    const swap = model.touched[j]!.find((t) => t.board === id);
    if (!swap) continue;
    const start = b.at + swap.hold;
    // A part swaps in a cut (the new pieces rise over it); a restyled board hands over quickly.
    const handoff = swap.box ? 1 / 30 : HANDOFF;
    if (f - start > handoff) return null;
    const prev = model.docs[j]!;
    const ab = prev.pages.flatMap((p) => p.artboards).find((a) => a.id === id);
    if (!ab) return null;
    return {
      artboard: ab,
      doc: prev,
      box: swap.box,
      opacity: f < start ? 1 : 1 - progress(f, start, start + handoff, ease.in),
    };
  }
  return null;
}

/**
 * Pieces of changes rise 6px and fade in, staggered, over 500ms. Driven
 * from film time, so a frame is the same however it's reached.
 */
function applyStream(root: HTMLElement, model: FilmModel, f: number) {
  const k = beatIndexAt(model.plan, f);
  const live = new Set<Element>();
  for (let j = k; j >= 0; j--) {
    const b = model.plan.beats[j]!;
    const units = model.units[j]!;
    const span = streamSpan(model, j);
    if (f - b.at > span + STREAM_MS / 1000) break;
    if (!units.length) continue;
    const step = span / Math.max(1, units.length);
    units.forEach((id, n) => {
      const local = (f - b.at - n * step) * 1000;
      if (local >= STREAM_MS) return;
      for (const host of root.querySelectorAll("[data-artboard-host]")) {
        const el = host.shadowRoot?.querySelector(`[data-id="${CSS.escape(id)}"]`);
        if (!el || live.has(el)) continue;
        live.add(el);
        const anim = streamAnim(el);
        anim.currentTime = Math.max(0, local);
      }
    });
  }
  // Pieces past their rise go back to their own styles.
  for (const el of streaming) {
    if (live.has(el)) continue;
    streamAnims.get(el)?.cancel();
    streamAnims.delete(el);
    streaming.delete(el);
  }
}

const streaming = new Set<Element>();
const streamAnims = new WeakMap<Element, Animation>();

function streamAnim(el: Element): Animation {
  let a = streamAnims.get(el);
  if (!a) {
    // One keyframe: the end is the element's own opacity and position.
    a = el.animate([{ opacity: 0, translate: `0 ${STREAM_RISE}px` }], {
      duration: STREAM_MS,
      easing: "cubic-bezier(.2,.8,.2,1)",
      fill: "both",
    });
    a.pause();
    streamAnims.set(el, a);
    streaming.add(el);
  }
  return a;
}

/** How long a beat's pieces take to start, end to end. */
function streamSpan(model: FilmModel, j: number): number {
  const b = model.plan.beats[j]!;
  const n = model.units[j]!.length;
  return Math.min(n * STAGGER, Math.max(0, (b.end - b.at) * 0.8 - STREAM_MS / 1000));
}

/* ------------------------------------------------------------------ */
/* Agents at work                                                      */
/* ------------------------------------------------------------------ */

/** Boards an agent is working on at `f`, with its mark, as the canvas shows them. */
function workingAt(model: FilmModel, f: number): Map<string, Worker[]> {
  const out = new Map<string, Worker[]>();
  for (const w of model.working) {
    if (f >= w.from && f <= w.to)
      out.set(w.board, [{ id: w.who.name, name: w.who.name, client: w.who.client }]);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Comments                                                            */
/* ------------------------------------------------------------------ */

function pinsAt(model: FilmModel, f: number, page: string) {
  const k = beatIndexAt(model.plan, f);
  const doc = model.docs[k + 1]!;
  const out: {
    thread: Thread;
    spot: { x: number; y: number };
    scale: number;
    opacity: number;
  }[] = [];
  const bornAt = (id: string) => model.pinBorn.get(id);
  for (const t of doc.threads) {
    if (t.status !== "open") continue;
    const spot = pinSpot(doc, t);
    if (!spot || spot.page !== page) continue;
    const born = bornAt(t.id);
    let scale = 1;
    let opacity = 1;
    if (born !== undefined && f - born < PIN_IN) {
      const p = clamp01((f - born) / PIN_IN);
      // A pop: overshoot, then settle.
      scale =
        p < 0.55
          ? 0.5 + (1.14 - 0.5) * ease.out(p / 0.55)
          : 1.14 - 0.14 * ease.inOut((p - 0.55) / 0.45);
      opacity = clamp01(p * 3);
    }
    out.push({ thread: t, spot, scale, opacity });
  }
  // Threads resolved a moment ago, leaving.
  for (let j = k; j >= 0; j--) {
    const b = model.plan.beats[j]!;
    if (f - b.at > PIN_OUT) break;
    if (b.kind !== "resolve" || !b.thread) continue;
    const before = model.docs[j]!;
    const t = before.threads.find((x) => x.id === b.thread);
    const spot = t && pinSpot(before, t);
    if (!t || !spot || spot.page !== page) continue;
    const p = ease.in(clamp01((f - b.at) / PIN_OUT));
    out.push({ thread: t, spot, scale: 1 - 0.7 * p, opacity: 1 - p });
  }
  return out;
}

/** Thread cards showing at `f`: each comment's own beat, and an agent's reply. */
function cardsAt(model: FilmModel, f: number) {
  const k = beatIndexAt(model.plan, f);
  const out: { thread: Thread; opacity: number; now: number }[] = [];
  for (let j = Math.max(0, k - 1); j <= k; j++) {
    const b = model.plan.beats[j];
    if (!b || (b.kind !== "comment" && b.kind !== "reply") || !b.thread) continue;
    const doc = model.docs[Math.min(model.docs.length - 1, k + 1)]!;
    const t = doc.threads.find((x) => x.id === b.thread && x.status === "open");
    if (!t) continue;
    // In with the pin, out as the next beat lands (or as this one ends).
    const next = model.plan.beats[j + 1];
    const until = Math.min(b.end + 0.1, next ? next.at + 0.05 : b.end);
    const fadeIn = progress(f, b.at + 0.06, b.at + 0.3, ease.out);
    const fadeOut = 1 - progress(f, until - 0.2, until, ease.in);
    const opacity = Math.min(fadeIn, fadeOut);
    if (opacity <= 0.001) continue;
    out.push({ thread: t, opacity, now: b.t + 1000 });
  }
  return out;
}

/** Inside this far from the frame's edges, and below the wayfinding line. */
const SAFE = 16;
const SAFE_TOP = 56;

/**
 * Thread cards stay whole inside the frame: one that would run off an edge
 * slides back in. Measured after layout, so it's the same on every render.
 */
function keepCardsInFrame(root: HTMLElement, view: { w: number; h: number }) {
  const frame = root.getBoundingClientRect();
  const k = frame.width / view.w || 1;
  for (const wrap of root.querySelectorAll<HTMLElement>("[data-film-card]")) {
    const card = wrap.firstElementChild as HTMLElement | null;
    if (!card) continue;
    card.style.translate = "";
    const r = card.getBoundingClientRect();
    const x = (r.left - frame.left) / k;
    const y = (r.top - frame.top) / k;
    const w = r.width / k;
    const h = r.height / k;
    const dx = Math.min(0, view.w - SAFE - (x + w)) || Math.max(0, SAFE - x);
    const dy = Math.min(0, view.h - SAFE - (y + h)) || Math.max(0, SAFE_TOP - y);
    if (dx || dy) card.style.translate = `${dx}px ${dy}px`;
  }
}

/* ------------------------------------------------------------------ */
/* Wayfinding and the end card                                         */
/* ------------------------------------------------------------------ */

/** The one overlay: the slice / file / page, in the corner. */
function Wayfinding({ model, doc, pageId }: { model: FilmModel; doc: Doc; pageId: string }) {
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
 * The brand's bloom on the canvas colour: the six segments bloom in, "ponzu"
 * wipes on, the slice turns one segment, then ponzu.design fades in.
 */
function EndCard({ model, t, opacity }: { model: FilmModel; t: number; opacity: number }) {
  const ink = model.theme === "dark" ? "#f4f3ef" : "#111110";
  const short = Math.min(model.view.w, model.view.h);
  const mark = Math.round(short * 0.13);
  const word = Math.round(mark * 0.62);
  const turn = 60 * progress(t, 0.7, 1.0, ease.out);
  const wipe = progress(t, 0.26, 0.66, ease.out);
  const url = progress(t, 0.62, 0.9, ease.out);
  return (
    <div
      className="pz:absolute pz:inset-0 pz:flex pz:flex-col pz:items-center pz:justify-center pz:bg-background"
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
              const p = progress(t, i * 0.06, i * 0.06 + 0.5, ease.out);
              return (
                <path
                  key={d}
                  d={d}
                  style={{
                    transformBox: "view-box",
                    transformOrigin: "32px 32px",
                    transform: `scale(${p}) rotate(${-90 * (1 - p)}deg)`,
                    opacity: clamp01(p * 1.6),
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
