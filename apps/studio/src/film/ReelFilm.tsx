import { bezier, clamp01, type Doc, ease, findArtboard, progress } from "@ponzu/core";
import {
  ARRIVE_EASING,
  ARRIVE_LAG_MS,
  ARRIVE_MS,
  artboardSize,
  Trace,
  WorkingStatus,
} from "@ponzu/react";
import { useLayoutEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { applyRise, EndCard, FilmBoard, Prompt, promptState, Wayfinding } from "./Film.tsx";
import type { Reel } from "./reel.ts";

/** A revision: the old pieces fade off, then the new arrive, then a beat. In seconds. */
const OUT = 0.16;

const arriveEase = (() => {
  const m = ARRIVE_EASING.match(/[\d.]+/g)!.map(Number) as [number, number, number, number];
  return bezier(...m);
})();
/** How far a sheet's sweep has got, `ms` after its first piece's write. */
const sweep = (ms: number) => arriveEase(clamp01((ms - ARRIVE_LAG_MS) / ARRIVE_MS));

interface ReelFrame {
  doc: Doc;
  rising: { ids: string[]; at: number[] };
  /** The canvas before a revision, showing only what it takes away, fading by `p`. */
  ghost?: { doc: Doc; only: string[]; p: number };
  /** Pieces of the live board held back until the old have gone. */
  hidden: string[];
  working: boolean;
}

function frameAt(r: Reel, f: number): ReelFrame {
  const { times } = r;
  if (f < times.revise || !r.revisions.length) {
    // The build: the canvas after the last write that's landed, its pieces arriving on their beat.
    let k = -1;
    while (k + 1 < r.steps.length && r.steps[k + 1]!.at <= f) k++;
    const doc =
      k >= 0
        ? r.steps[k]!.doc
        : { ...r.result, pages: r.result.pages.map((p) => ({ ...p, artboards: [] })) };
    const ids: string[] = [];
    const at: number[] = [];
    for (const p of r.pieces) {
      if (p.at > f + 0.001 && k >= 0 && r.steps[k]!.at < p.at) {
        // Written, but its turn in the write hasn't come: held at the start (hidden).
        ids.push(p.id);
        at.push((f - p.at) * 1000);
      } else if (p.at <= f) {
        ids.push(p.id);
        at.push((f - p.at) * 1000);
      }
    }
    const done = k === r.steps.length - 1 && f > (r.pieces.at(-1)?.at ?? 0) + ARRIVE_MS / 1000;
    return { doc, rising: { ids, at }, hidden: [], working: !done && f >= times.build };
  }
  // Revisions: the one landing now.
  let i = 0;
  while (i + 1 < r.revisions.length && r.revisions[i + 1]!.at <= f) i++;
  const rev = r.revisions[i]!;
  const t = f - rev.at;
  const out = progress(t, 0, OUT, ease.in);
  const frame: ReelFrame = {
    doc: rev.after,
    rising: {
      ids: rev.fresh,
      at: rev.fresh.map((_, j) => (t - OUT * 0.6 - Math.min(j, 8) * 0.045) * 1000),
    },
    hidden: [],
    working: f < times.result,
  };
  // The old pieces fade off where they were, over the new look; the new wait their turn (held at
  // the start of their arrival, unseen) until the old have gone.
  if (out < 1) frame.ghost = { doc: rev.before, only: rev.gone, p: out };
  return frame;
}

/** A reel's frame at film time `f`. */
export function ReelFilm({ model: r, f }: { model: Reel; f: number }) {
  const { view, cam, times } = r;
  const root = useRef<HTMLDivElement>(null);
  const prompting = r.prompt && f < times.build;
  const fr = frameAt(r, Math.max(f, times.build));
  const page = fr.doc.pages.find((p) => p.id === cam.page) ?? fr.doc.pages[0];
  // At rest, a slow lean in over the whole film, so it's never a still.
  const zoom = cam.zoom * (1 + 0.04 * progress(f, times.build, times.endCard, ease.inOut));
  const tx = view.w / 2 - cam.cx * zoom;
  const ty = view.h / 2 - cam.cy * zoom;

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    applyRise(el, fr.rising);
    for (const host of el.querySelectorAll(".pz-reel-live [data-artboard-host]"))
      for (const n of host.shadowRoot?.querySelectorAll<HTMLElement>("[data-reel-hidden]") ?? [])
        if (!fr.hidden.includes(n.dataset.id ?? "")) {
          n.style.visibility = "";
          delete n.dataset.reelHidden;
        }
    for (const id of fr.hidden)
      for (const host of el.querySelectorAll(".pz-reel-live [data-artboard-host]")) {
        const n = host.shadowRoot?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
        if (n) {
          n.style.visibility = "hidden";
          n.dataset.reelHidden = "1";
        }
      }
  });

  const boards = (page?.artboards ?? []).filter((ab) => r.boards.includes(ab.id));
  const end = f >= times.endCard - 0.3;
  return (
    <div
      ref={root}
      className={cn("pz-root pz-film", `pz-${r.theme}`)}
      style={{ width: view.w, height: view.h }}
      data-film-frame={Math.round(f * 1000)}
    >
      <div className="pz:absolute pz:inset-0 pz:overflow-hidden">
        {!prompting &&
          boards.map((ab) => {
            const { w, h } = artboardSize(ab);
            const ghost = fr.ghost && findArtboard(fr.ghost.doc, ab.id)?.artboard;
            // The sheet is uncovered with its first piece, the same sweep: never seen bare.
            const sheet = sweep((f - (r.boardAt.get(ab.id) ?? 0)) * 1000);
            if (sheet <= 0) return null;
            return (
              <div
                key={ab.id}
                className="pz-film-board pz-reel-live pz:absolute pz:shadow-board"
                style={{
                  left: 0,
                  top: 0,
                  transform: `translate(${ab.x * zoom + tx}px, ${ab.y * zoom + ty}px) scale(${zoom})`,
                  transformOrigin: "0 0",
                  width: w,
                  height: h ?? undefined,
                  clipPath:
                    sheet < 1 ? `inset(-40px ${(1 - sheet) * 100}% -40px -40px)` : undefined,
                }}
              >
                <div
                  className="pz:absolute pz:left-0 pz:right-0 pz:flex pz:items-center pz:gap-[0.5em] pz:whitespace-nowrap pz:leading-[1.4] pz:text-muted-foreground"
                  style={{ fontSize: 12 / zoom, top: -22 / zoom }}
                >
                  <span
                    className={cn(
                      "pz:min-w-0 pz:truncate",
                      fr.working && "pz-shimmer pz:text-foreground",
                    )}
                  >
                    {ab.name}
                  </span>
                  {fr.working && ab.id === r.boards[0] && r.prompt && (
                    <WorkingStatus
                      who={[
                        {
                          id: r.prompt.who.name,
                          name: r.prompt.who.name,
                          client: r.prompt.who.client,
                        },
                      ]}
                      zoom={zoom}
                    />
                  )}
                </div>
                <FilmBoard artboard={ab} doc={fr.doc} model={r} />
                {ghost && fr.ghost && (
                  <div
                    style={{
                      position: "absolute",
                      left: 0,
                      top: 0,
                      width: w,
                      opacity: 1 - fr.ghost.p,
                    }}
                  >
                    <FilmBoard artboard={ghost} doc={fr.ghost.doc} model={r} only={fr.ghost.only} />
                  </div>
                )}
              </div>
            );
          })}
        {!prompting && fr.working && (
          <div className="pz:pointer-events-none pz:absolute pz:inset-0">
            {boards
              .filter((ab) => f >= (r.boardAt.get(ab.id) ?? 0) + ARRIVE_MS / 1000)
              .map((ab) => (
                <Trace
                  key={ab.id}
                  x={ab.x * zoom + tx}
                  y={ab.y * zoom + ty}
                  w={artboardSize(ab).w * zoom}
                  h={(r.heights.get(ab.id) ?? artboardSize(ab).h ?? 900) * zoom}
                />
              ))}
          </div>
        )}
        <Wayfinding model={r} doc={r.result} pageId={cam.page} />
      </div>
      {prompting && r.prompt && (
        <Prompt model={r} state={promptState({ start: 0, end: times.build }, f)} />
      )}
      {end && (
        <EndCard
          model={r}
          t={Math.max(0, f - times.endCard)}
          opacity={ease.out(clamp01((f - (times.endCard - 0.3)) / 0.3))}
        />
      )}
    </div>
  );
}
