import type { Artboard, Doc, Op, PElement, PNode } from "@ponzu/core";

/*
 * How work arrives on the canvas: the develop. A beat after a write lands, each new piece shows
 * its plan first, yuzu outlines tracing it and the first few boxes inside it while the piece
 * itself is still hidden; then it develops out of whatever it sits on, top first, as the outlines
 * fade. Nothing slides: the layout is where it will stay from the first frame. A new artboard
 * draws its frame before it fills in. An agent's writes arrive this way, and so do files saved
 * straight into the design, though only what's new in them. The person's own edits on the
 * canvas, undo and redo just appear. It never holds the agent up: it runs after a write has
 * landed, in the page only.
 */

/** One piece, from its first outline to fully developed. */
export const ARRIVE_MS = 1300;
/** The first beat: the outlines draw the piece's plan while the piece is hidden. */
export const ARRIVE_PLAN_MS = 600;
/** Each outline fades in over this long, holds a moment past the plan, then fades out. */
const OUTLINE_IN = 90;
const OUTLINE_HOLD = 180;
const OUTLINE_OUT = 260;
/** A piece and the first few boxes inside it, breadth first: enough to read as a plan. */
const OUTLINES = 6;
/** A touch deeper than the rind, so a 1.5px line still reads on white. */
export const ARRIVE_LINE = "#f2b100";
/** A beat between a write landing and its first piece showing: the reveal, not a wait. */
export const ARRIVE_LAG_MS = 90;
/** Between one piece and the next, in the order written. */
export const ARRIVE_STAGGER_MS = 55;
/** A long write still starts within about half a second: past this many pieces, the rest come together. */
export const ARRIVE_MAX_STAGGER = 10;
/** Past this many pieces in one write, crowded siblings arrive as the box that holds them. */
export const ARRIVE_MAX_PIECES = 24;
export const ARRIVE_EASING = "cubic-bezier(.3,.7,.25,1)";

/** How long a new artboard's frame takes to draw; its pieces start once it's drawn. */
export const BOARD_DRAW_MS = 650;
/** Once drawn, the line fades over this long as the ring takes over. */
const BOARD_HANDOFF_MS = 400;
/** The sheet develops out of the canvas inside the line, from and to these, after the draw starts. */
const SHEET_FROM = 380;
const SHEET_TO = 1000;
/** The board's name develops beside it, left to right. */
const NAME_FROM = 120;
const NAME_TO = 620;
/** From a board landing to its sheet settled. */
export const BOARD_MS = ARRIVE_LAG_MS + SHEET_TO;

/** The ring around a working board fades in and out over these. */
export const RING_IN_MS = 400;
export const RING_OUT_MS = 500;

/**
 * The develop: hidden until `plan` (a fraction of the way), then uncovered top first as it fades
 * in. The mask is three times the element's height, shown | a soft edge | hidden; sliding it from
 * 100% to 0% carries the edge down the element, and at 0% only the shown third covers it, so the
 * end is the element as drawn.
 */
function developKeyframes(plan: number): Keyframe[] {
  const mask = {
    maskImage: "linear-gradient(to bottom,#000 0 33%,transparent 66%)",
    maskSize: "100% 300%",
    maskRepeat: "no-repeat",
  };
  return [
    { ...mask, opacity: 0, maskPosition: "0 100%", offset: 0 },
    { ...mask, opacity: 0, maskPosition: "0 100%", offset: plan, easing: ARRIVE_EASING },
    { ...mask, opacity: 1, maskPosition: "0 0", offset: 1 },
  ];
}

/** A piece's own part of the develop: hidden through the plan, then uncovered. */
export const ARRIVE_KEYFRAMES = developKeyframes(ARRIVE_PLAN_MS / ARRIVE_MS);

/** A new artboard's sheet, over BOARD_MS from when it landed: it develops as its frame draws. */
export const SHEET_KEYFRAMES = developKeyframes((ARRIVE_LAG_MS + SHEET_FROM) / BOARD_MS);

/** The `i`th of `n` outlines: in on its turn through the plan, held just past it, then out. */
function outlineKeyframes(i: number, n: number): Keyframe[] {
  const end = ARRIVE_PLAN_MS + OUTLINE_HOLD + OUTLINE_OUT;
  const from = (i * ARRIVE_PLAN_MS) / n;
  return [
    { opacity: 0, offset: 0 },
    { opacity: 0, offset: from / end },
    { opacity: 1, offset: (from + OUTLINE_IN) / end },
    { opacity: 1, offset: (ARRIVE_PLAN_MS + OUTLINE_HOLD) / end },
    { opacity: 0, offset: 1 },
  ];
}

/** When a piece starts, after the write lands: the beat, then its place in the stagger. */
export function arriveDelay(index: number): number {
  return ARRIVE_LAG_MS + Math.min(index, ARRIVE_MAX_STAGGER) * ARRIVE_STAGGER_MS;
}

/**
 * The elements an op brings onto the canvas, outermost first and in document order: inserted
 * nodes, a whole new artboard's contents, children replaced wholesale. Restyles, moves and text
 * edits change what's there rather than adding to it, so they arrive by themselves.
 *
 * For a new artboard, the pieces are its top-level children, so a board fills in section by
 * section instead of fading as one sheet.
 *
 * With `known`, the ids already on the canvas, only what's new arrives: a file saved straight to
 * disk replaces a board's children wholesale, but the pieces it left alone keep their ids, so a
 * one-word fix doesn't replay the whole board. Known elements are looked inside instead.
 */
export function arrivals(op: Op, known?: (id: string) => boolean): string[] {
  switch (op.op) {
    case "insert":
      return elementIds(op.nodes, known);
    case "children":
      return elementIds(op.children, known);
    case "artboard.create":
      return elementIds(op.artboard.root.children, known);
    case "batch":
      return op.ops.flatMap((o) => arrivals(o, known));
    default:
      return [];
  }
}

function elementIds(nodes: PNode[], known?: (id: string) => boolean): string[] {
  return nodes.flatMap((n) => {
    if (n.kind !== "el") return [];
    return known?.(n.id) ? elementIds(n.children, known) : [n.id];
  });
}

/** Every element id in a doc, artboards included. */
export function idsIn(doc: Doc): Set<string> {
  const ids = new Set<string>();
  const visit = (el: PElement) => {
    ids.add(el.id);
    for (const c of el.children) if (c.kind === "el") visit(c);
  };
  for (const page of doc.pages) for (const ab of page.artboards) visit(ab.root);
  return ids;
}

/** Of these ids, the ones still in the doc and not inside another one being animated. */
export function outermost(doc: Doc, ids: string[]): string[] {
  const want = new Set(ids);
  const out: string[] = [];
  const visit = (nodes: PNode[], inside: boolean) => {
    for (const n of nodes) {
      if (n.kind !== "el") continue;
      const hit = want.has(n.id) && !inside;
      if (hit) out.push(n.id);
      visit(n.children, inside || hit);
    }
  };
  for (const page of doc.pages) for (const ab of page.artboards) visit(ab.root.children, false);
  // Keep the order written, which is the order they arrive in.
  const order = new Map(ids.map((id, i) => [id, i]));
  return out.sort((a, b) => order.get(a)! - order.get(b)!);
}

/**
 * The pieces these ids arrive as: the outermost of them, chunked so a write of thousands of small
 * things (an SVG's every line, a grid's every dot) develops as a few. Past ARRIVE_MAX_PIECES, each
 * box holding several of them arrives in their place, until they're few enough; when none share a
 * box, each moves up one. A board's own sections stay as they are.
 */
export function chunk(doc: Doc, ids: string[]): string[] {
  let out = outermost(doc, ids);
  if (out.length <= ARRIVE_MAX_PIECES) return out;
  const parent = new Map<string, string>();
  const visit = (el: PElement, board: boolean) => {
    for (const c of el.children) {
      if (c.kind !== "el") continue;
      if (!board) parent.set(c.id, el.id);
      visit(c, false);
    }
  };
  for (const page of doc.pages) for (const ab of page.artboards) visit(ab.root, true);
  while (out.length > ARRIVE_MAX_PIECES) {
    const count = new Map<string, number>();
    for (const id of out) {
      const p = parent.get(id);
      if (p) count.set(p, (count.get(p) ?? 0) + 1);
    }
    if (!count.size) break;
    const crowded = [...count.values()].some((n) => n > 1);
    const lift = (id: string) => {
      const p = parent.get(id);
      return p && (!crowded || count.get(p)! > 1) ? p : id;
    };
    // First mention keeps its place, so a box arrives where its first piece would have.
    out = outermost(doc, [...new Set(out.map(lift))]);
  }
  return out;
}

/** Whether the person has asked for less motion. */
export function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Where a board's outlines are drawn: over its sheet in the same shadow root, a sibling of the
 * design rather than part of it, so its styles and selectors never see it. `all:initial` keeps the
 * design's own rules (a `div {…}`, say) off it.
 */
export function arriveLayer(root: ShadowRoot): HTMLElement {
  const found = root.querySelector<HTMLElement>(":host > [data-pz-arrive]");
  if (found) return found;
  const layer = document.createElement("div");
  layer.dataset.pzArrive = "";
  layer.setAttribute("aria-hidden", "true");
  layer.style.cssText =
    "all:initial;position:absolute;inset:0;overflow:hidden;pointer-events:none;border-radius:var(--pz-board-radius,0)";
  root.append(layer);
  return layer;
}

/**
 * Develop one piece: it's hidden while yuzu outlines draw it and the first few boxes inside it,
 * then it's uncovered top first as they fade. The outlines go in `layer`, measured where the
 * pieces lie now; they're 1.5 screen px at any zoom. The animations run from now: set their
 * currentTime to put them where they should be.
 */
export function develop(el: Element, layer: HTMLElement): Animation[] {
  const animations = [el.animate(ARRIVE_KEYFRAMES, { duration: ARRIVE_MS, fill: "backwards" })];
  const origin = layer.getBoundingClientRect();
  const scale = layer.offsetWidth ? origin.width / layer.offsetWidth : 0;
  if (scale > 0) {
    const line = 1.5 / scale;
    // Measure every outline before adding any: each box added would make the next measure lay
    // the board out again.
    const lines = outlined(el).map((target) => ({
      r: target.getBoundingClientRect(),
      radius: getComputedStyle(target).borderRadius,
    }));
    lines.forEach(({ r, radius }, i) => {
      const box = document.createElement("div");
      box.style.cssText = [
        "all:initial;position:absolute;box-sizing:border-box;pointer-events:none;opacity:0",
        `left:${(r.left - origin.left) / scale - line}px;top:${(r.top - origin.top) / scale - line}px`,
        `width:${r.width / scale + 2 * line}px;height:${r.height / scale + 2 * line}px`,
        `border:${line}px solid ${ARRIVE_LINE};border-radius:${radius}`,
      ].join(";");
      layer.append(box);
      const a = box.animate(outlineKeyframes(i, lines.length), {
        duration: ARRIVE_PLAN_MS + OUTLINE_HOLD + OUTLINE_OUT,
        fill: "backwards",
      });
      // Played out, it's gone; cancelled by a re-render, it goes with the old shadow root.
      a.finished.then(
        () => box.remove(),
        () => {},
      );
      animations.push(a);
    });
  }
  return animations;
}

/** The piece and the first few boxes inside it worth outlining, breadth first. */
function outlined(el: Element): Element[] {
  const out = [el];
  const queue = [...el.children];
  while (queue.length && out.length < OUTLINES) {
    const c = queue.shift()!;
    const r = c.getBoundingClientRect();
    if (r.width >= 2 && r.height >= 2) out.push(c);
    // An SVG is one picture: its shapes aren't boxes in the plan.
    if (!(c instanceof SVGElement)) queue.push(...c.children);
  }
  return out;
}

/**
 * What's still arriving in one canvas. An artboard re-renders its whole shadow root on every
 * change, so a piece written a moment ago would snap to its end the instant the agent writes the
 * next one: each render replays what's in flight from where it had got to.
 */
export class Arrivals {
  /** Piece id → when its develop starts (performance.now()). */
  private pieces = new Map<string, number>();
  /** New artboards, when each landed, and whether its wrapper has started arriving. */
  private boards = new Map<string, { at: number; taken: boolean }>();

  /**
   * An op landed that should arrive: queue what it brought, after anything still arriving. With
   * `before`, the doc it was applied to, only elements new to the canvas arrive.
   */
  add(op: Op, doc: Doc, now = performance.now(), before?: Doc | null) {
    if (reducedMotion()) return;
    this.prune(now);
    for (const id of createdBoards(op)) this.boards.set(id, { at: now, taken: false });
    const known = before ? idsIn(before) : undefined;
    const ids = chunk(doc, arrivals(op, known && ((id) => known.has(id)))).filter(
      (id) => !this.pieces.has(id),
    );
    if (!ids.length) return;
    // A new board's pieces wait for its frame to draw, whether they came with it or a moment
    // after, in the agent's next write.
    let floor = now + ARRIVE_LAG_MS;
    for (const board of boardsHolding(doc, ids)) {
      const b = this.boards.get(board);
      if (b) floor = Math.max(floor, b.at + ARRIVE_LAG_MS + BOARD_DRAW_MS);
    }
    // The first piece shows a beat after the write lands, or one stagger after whatever is still
    // arriving, whichever is later: the beat is a floor, never paid twice. Every piece starts
    // within ten staggers of that beat, so a long write still lands in about a second.
    let first = floor;
    for (const start of this.pieces.values()) first = Math.max(first, start + ARRIVE_STAGGER_MS);
    const latest = floor + ARRIVE_MAX_STAGGER * ARRIVE_STAGGER_MS;
    ids.forEach((id, i) => this.pieces.set(id, Math.min(latest, first + i * ARRIVE_STAGGER_MS)));
  }

  /**
   * Which of these artboards have pieces still arriving. A board drawn as a picture goes live for
   * them, so the slide plays on the board itself.
   */
  boardsArriving(artboards: Artboard[], now = performance.now()): Set<string> {
    this.prune(now);
    const out = new Set<string>();
    if (!this.pieces.size && !this.boards.size) return out;
    const want = new Set(this.pieces.keys());
    for (const ab of artboards)
      if (this.boards.has(ab.id) || holds(ab.root.children, want)) out.add(ab.id);
    return out;
  }

  /** How long until everything arriving now has landed, in ms: boards may be pictures again then. */
  until(now = performance.now()): number {
    let end = now;
    for (const start of this.pieces.values()) end = Math.max(end, start + ARRIVE_MS);
    for (const b of this.boards.values()) end = Math.max(end, b.at + BOARD_MS + 1000);
    // A beat after the last prune would drop them.
    return end - now + 50;
  }

  /** When this artboard landed, if it's new and its wrapper hasn't started arriving. Once. */
  takeBoard(id: string, now = performance.now()): number | undefined {
    this.prune(now);
    const b = this.boards.get(id);
    if (!b || b.taken) return undefined;
    b.taken = true;
    return b.at;
  }

  /** When this artboard landed, while it's still arriving: its frame draws from then. */
  boardAt(id: string, now = performance.now()): number | undefined {
    this.prune(now);
    return this.boards.get(id)?.at;
  }

  /** After an artboard re-renders: set its sheet and each piece in flight going from where it was. */
  replay(root: ShadowRoot, now = performance.now()) {
    if (reducedMotion()) {
      this.pieces.clear();
      return;
    }
    this.prune(now);
    const sheet = root.querySelector<HTMLElement>("[data-artboard]");
    if (!sheet) return;
    const board = this.boards.get((root.host as HTMLElement).dataset.artboardHost ?? "");
    if (board) {
      const a = sheet.animate(SHEET_KEYFRAMES, {
        duration: BOARD_MS,
        fill: "backwards",
      });
      a.currentTime = now - board.at;
    }
    let layer: HTMLElement | undefined;
    for (const [id, start] of this.pieces) {
      const el = root.querySelector(`[data-id="${CSS.escape(id)}"]`);
      if (!el) continue;
      layer ??= arriveLayer(root);
      // Negative while it waits its turn in the stagger: held at the start until then.
      for (const a of develop(el, layer)) a.currentTime = now - start;
    }
  }

  private prune(now: number) {
    for (const [id, start] of this.pieces) if (now - start > ARRIVE_MS) this.pieces.delete(id);
    // A board made on a page that isn't showing arrives as it is when that page opens later.
    for (const [id, b] of this.boards) if (now - b.at > BOARD_MS + 1000) this.boards.delete(id);
  }
}

/** The artboards holding any of these ids. */
function boardsHolding(doc: Doc, ids: string[]): string[] {
  const want = new Set(ids);
  return doc.pages.flatMap((p) =>
    p.artboards.filter((ab) => holds(ab.root.children, want)).map((ab) => ab.id),
  );
}

/** Whether any of these nodes, or anything inside them, has one of these ids. */
function holds(nodes: PNode[], ids: Set<string>): boolean {
  return nodes.some((n) => n.kind === "el" && (ids.has(n.id) || holds(n.children, ids)));
}

/** Artboards an op makes, through nested batches. */
function createdBoards(op: Op): string[] {
  if (op.op === "artboard.create") return [op.artboard.id];
  if (op.op === "batch") return op.ops.flatMap(createdBoards);
  return [];
}

/**
 * A new artboard's wrapper, from when it landed: its shadow comes in with the sheet, and a name
 * inside it develops (arriveName). The sheet itself is in `Arrivals.replay`.
 */
export function arriveBoard(el: HTMLElement, at: number, now = performance.now()) {
  if (reducedMotion()) return;
  const shadow = el.animate(
    [
      { boxShadow: "none", offset: 0 },
      { boxShadow: "none", offset: (ARRIVE_LAG_MS + SHEET_FROM) / BOARD_MS },
    ],
    { duration: BOARD_MS, fill: "backwards" },
  );
  shadow.currentTime = now - at;
  const name = el.querySelector("[data-board-name]");
  if (name) arriveName(name, at, now);
}

/** A new artboard's name, wherever it's drawn: it develops left to right while the frame draws. */
export function arriveName(name: Element, at: number, now = performance.now()) {
  if (reducedMotion()) return;
  const mask = {
    maskImage: "linear-gradient(90deg,#000 0 45%,transparent 55%)",
    maskSize: "220% 100%",
    maskRepeat: "no-repeat",
  };
  const end = ARRIVE_LAG_MS + NAME_TO;
  const a = name.animate(
    [
      { ...mask, maskPosition: "100% 0", offset: 0 },
      {
        ...mask,
        maskPosition: "100% 0",
        offset: (ARRIVE_LAG_MS + NAME_FROM) / end,
        easing: ARRIVE_EASING,
      },
      { ...mask, maskPosition: "0 0", offset: 1 },
    ],
    { duration: end, fill: "backwards" },
  );
  a.currentTime = now - at;
}

/**
 * A new artboard's frame draws itself round its final bounds, on `rect` (pathLength 100), then
 * fades as the ring takes over. From when the board landed, so a late mount picks up mid-draw.
 */
export function drawFrame(rect: SVGElement, at: number, now = performance.now()) {
  if (reducedMotion()) return;
  const total = BOARD_DRAW_MS + BOARD_HANDOFF_MS;
  const a = rect.animate(
    [
      { strokeDashoffset: 100, opacity: 1, offset: 0, easing: "cubic-bezier(.5,0,.2,1)" },
      { strokeDashoffset: 0, opacity: 1, offset: BOARD_DRAW_MS / total },
      { strokeDashoffset: 0, opacity: 0, offset: 1 },
    ],
    { duration: total, fill: "both" },
  );
  a.currentTime = now - at - ARRIVE_LAG_MS;
}

/** When a working board's ring should start to show: once a new board's frame is nearly drawn. */
export function ringDelay(drawnAt: number | undefined, now = performance.now()): number {
  if (drawnAt === undefined) return 0;
  return Math.max(0, drawnAt + ARRIVE_LAG_MS + BOARD_DRAW_MS - 100 - now);
}
