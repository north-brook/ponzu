import type { Doc, Op, PNode } from "@ponzu/core";

/*
 * How an agent's work arrives on the canvas: each new piece rises a little out of a soft blur,
 * in the order the agent wrote it. The person's own edits, undo, redo and outside changes just
 * appear. The studio plays it live; the timelapse film seeks the same animation frame by frame.
 */

/** One piece's rise. */
export const ARRIVE_MS = 640;
/** Between one piece and the next, in the order written. */
export const ARRIVE_STAGGER_MS = 55;
/** A long write still lands in about a second: past this many pieces, the rest come together. */
export const ARRIVE_MAX_STAGGER = 10;
/** How far a piece rises, in the artboard's own px. */
export const ARRIVE_RISE = 14;
export const ARRIVE_BLUR = 6;
export const ARRIVE_EASING = "cubic-bezier(.2,.7,.2,1)";

/** The keyframe a piece rises from: on its way to how the design draws it. */
export const ARRIVE_FROM: Keyframe = {
  opacity: 0,
  translate: `0 ${ARRIVE_RISE}px`,
  filter: `blur(${ARRIVE_BLUR}px)`,
  offset: 0,
};

/** A new artboard's sheet: up from a touch smaller while its first pieces start to rise. */
export const BOARD_MS = 420;

/** When each piece starts, after the first. */
export function arriveDelay(index: number): number {
  return Math.min(index, ARRIVE_MAX_STAGGER) * ARRIVE_STAGGER_MS;
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
  // Keep the order written, which is the order they rise in.
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
  /** Piece id → when it starts rising (performance.now()). */
  private pieces = new Map<string, number>();
  /** New artboards, whose sheet fades up before their pieces rise. */
  private boards = new Set<string>();

  /** An agent's op landed: queue what it brought, after anything still rising. */
  add(op: Op, doc: Doc, now = performance.now()) {
    if (reducedMotion()) return;
    this.prune(now);
    if (op.op === "artboard.create") this.boards.add(op.artboard.id);
    else if (op.op === "batch")
      for (const o of op.ops) if (o.op === "artboard.create") this.boards.add(o.artboard.id);
    const ids = outermost(doc, arrivals(op)).filter((id) => !this.pieces.has(id));
    // A write that lands while the last is still rising joins the end of its stagger.
    let last = now;
    for (const start of this.pieces.values()) last = Math.max(last, start + ARRIVE_STAGGER_MS);
    const from = Math.min(last, now + ARRIVE_MAX_STAGGER * ARRIVE_STAGGER_MS);
    ids.forEach((id, i) => this.pieces.set(id, from + arriveDelay(i)));
  }

  /** Whether this artboard is new from an agent, so its sheet fades up. Asked once, on mount. */
  takeBoard(id: string): boolean {
    return this.boards.delete(id);
  }

  /** After an artboard re-renders: set each piece in flight going again from where it was. */
  replay(root: ShadowRoot, now = performance.now()) {
    this.prune(now);
    for (const [id, start] of this.pieces) {
      const el = root.querySelector(`[data-id="${CSS.escape(id)}"]`);
      if (!el) continue;
      const a = el.animate([ARRIVE_FROM], {
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
  }
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
