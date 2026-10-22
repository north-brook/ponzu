import {
  type Artboard,
  type Beat,
  type Cam,
  changedNodes,
  type Doc,
  type FilmShape,
  type Focus,
  filmViewport,
  findArtboard,
  findNode,
  framingFor,
  isThemed,
  type JournalEntry,
  type PageState,
  type Plan,
  planFilm,
  planShots,
  type Range,
  type Rect,
  replayTo,
  type Shot,
  streamUnits,
  type Thread,
  threadPage,
  tryApply,
} from "@ponzu/core";
import { artboardMarkup, artboardSize, loadArtboardFonts } from "@ponzu/react";

/**
 * Everything a film needs, worked out once before the first frame: the doc
 * after each beat, where each change sits on the canvas, and the camera's
 * shots. Frames are then pure functions of film time.
 */
export interface FilmModel {
  name: string;
  shape: FilmShape;
  view: { w: number; h: number; scale: number };
  theme: "light" | "dark";
  plan: Plan;
  /** The opening doc, then the doc after each beat. docs[i + 1] is after beat i. */
  docs: Doc[];
  /** Per beat: the pieces that stream in, in order. */
  units: string[][];
  /** Per beat: boards whose look changed in place (crossfaded). */
  touched: string[][];
  /** Board heights by beat index + 1 (as docs), for fit-content boards. */
  heights: Map<string, number>[];
  shots: Shot[];
  /** The page shown before any shot. */
  firstPage: string;
  assetBase?: string;
  /** Real time span of the film, for a track. */
  range: Range | null;
  /** The real times of user comments in the range. */
  ticks: number[];
  /** Film time each board created during the film arrives. */
  born: Map<string, number>;
  /** Film time each comment's pin lands. */
  pinBorn: Map<string, number>;
  /** When an agent shows as working on a board, in film time. */
  working: { board: string; from: number; to: number; who: { name: string; client?: string } }[];
}

export interface FilmInput {
  name: string;
  entries: JournalEntry[];
  shape: FilmShape;
  length: number;
  range?: Range;
  theme: "light" | "dark";
  assetBase?: string;
}

/** Replays a journal into per-beat docs. Each doc shares nothing with the others. */
export function replayBeats(entries: JournalEntry[], plan: Plan): Doc[] {
  const start = replayTo(entries, plan.base) ?? {
    name: "",
    pages: [],
    tokens: "",
    threads: [],
    notes: {},
  };
  // Opening doc: before the first beat's own op.
  const docs: Doc[] = [structuredClone(start)];
  const doc = structuredClone(start);
  let at = plan.base;
  for (const b of plan.beats) {
    for (let i = at + 1; i <= b.entry; i++) {
      const e = entries[i]!;
      if (e.kind === "op") tryApply(doc, e.op);
      else {
        // A checkpoint mid-range: take it as it is.
        const fresh = structuredClone(e.doc);
        Object.assign(doc, fresh);
      }
    }
    at = b.entry;
    docs.push(structuredClone(doc));
  }
  return docs;
}

/* ------------------------------------------------------------------ */
/* Measuring                                                           */
/* ------------------------------------------------------------------ */

/**
 * Lays boards out offscreen exactly as the film draws them, to find their
 * heights and where nodes sit. One host per board, reused across beats.
 */
class Measurer {
  private root: HTMLDivElement;
  private hosts = new Map<string, { wrap: HTMLDivElement; shadow: ShadowRoot; html: string }>();

  constructor(
    private assetBase: string | undefined,
    private theme: "light" | "dark",
  ) {
    this.root = document.createElement("div");
    this.root.style.cssText =
      "position:fixed;left:0;top:0;width:0;height:0;overflow:visible;visibility:hidden;pointer-events:none;contain:layout";
    document.body.appendChild(this.root);
  }

  async show(doc: Doc, ab: Artboard): Promise<{ wrap: HTMLDivElement; shadow: ShadowRoot }> {
    let h = this.hosts.get(ab.id);
    if (!h) {
      const wrap = document.createElement("div");
      wrap.style.cssText = "position:absolute;left:0;top:0";
      const host = document.createElement("div");
      host.style.display = "contents";
      wrap.appendChild(host);
      this.root.appendChild(wrap);
      h = { wrap, shadow: host.attachShadow({ mode: "open" }), html: "" };
      this.hosts.set(ab.id, h);
    }
    const { w, h: fixed } = artboardSize(ab);
    h.wrap.style.width = `${w}px`;
    h.wrap.style.height = fixed ? `${fixed}px` : "";
    const { html, fonts } = artboardMarkup(
      ab,
      doc.tokens,
      this.assetBase,
      schemeFor(doc, ab, this.theme),
    );
    if (html !== h.html) {
      h.html = html;
      loadArtboardFonts(fonts);
      h.shadow.innerHTML = html;
      await settleAssets(h.shadow);
    }
    return h;
  }

  height(wrap: HTMLDivElement): number {
    return wrap.getBoundingClientRect().height;
  }

  /** A node's box in its board's pixels. */
  box(h: { wrap: HTMLDivElement; shadow: ShadowRoot }, id: string): Rect | null {
    const el = h.shadow.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!el) return null;
    const b = h.wrap.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    return { x: r.left - b.left, y: r.top - b.top, w: r.width, h: r.height };
  }

  dispose() {
    this.root.remove();
  }
}

/** Light or dark for a board's own light-dark() colours: the canvas's theme when it's themed, as the canvas does. */
export function schemeFor(doc: Doc, ab: Artboard, theme: "light" | "dark"): "light" | "dark" {
  return isThemed(doc.tokens, ab.root) ? theme : "light";
}

/** Fonts and images in a shadow root, with a time limit. */
export async function settleAssets(root: ShadowRoot | Document, ms = 4000): Promise<void> {
  const imgs = [...root.querySelectorAll("img")].filter((i) => !i.complete);
  const all = Promise.all([
    document.fonts.ready,
    ...imgs.map(
      (img) =>
        new Promise<void>((r) => {
          img.addEventListener("load", () => r(), { once: true });
          img.addEventListener("error", () => r(), { once: true });
        }),
    ),
  ]);
  await Promise.race([all, new Promise((r) => setTimeout(r, ms))]);
}

function union(rects: Rect[]): Rect | undefined {
  if (!rects.length) return undefined;
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w));
  const y1 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function pageOfBoard(doc: Doc, id: string): PageState | undefined {
  return findArtboard(doc, id)?.page;
}

/** Where a pin sits on the canvas. */
export function pinSpot(doc: Doc, t: Thread): { page: string; x: number; y: number } | null {
  const page = threadPage(doc, t);
  if (!page) return null;
  const ab = t.artboardId ? findArtboard(doc, t.artboardId)?.artboard : undefined;
  return { page: page.id, x: (ab?.x ?? 0) + t.x, y: (ab?.y ?? 0) + t.y };
}

/* ------------------------------------------------------------------ */
/* Building the model                                                  */
/* ------------------------------------------------------------------ */

export async function buildFilm(input: FilmInput): Promise<FilmModel> {
  const plan = planFilm(input.entries, { length: input.length, range: input.range });
  const docs = replayBeats(input.entries, plan);
  const view = filmViewport(input.shape);
  const framing = framingFor(input.shape);
  const measurer = new Measurer(input.assetBase, input.theme);

  // Heights of every board in the opening doc; then each beat updates the boards it changed.
  const heights: Map<string, number>[] = [];
  const first = new Map<string, number>();
  for (const page of docs[0]!.pages)
    for (const ab of page.artboards) {
      const fixed = artboardSize(ab).h;
      if (fixed) first.set(ab.id, fixed);
      else first.set(ab.id, measurer.height((await measurer.show(docs[0]!, ab)).wrap));
    }
  heights.push(first);

  const units: string[][] = [];
  const touched: string[][] = [];
  const focus: (Focus | null)[] = [];
  const userTurn: { current: { turn: number; rect: Rect; page: string } | null } = {
    current: null,
  };

  for (let i = 0; i < plan.beats.length; i++) {
    const beat = plan.beats[i]!;
    const doc = docs[i + 1]!;
    const prev = docs[i]!;
    const h = new Map(heights[i]!);
    const entry = input.entries[beat.entry]!;
    const op = entry.kind === "op" ? entry.op : null;
    const changed = op ? changedNodes(op) : { fresh: [], touched: [] };
    const beatUnits: string[] = [];
    const beatTouched = new Set<string>();
    const details: Rect[] = [];
    let focusBoard: Artboard | undefined;

    for (const id of beat.artboards) {
      const hit = findArtboard(doc, id);
      if (!hit) continue;
      const ab = hit.artboard;
      focusBoard ??= ab;
      const fixed = artboardSize(ab).h;
      const shown = await measurer.show(doc, ab);
      h.set(id, fixed ?? measurer.height(shown.wrap));
      if (beat.kind !== "edit") continue;
      // What streams in: new subtrees in this board, opened into blocks.
      const fresh = changed.fresh.filter((n) => findNode(ab.root, n) && n !== ab.id);
      const pieces = streamUnits((n) => findNode(ab.root, n)?.node ?? null, fresh);
      beatUnits.push(...pieces);
      for (const n of pieces) {
        const r = measurer.box(shown, n);
        if (r) details.push({ x: ab.x + r.x, y: ab.y + r.y, w: r.w, h: r.h });
      }
      const wasThere = findArtboard(prev, id);
      for (const n of changed.touched) {
        if (!findNode(ab.root, n)) continue;
        if (wasThere) beatTouched.add(id);
        if (n === ab.id) continue;
        const r = measurer.box(shown, n);
        if (r) details.push({ x: ab.x + r.x, y: ab.y + r.y, w: r.w, h: r.h });
      }
    }
    heights.push(h);
    units.push(beatUnits);
    touched.push([...beatTouched]);

    const boardRect = (ab: Artboard): Rect => ({
      x: ab.x,
      y: ab.y,
      w: artboardSize(ab).w,
      h: h.get(ab.id) ?? artboardSize(ab).h ?? 900,
    });

    if (beat.kind === "comment" || beat.kind === "reply" || beat.kind === "resolve") {
      const t =
        doc.threads.find((x) => x.id === beat.thread) ??
        prev.threads.find((x) => x.id === beat.thread);
      const spot = t ? pinSpot(t.status === "resolved" ? prev : doc, t) : null;
      if (!t || !spot) {
        focus.push(null);
        continue;
      }
      const ab = t.artboardId ? findArtboard(doc, t.artboardId)?.artboard : undefined;
      // The pin and the card beside it, in canvas units at about the board's zoom.
      const pinRect: Rect = { x: spot.x - 20, y: spot.y - 20, w: 200, h: 120 };
      let board: Rect = ab ? boardRect(ab) : pinRect;
      if (beat.kind === "comment") {
        // A run of your comments frames the boards they're on together, so pins land without hops.
        const run = userTurn.current;
        if (run && run.turn === beat.turn && run.page === spot.page)
          board = union([run.rect, board])!;
        userTurn.current = { turn: beat.turn, rect: board, page: spot.page };
      }
      focus.push({ page: spot.page, board, detail: pinRect, key: ab?.id ?? t.id });
      continue;
    }
    if (!focusBoard) {
      focus.push(null);
      continue;
    }
    const page = pageOfBoard(doc, focusBoard.id)!;
    focus.push({
      page: page.id,
      board: boardRect(focusBoard),
      detail: union(details),
      key: focusBoard.id,
    });
  }

  // The pull-back: every board on the page where the film ends, as it ends.
  const last = docs[docs.length - 1]!;
  const lastFocus = [...focus].reverse().find(Boolean);
  const endPage =
    last.pages.find((p) => p.id === lastFocus?.page) ?? last.pages.find((p) => p.artboards.length);
  const finalHeights = heights[heights.length - 1]!;
  const final: Focus | null = endPage
    ? (() => {
        const rects = endPage.artboards.map((ab) => ({
          x: ab.x,
          y: ab.y,
          w: artboardSize(ab).w,
          h: finalHeights.get(ab.id) ?? artboardSize(ab).h ?? 900,
        }));
        const board = union(rects);
        return board ? { page: endPage.id, board, overview: true } : null;
      })()
    : null;
  // Before the first focus, the camera opens on the first one's page.
  const firstFocus = focus.find(Boolean);
  const shots = planShots(plan, focus, view, framing, final);
  measurer.dispose();

  // Boards made during the film, and pins, arrive with their beat.
  const born = new Map<string, number>();
  const pinBorn = new Map<string, number>();
  const opening = new Set(docs[0]!.pages.flatMap((p) => p.artboards.map((a) => a.id)));
  plan.beats.forEach((b, i) => {
    for (const id of b.artboards)
      if (!opening.has(id) && !born.has(id) && findArtboard(docs[i + 1]!, id)) born.set(id, b.at);
    if (b.kind === "comment" && b.thread && !pinBorn.has(b.thread)) pinBorn.set(b.thread, b.at);
  });

  // The agent works on a board from a little before its first edit there to a little after its
  // last in the run, as the canvas shows it: the trace and status stay while it keeps going.
  const working: FilmModel["working"] = [];
  const open = new Map<string, FilmModel["working"][number]>();
  for (const turn of plan.turns) {
    if (turn.kind !== "agent") continue;
    open.clear();
    for (const b of plan.beats) {
      if (b.start < turn.start - 1e-9 || b.end > turn.end + 1e-9) continue;
      if (b.kind !== "edit" || b.who.kind !== "agent") continue;
      for (const id of b.artboards) {
        const cur = open.get(id);
        if (cur && b.start - cur.to < 2.5) cur.to = b.end;
        else {
          const w = {
            board: id,
            from: Math.max(turn.start, b.start - 0.25),
            to: b.end,
            who: { name: b.who.name, client: b.who.client },
          };
          open.set(id, w);
          working.push(w);
        }
      }
    }
  }
  // The agent stops working (trace off) a beat after its last change, before the pull-back.
  for (const w of working) w.to = Math.min(w.to + 0.6, plan.pullback);

  const range = plan.beats.length
    ? { from: plan.beats[0]!.t, to: plan.beats[plan.beats.length - 1]!.t }
    : null;
  return {
    name: input.name,
    shape: input.shape,
    view,
    theme: input.theme,
    plan,
    docs,
    units,
    touched,
    heights,
    shots,
    firstPage: firstFocus?.page ?? endPage?.id ?? docs[0]!.pages[0]?.id ?? "",
    assetBase: input.assetBase,
    range,
    ticks: plan.beats.filter((b) => b.kind === "comment").map((b) => b.t),
    born,
    pinBorn,
    working,
  };
}

/** A camera that shows the whole page when there's nothing to follow. */
export function fallbackCam(model: FilmModel, doc: Doc): Cam {
  const page = doc.pages.find((p) => p.id === model.firstPage) ?? doc.pages[0];
  const boards = page?.artboards ?? [];
  if (!boards.length) return { page: page?.id ?? "", cx: 0, cy: 0, zoom: 1 };
  const rects = boards.map((ab) => ({
    x: ab.x,
    y: ab.y,
    w: artboardSize(ab).w,
    h: artboardSize(ab).h ?? 900,
  }));
  const u = union(rects)!;
  const zoom = Math.min(1, (model.view.w - 96) / u.w, (model.view.h - 96) / u.h);
  return { page: page!.id, cx: u.x + u.w / 2, cy: u.y + u.h / 2, zoom };
}

export type { Beat };
