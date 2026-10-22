import {
  type Artboard,
  type Cam,
  clamp01,
  type Doc,
  ease,
  flyTo,
  progress,
  shotAt,
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
  WorkingStatus,
} from "@ponzu/react";
import { type CSSProperties, memo, useLayoutEffect, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";
import type { Edit, Scene } from "./edit.ts";
import { pinSpot, schemeFor } from "./model.ts";

/** How long one piece takes to rise in, and how far. */
export const STREAM_MS = 500;
export const STREAM_RISE = 6;
const PIN_IN = 0.32;
const PIN_OUT = 0.3;

type FilmModel = Edit;

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
    opacity: number;
    now: number;
    subject?: { x: number; y: number; w: number; h: number };
  };
  /** The end card: 0 → 1 fade, and its own clock. */
  end?: { fade: number; t: number };
  /** The last look: only these boards stay; the rest fade by `p`. */
  only?: { ids: string[]; p: number };
}

/** The canvas at film time `f`: one settled state, a camera, and what's animating. */
function frameAt(e: Edit, f: number): Frame {
  const tl = e.timeline;
  const { index, phase } = shotAt(tl, f);
  const scene = e.scenes[index];
  if (!scene || phase === "result" || phase === "end") {
    const from = scene ? sceneCam(scene, scene.shot.end, e.view) : e.result.cam;
    const p = ease.inOut(clamp01((f - tl.result) / 1.0));
    const cam =
      from.page === e.result.cam.page ? flyTo(from, e.result.cam, p, e.view) : e.result.cam;
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
      threads: open(scene.before).filter(
        (t) => scene.shot.moment.kind !== "work" || t.artboardId === scene.board,
      ),
    };
  }
  if (scene.shot.moment.kind === "turn") return turnFrame(e, scene, f);
  return workFrame(e, scene, f);
}

/** Where a scene's camera is at time `f` (a turn's camera hops between its comments). */
function sceneCam(scene: Scene, f: number, view: { w: number; h: number }): Cam {
  const l = scene.shot.landings;
  if (!l?.length || scene.cams.length < 2) return scene.cams[0]!;
  // The camera only moves on a hop (a card on another board); pin-only landings keep it still.
  let i = 0;
  while (i + 1 < l.length && l[i + 1]!.at - 0.6 <= f) i++;
  const cur = scene.cams[i]!;
  const next = l[i + 1];
  if (next?.hop && f > next.at - 0.6) {
    const p = ease.inOut(clamp01((f - (next.at - 0.6)) / 0.55));
    return flyTo(cur, scene.cams[i + 1]!, p, view);
  }
  return cur;
}

const open = (doc: Doc) => doc.threads.filter((t) => t.status === "open");

function workFrame(e: Edit, scene: Scene, f: number): Frame {
  const s = scene.shot;
  const cam = scene.cams[0]!;
  const changing = f >= s.change;
  const doc = changing ? scene.after : scene.before;
  const heights = changing ? scene.heights.after : scene.heights.before;
  const out: Frame = {
    doc,
    heights,
    cam,
    // On a fix, only the pins it answers: other boards' pins wait their turn off this shot.
    threads: open(doc).filter((t) => t.artboardId === scene.board),
    ...(scene.board && f < s.changed + 0.35
      ? { working: { board: scene.board, who: scene.who ?? { name: "Agent" } } }
      : {}),
  };
  // The pins this work answers stay up until it lands, then leave.
  if (changing) {
    // Resolved: the pins it answers leave as soon as the change lands, so the result reads clean.
    out.threads = out.threads.filter((t) => !(scene.resolves ?? []).includes(t.id));
    const leaving = (scene.resolves ?? [])
      .map((id) => scene.before.threads.find((t) => t.id === id))
      .filter((t): t is Thread => Boolean(t));
    // Resolved: a check for a beat, then it leaves.
    // Off before the result holds, so the check never sits over the corrected piece.
    const p = clamp01((f - s.change - 0.3) / PIN_OUT);
    if (p < 1) out.pinsOut = leaving.map((thread) => ({ thread, p: ease.in(p) }));
  }
  // The last fix: once it's landed, the boards around it fade, so the result stands alone.
  if (scene === e.scenes.at(-1) && scene.board && e.result.boards.includes(scene.board))
    out.only = {
      ids: e.result.boards,
      p: progress(f, s.changed - 0.2, s.changed + 0.5, ease.inOut),
    };
  if (changing && scene.born)
    out.drawing = { board: scene.board!, p: ease.out(clamp01((f - s.change) / 0.5)) };
  if (changing && scene.rise?.length) {
    const span = Math.max(0, s.changed - s.change - STREAM_MS / 1000);
    const step = scene.rise.length > 1 ? Math.min(0.09, span / (scene.rise.length - 1)) : 0;
    out.rising = {
      ids: scene.rise,
      at: scene.rise.map((_, i) => (f - s.change - i * step) * 1000),
    };
  }
  return out;
}

function turnFrame(e: Edit, scene: Scene, f: number): Frame {
  const s = scene.shot;
  const l = s.landings ?? [];
  let k = -1;
  for (let i = 0; i < l.length; i++) if (l[i]!.at <= f) k = i;
  const threads =
    k >= 0 ? scene.threads![k]!.filter((t) => t.status === "open") : open(scene.before);
  const cam = sceneCam(scene, f, e.view);
  const out: Frame = { doc: scene.before, heights: scene.heights.before, cam, threads };
  if (k >= 0) {
    const cur = l[k]!;
    out.pinIn = { thread: cur.comment.thread, p: clamp01((f - cur.at) / PIN_IN) };
    if (cur.card) {
      // In once the pin has popped, out a beat before the next lands or the camera hops.
      const until = Math.min(
        cur.until,
        (l[k + 1]?.at ?? s.changed) - (l[k + 1]?.hop ? 0.62 : 0.08),
      );
      const opacity = Math.min(
        progress(f, cur.at + 0.12, cur.at + 0.26, ease.out),
        1 - progress(f, until - 0.16, until, ease.in),
      );
      const t = threads.find((x) => x.id === cur.comment.thread);
      if (t && opacity > 0.001)
        out.card = { thread: t, opacity, now: cur.comment.t + 1000, subject: scene.subjects?.[k] };
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
            return (
              <div
                key={ab.id}
                className="pz-film-board pz:absolute pz:shadow-board"
                style={{
                  display: offscreen ? "none" : undefined,
                  opacity: fr.only && !fr.only.ids.includes(ab.id) ? 1 - fr.only.p : undefined,
                  left: 0,
                  top: 0,
                  transform: `translate(${ab.x * cam.zoom + tx}px, ${ab.y * cam.zoom + ty}px) scale(${cam.zoom})`,
                  transformOrigin: "0 0",
                  width: w,
                  height: h ?? undefined,
                  // A new board is drawn in from the top, solid: a dark one never passes through grey.
                  clipPath:
                    drawing < 1 ? `inset(-40px -40px ${(1 - drawing) * 100}% -40px)` : undefined,
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
                  {who && (
                    <WorkingStatus
                      who={[{ id: who.name, name: who.name, client: who.client }]}
                      zoom={cam.zoom}
                    />
                  )}
                </div>
                <FilmBoard artboard={ab} doc={doc} model={model} />
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
                  <Trace x={p.x} y={p.y} w={w} h={h * cam.zoom} />
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
                      <span className="pz:min-w-0 pz:truncate pz-shimmer">{ab.name}</span>
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
              scale: 1 - 0.7 * p,
              opacity: 1 - p,
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
            const sp = toScreen(spot.x, spot.y);
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
                    className="pz-film-card"
                    style={{
                      opacity: card.opacity,
                      // Read on a phone: the real card, a little larger than in the studio.
                      zoom: view.w > view.h ? 1.5 : 1.22,
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
        <Wayfinding model={model} doc={doc} pageId={cam.page} />
      </div>
      {fr.end && (
        <EndCard model={model} t={Math.max(0, fr.end.t)} opacity={ease.out(fr.end.fade)} />
      )}
    </div>
  );
}

/** One artboard, drawn the way the canvas draws it. Replaces its markup only when it changed. */
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

/** New pieces rise 6px and fade in, staggered, over 500ms; driven from film time. */
const rising = new Set<Element>();
const anims = new WeakMap<Element, Animation>();

function applyRise(root: HTMLElement, r: Frame["rising"]) {
  const live = new Set<Element>();
  if (r)
    r.ids.forEach((id, n) => {
      const local = r.at[n]!;
      if (local >= STREAM_MS) return;
      for (const host of root.querySelectorAll("[data-artboard-host]")) {
        const el = host.shadowRoot?.querySelector(`[data-id="${CSS.escape(id)}"]`);
        if (!el || live.has(el)) continue;
        live.add(el);
        let a = anims.get(el);
        if (!a) {
          // From hidden, at offset 0: a lone keyframe defaults to the end, which would fade it out.
          a = el.animate([{ opacity: 0, translate: `0 ${STREAM_RISE}px`, offset: 0 }], {
            duration: STREAM_MS,
            easing: "cubic-bezier(.2,.8,.2,1)",
            fill: "both",
          });
          a.pause();
          anims.set(el, a);
          rising.add(el);
        }
        a.currentTime = Math.max(0, local);
      }
    });
  for (const el of rising) {
    if (live.has(el)) continue;
    anims.get(el)?.cancel();
    anims.delete(el);
    rising.delete(el);
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
      return (
        pinHit * 10 +
        (onCorner ? 6 : 0) +
        cover * 8 +
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
