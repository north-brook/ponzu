import {
  type Artboard,
  type Beat,
  type Cam,
  type CamPath,
  cameraPath,
  camTargets,
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
  noteBoards,
  type PageState,
  type Plan,
  planFilm,
  type Range,
  type Rect,
  replayTo,
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
  /** Per beat: nodes changed in place, which settle (a small ease back to size) as they change. */
  settles: string[][];
  /**
   * Per beat: what to show of the old look while the new one arrives. A board
   * restyled in place swaps with a quick dip; replaced parts hold their old
   * picture (a snapshot of that box) until the new pieces rise over it.
   */
  touched: Swap[][];
  /** Board heights by beat index + 1 (as docs), for fit-content boards. */
  heights: Map<string, number>[];
  camera: CamPath;
  /** The page shown before any shot. */
  firstPage: string;
  assetBase?: string;
  /** Real time span of the film, for a track. */
  range: Range | null;
  /** The real times of user comments in the range. */
  ticks: number[];
  /** Film time each board created during the film arrives. */
  born: Map<string, number>;
  /** Boards already there when the film opens. */
  opening: Set<string>;
  /** Film time each comment's pin lands. */
  pinBorn: Map<string, number>;
  /** When an agent shows as working on a board, in film time. */
  working: { board: string; from: number; to: number; who: { name: string; client?: string } }[];
}

export interface Swap {
  board: string;
  /** The part of the board that changes, in board px; absent for the whole board. */
  box?: Rect;
  /** How long the old picture holds before it gives way, seconds. */
  hold: number;
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

  /** Every line of text on a board, in its pixels: elements with text of their own. */
  texts(h: { wrap: HTMLDivElement; shadow: ShadowRoot }): Rect[] {
    const b = h.wrap.getBoundingClientRect();
    const out: Rect[] = [];
    const walker = document.createTreeWalker(h.shadow, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent?.trim()) continue;
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) {
        if (r.width < 2 || r.height < 2) continue;
        out.push({ x: r.left - b.left, y: r.top - b.top, w: r.width, h: r.height });
      }
      if (out.length > 600) break;
    }
    return out;
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
  const settles: string[][] = [];
  const touched: Swap[][] = [];
  const focus: (Focus | null)[] = [];

  for (let i = 0; i < plan.beats.length; i++) {
    const beat = plan.beats[i]!;
    const doc = docs[i + 1]!;
    const prev = docs[i]!;
    const h = new Map(heights[i]!);
    const entry = input.entries[beat.entry]!;
    const op = entry.kind === "op" ? entry.op : null;
    const changed = op ? changedNodes(op) : { fresh: [], restyled: [], replaced: [] };
    // A token change restyles every board on its page that uses it: crossfade them all.
    const tokensChanged =
      op && (op.op === "tokens" || (op.op === "batch" && op.ops.some((o) => o.op === "tokens")));
    const beatUnits: string[] = [];
    const beatSettles: string[] = [];
    const beatTouched = new Map<string, Swap>();
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
      const before = findArtboard(prev, id);
      for (const n of changed.restyled) {
        if (!findNode(ab.root, n)) continue;
        if (before) beatTouched.set(id, { board: id, hold: 0 });
        if (n === ab.id) continue;
        beatSettles.push(n);
        const r = measurer.box(shown, n);
        if (r) details.push({ x: ab.x + r.x, y: ab.y + r.y, w: r.w, h: r.h });
      }
      // Replaced contents: the old picture of that box stays until the new pieces rise.
      if (before && !beatTouched.has(id)) {
        const shownBefore = await measurer.show(prev, before.artboard);
        const boxes = changed.replaced
          .map((n) => (findNode(before.artboard.root, n) ? measurer.box(shownBefore, n) : null))
          .filter((r): r is Rect => Boolean(r));
        const box = union(boxes);
        // Back to the board as it is now, for measuring what's new.
        await measurer.show(doc, ab);
        if (box) {
          // What lands where something was replaced doesn't fade up from nothing (that's a hole):
          // it cuts in over the old picture and settles.
          const overlaps = (r: Rect) =>
            r.x < box.x + box.w && r.x + r.w > box.x && r.y < box.y + box.h && r.y + r.h > box.y;
          for (let u = beatUnits.length - 1; u >= 0; u--) {
            const r = measurer.box(shown, beatUnits[u]!);
            if (r && overlaps(r)) {
              beatSettles.push(beatUnits[u]!);
              beatUnits.splice(u, 1);
            }
          }
          // Taken away with nothing in its place yet (an agent removes, then writes the new
          // version next): the old picture holds until that next change to the board lands.
          let hold = 0.12;
          if (!beatUnits.length) {
            const next = plan.beats.slice(i + 1).find((x) => x.artboards.includes(id));
            if (next && next.at - beat.at < 4) hold = next.at - beat.at + 0.05;
          }
          beatTouched.set(id, { board: id, box, hold });
          details.push({ x: ab.x + box.x, y: ab.y + box.y, w: box.w, h: box.h });
        }
        await measurer.show(doc, ab);
      }
    }
    if (tokensChanged)
      for (const p of doc.pages)
        for (const ab of p.artboards)
          if (findArtboard(prev, ab.id)) beatTouched.set(ab.id, { board: ab.id, hold: 0 });
    heights.push(h);
    units.push(beatUnits);
    settles.push(beatSettles);
    touched.push([...beatTouched.values()]);

    // The lines of text on the board this beat looks at, for framing that never cuts one.
    const textsOf = async (ab: Artboard): Promise<Rect[]> =>
      measurer
        .texts(await measurer.show(doc, ab))
        .map((r) => ({ x: ab.x + r.x, y: ab.y + r.y, w: r.w, h: r.h }));
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
      // What the comment is about: the node it's pinned to, else the area around the pin.
      let pinRect: Rect = { x: spot.x - 160, y: spot.y - 120, w: 320, h: 240 };
      if (ab && t.nodeId && findNode(ab.root, t.nodeId)) {
        const r = measurer.box(await measurer.show(doc, ab), t.nodeId);
        if (r && r.w * r.h > 0) {
          const node = { x: ab.x + r.x, y: ab.y + r.y, w: r.w, h: r.h };
          pinRect = union([node, { x: spot.x - 20, y: spot.y - 20, w: 40, h: 40 }])!;
        }
      }
      const pin = beat.kind === "resolve" ? undefined : { x: spot.x, y: spot.y };
      const board: Rect = ab ? boardRect(ab) : pinRect;
      if (beat.kind === "comment") {
        // Your turn opens on every board it comments on at once, when that's still
        // readable, so the pins land one after another without the camera hopping.
        const run = turnFrame(plan, i, docs, heights, beat.turn);
        if (run && run.page === spot.page) {
          // Only when the boards stay readable together; else each pin gets its board.
          const fit = Math.min(view.w / run.rect.w, view.h / run.rect.h);
          if (fit >= framing.minZoom) {
            focus.push({
              page: spot.page,
              board: run.rect,
              overview: true,
              key: `turn-${beat.turn}`,
            });
            // Its cards: keep them in the frame (the card slides in, see keepCardsInFrame).
            continue;
          }
        }
      }
      focus.push({
        page: spot.page,
        board,
        detail: pinRect,
        key: ab?.id ?? t.id,
        pin,
        texts: ab ? await textsOf(ab) : undefined,
      });
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
      parts: details,
      texts: await textsOf(focusBoard),
      key: focusBoard.id,
    });
  }

  // The pull-back: every board on the page where the film ends, as it ends.
  const last = docs[docs.length - 1]!;
  const lastFocus = [...focus].reverse().find(Boolean);
  const endPage =
    last.pages.find((p) => p.id === lastFocus?.page) ?? last.pages.find((p) => p.artboards.length);
  const finalHeights = heights[heights.length - 1]!;
  const rectOf = (ab: Artboard): Rect => ({
    x: ab.x,
    y: ab.y,
    w: artboardSize(ab).w,
    h: finalHeights.get(ab.id) ?? artboardSize(ab).h ?? 900,
  });
  const final: Focus | null = endPage
    ? (() => {
        // The result: every board but the agent's notes, when they read together. On a page
        // too big to read at once, the board the film spent longest on, whole.
        const notes = noteBoards(input.entries);
        const shown = endPage.artboards.filter((ab) => !notes.has(ab.id));
        const all = union((shown.length ? shown : endPage.artboards).map(rectOf));
        if (!all) return null;
        const fit = Math.min(
          (view.w - 2 * framing.pad) / all.w,
          (view.h - 2 * framing.pad - framing.top) / all.h,
        );
        const enough = view.h > view.w ? 1 : 0.55;
        if (fit >= framing.minZoom * enough)
          return { page: endPage.id, board: all, overview: true };
        // The board the session was about: where the person commented most, then where the
        // agent did most. The hero of a landing page, not its pricing table.
        const time = new Map<string, number>();
        const add = (id: string, v: number) => time.set(id, (time.get(id) ?? 0) + v);
        for (const b of plan.beats) {
          if (b.kind === "comment" && b.thread) {
            const th = last.threads.find((x) => x.id === b.thread);
            if (th?.artboardId) add(th.artboardId, 1e6);
          }
          if (b.kind !== "edit") continue;
          const e = input.entries[b.entry];
          const size = e?.kind === "op" ? JSON.stringify(e.op).length : 0;
          for (const id of b.artboards) add(id, size);
        }
        // Among the most commented, the one the film opened on wins a tie: it's the first impression.
        const first = plan.beats.find((b) => b.kind === "edit" && b.artboards[0])?.artboards[0];
        if (first) add(first, 5e5);
        const best = [...shown].sort((a, b) => (time.get(b.id) ?? 0) - (time.get(a.id) ?? 0))[0];
        return best ? { page: endPage.id, board: rectOf(best), overview: true } : null;
      })()
    : null;
  // Before the first focus, the camera opens on the first one's page.
  const firstFocus = focus.find(Boolean);
  const camera = cameraPath(camTargets(plan, focus, view, framing, final), view);
  measurer.dispose();

  // Boards made during the film, and pins, arrive with their beat.
  const born = new Map<string, number>();
  const pinBorn = new Map<string, number>();
  const opening = new Set(docs[0]!.pages.flatMap((p) => p.artboards.map((a) => a.id)));
  plan.beats.forEach((b, i) => {
    // A new board shows once it has something on it: never as an empty slab.
    for (const id of b.artboards) {
      if (opening.has(id) || born.has(id)) continue;
      // Something worth seeing: a few blocks (a status bar and a header are not).
      const ab = findArtboard(docs[i + 1]!, id)?.artboard;
      const blocks = ab?.root.children.filter((c) => c.kind === "el").length ?? 0;
      if (blocks >= 2) born.set(id, b.at);
    }
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
    settles,
    touched,
    heights,
    camera,
    firstPage: firstFocus?.page ?? endPage?.id ?? docs[0]!.pages[0]?.id ?? "",
    assetBase: input.assetBase,
    range,
    ticks: plan.beats.filter((b) => b.kind === "comment").map((b) => b.t),
    born,
    opening,
    pinBorn,
    working,
  };
}

/**
 * The boards a run of your comments is on, as one rect, from the doc as the
 * run ends (so later pins' boards are in it from the first). Null when they're
 * on different pages.
 */
function turnFrame(
  plan: Plan,
  i: number,
  docs: Doc[],
  heights: Map<string, number>[],
  turn: number,
): { page: string; rect: Rect } | null {
  let last = i;
  while (plan.beats[last + 1]?.turn === turn) last++;
  // The whole turn, from its first comment, so every pin in it gets the same frame.
  while (i > 0 && plan.beats[i - 1]?.turn === turn) i--;
  const doc = docs[last + 1]!;
  const h = heights[i] ?? new Map<string, number>();
  const rects: Rect[] = [];
  let page: string | null = null;
  for (let j = i; j <= last; j++) {
    const b = plan.beats[j]!;
    const t = doc.threads.find((x) => x.id === b.thread);
    const ab = t?.artboardId ? findArtboard(doc, t.artboardId) : null;
    if (!ab) continue;
    if (page && page !== ab.page.id) return null;
    page = ab.page.id;
    rects.push({
      x: ab.artboard.x,
      y: ab.artboard.y,
      w: artboardSize(ab.artboard).w,
      h: h.get(ab.artboard.id) ?? artboardSize(ab.artboard).h ?? 900,
    });
  }
  const rect = union(rects);
  return page && rect ? { page, rect } : null;
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
