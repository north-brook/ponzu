import type { Doc, Op, PNode } from "@ponzu/core";

/*
 * How an agent's work arrives on the canvas: the shimmer slide. A beat after a write lands, each
 * new piece is uncovered left to right while it eases in a few px, and a band of light rides the
 * leading edge: the same sweep the agent's name shimmers with in the board's header. Neutral on
 * purpose: the agent's trace is the yuzu. Pieces go in the order written. The person's own edits,
 * undo, redo and outside changes just appear. The studio plays it live; the timelapse film seeks
 * the same animation frame by frame. It never holds the agent up: it runs after a write has
 * landed, in the page only.
 */

/** One piece's reveal. */
export const ARRIVE_MS = 620;
/** A beat between a write landing and its first piece showing: the reveal, not a wait. */
export const ARRIVE_LAG_MS = 90;
/** Between one piece and the next, in the order written. */
export const ARRIVE_STAGGER_MS = 55;
/** A long write still lands in about a second: past this many pieces, the rest come together. */
export const ARRIVE_MAX_STAGGER = 10;
/** How far a piece slides in, in the artboard's own px. */
export const ARRIVE_SLIDE = 10;
export const ARRIVE_EASING = "cubic-bezier(.3,.7,.25,1)";

/**
 * The reveal's mask: three times the piece's width, shown | a band of light | a soft edge |
 * hidden. Sliding it from 100% to 0% carries the edge, with the band just behind it, across the
 * piece; at 0% only the shown third covers the piece, so the end is the piece as drawn.
 */
const MASK =
  "linear-gradient(90deg,#000 0 44%,rgba(0,0,0,.4) 48%,rgba(0,0,0,.75) 50%,transparent 56%,transparent 100%)";
const masked = { maskImage: MASK, maskSize: "300% 100%", maskRepeat: "no-repeat" };

/** The shimmer slide, from hidden at the left edge to the piece as the design draws it. */
export const ARRIVE_KEYFRAMES: Keyframe[] = [
  { ...masked, maskPosition: "100% 0", translate: `-${ARRIVE_SLIDE}px 0` },
  { ...masked, maskPosition: "0% 0", translate: "0 0" },
];

/** A new artboard's sheet: up from a touch smaller while its first pieces start to arrive. */
export const BOARD_MS = 420;

/** When a write's piece starts, after the write lands: the beat, then its place in the stagger. */
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
 */
export function arrivals(op: Op): string[] {
  switch (op.op) {
    case "insert":
      return elementIds(op.nodes);
    case "children":
      return elementIds(op.children);
    case "artboard.create":
      return elementIds(op.artboard.root.children);
    case "batch":
      return op.ops.flatMap(arrivals);
    default:
      return [];
  }
}

function elementIds(nodes: PNode[]): string[] {
  return nodes.flatMap((n) => (n.kind === "el" ? [n.id] : []));
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

/** Whether the person has asked for less motion. */
export function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * What's still arriving in one canvas. An artboard re-renders its whole shadow root on every
 * change, so a piece written a moment ago would snap to its end the instant the agent writes the
 * next one: each render replays what's in flight from where it had got to.
 */
export class Arrivals {
  /** Piece id → when its reveal starts (performance.now()). */
  private pieces = new Map<string, number>();
  /** New artboards, whose sheet settles in as they mount, and when each was made. */
  private boards = new Map<string, number>();

  /** An agent's op landed: queue what it brought, after anything still arriving. */
  add(op: Op, doc: Doc, now = performance.now()) {
    if (reducedMotion()) return;
    this.prune(now);
    for (const id of createdBoards(op)) this.boards.set(id, now);
    const ids = outermost(doc, arrivals(op)).filter((id) => !this.pieces.has(id));
    // The first piece shows a beat after the write lands, or one stagger after whatever is still
    // arriving, whichever is later: the beat is a floor, never paid twice. Every piece starts
    // within ten staggers of that beat, so a long write still lands in about a second.
    let first = now + ARRIVE_LAG_MS;
    for (const start of this.pieces.values()) first = Math.max(first, start + ARRIVE_STAGGER_MS);
    const latest = now + arriveDelay(ARRIVE_MAX_STAGGER);
    ids.forEach((id, i) => this.pieces.set(id, Math.min(latest, first + i * ARRIVE_STAGGER_MS)));
  }

  /** Whether this artboard is new from an agent, so its sheet settles in. Asked once, on mount. */
  takeBoard(id: string, now = performance.now()): boolean {
    this.prune(now);
    return this.boards.delete(id);
  }

  /** After an artboard re-renders: set each piece in flight going again from where it was. */
  replay(root: ShadowRoot, now = performance.now()) {
    if (reducedMotion()) {
      this.pieces.clear();
      return;
    }
    this.prune(now);
    for (const [id, start] of this.pieces) {
      const el = root.querySelector(`[data-id="${CSS.escape(id)}"]`);
      if (!el) continue;
      const a = el.animate(ARRIVE_KEYFRAMES, {
        duration: ARRIVE_MS,
        easing: ARRIVE_EASING,
        fill: "backwards",
      });
      // Negative while it waits its turn in the stagger: held at the start until then.
      a.currentTime = now - start;
    }
  }

  private prune(now: number) {
    for (const [id, start] of this.pieces) if (now - start > ARRIVE_MS) this.pieces.delete(id);
    // A board made on a page that isn't showing arrives as it is when that page opens later.
    for (const [id, at] of this.boards) if (now - at > BOARD_MS + 1000) this.boards.delete(id);
  }
}

/** Artboards an op makes, through nested batches. */
function createdBoards(op: Op): string[] {
  if (op.op === "artboard.create") return [op.artboard.id];
  if (op.op === "batch") return op.ops.flatMap(createdBoards);
  return [];
}

/** A new artboard's sheet settles onto the canvas. */
export function arriveBoard(el: HTMLElement) {
  if (reducedMotion()) return;
  el.animate([{ opacity: 0, scale: 0.985, offset: 0 }], {
    duration: BOARD_MS,
    easing: ARRIVE_EASING,
    fill: "backwards",
  });
}
