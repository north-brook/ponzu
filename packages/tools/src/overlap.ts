import { type Artboard, type Doc, serializeArtboardElement } from "@ponzu/core";
import type { LintIssue } from "@ponzu/render";
import type { Workspace } from "./context.ts";
import { ARTBOARD_GAP, artboardSize } from "./util.ts";

/** Where an artboard sits on the canvas, at the size the person sees. */
export interface Footprint {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Overlap {
  /** The upper of the two (the left one when they share a top). */
  a: Footprint;
  b: Footprint;
  w: number;
  h: number;
}

type Size = { w: number; h: number };

const PX = /^-?\d+(?:\.\d+)?px$/;

/**
 * Measured sizes by design key and artboard id, with the source they were
 * measured from: an unchanged artboard isn't rendered again.
 */
const measured = new Map<string, Size & { source: string }>();
const MEASURED_LIMIT = 1000;

/**
 * Each artboard's footprint. A width or height that isn't px (fit-content,
 * auto) is measured when there's a renderer, since that's the size the canvas
 * draws; otherwise, or when `need` says its size doesn't matter, it reads as
 * 1440×900. `known` gives sizes already rendered, by artboard id.
 */
export async function footprints(
  ws: Workspace,
  key: string,
  doc: Doc,
  artboards: Artboard[],
  opts: { known?: Record<string, Size>; need?: (ab: Artboard) => boolean } = {},
): Promise<Footprint[]> {
  const known = opts.known ?? {};
  const sizes = new Map<string, Size>(Object.entries(known));
  const todo = artboards.filter((ab) => !known[ab.id] && !fixed(ab) && (opts.need?.(ab) ?? true));
  // A few at a time: each one is a page in the renderer.
  for (let i = 0; i < todo.length; i += 4)
    await Promise.all(
      todo.slice(i, i + 4).map(async (ab) => {
        const size = await measure(ws, key, doc, ab);
        if (size) sizes.set(ab.id, size);
      }),
    );
  return artboards.map((ab) => ({
    id: ab.id,
    name: ab.name,
    x: ab.x,
    y: ab.y,
    ...(sizes.get(ab.id) ?? artboardSize(ab)),
  }));
}

/**
 * Footprints for checking `ids` against the rest of their page: those first,
 * then only the artboards whose measured size could reach one of them.
 */
export async function footprintsAround(
  ws: Workspace,
  key: string,
  doc: Doc,
  artboards: Artboard[],
  ids: string[],
  known: Record<string, Size> = {},
): Promise<Footprint[]> {
  const mine = artboards.filter((ab) => ids.includes(ab.id));
  const targets = await footprints(ws, key, doc, mine, { known });
  const rest = await footprints(
    ws,
    key,
    doc,
    artboards.filter((ab) => !ids.includes(ab.id)),
    { need: (ab) => targets.some((t) => mayReach(ab, t)) },
  );
  return [...targets, ...rest];
}

/**
 * Overlaps anywhere on a page. Only measures an artboard whose size could
 * reach another one's, with both read at their largest: an unmeasured width
 * or height could be anything.
 */
export async function pageOverlapList(
  ws: Workspace,
  key: string,
  doc: Doc,
  artboards: Artboard[],
): Promise<Overlap[]> {
  const need = (ab: Artboard) => artboards.some((o) => o !== ab && mayReach(ab, reach(o)));
  return overlaps(await footprints(ws, key, doc, artboards, { need }));
}

/** The most an artboard can cover: its declared px size, unbounded where it has none. */
function reach(ab: Artboard): { x: number; y: number; w: number; h: number } {
  return {
    x: ab.x,
    y: ab.y,
    w: declared(ab.root.style.width) ?? Number.POSITIVE_INFINITY,
    h: declared(ab.root.style.height) ?? Number.POSITIVE_INFINITY,
  };
}

/** Whether artboard ab, whatever its unmeasured size turns out to be, could cover box. */
export function mayReach(ab: Artboard, box: { x: number; y: number; w: number; h: number }) {
  const w = declared(ab.root.style.width);
  const h = declared(ab.root.style.height);
  return (
    ab.x < box.x + box.w &&
    (w === null || ab.x + w > box.x) &&
    ab.y < box.y + box.h &&
    (h === null || ab.y + h > box.y)
  );
}

/**
 * For autoPlace: which artboards' real size could change the spot it picks in
 * any of `rows` (the first artboard's row by default). Ones starting well
 * below every row can't.
 */
export function rowNeed(artboards: Artboard[], ...rows: (number | undefined)[]) {
  const ys = rows.filter((y) => y !== undefined);
  if (!ys.length) ys.push(artboards[0]?.y ?? 0);
  return (ab: Artboard) => ys.some((y) => ab.y < y + 2000);
}

function declared(v: string | undefined): number | null {
  return PX.test(v?.trim() ?? "") ? Number.parseFloat(v!) : null;
}

function fixed(ab: Artboard): boolean {
  return declared(ab.root.style.width) !== null && declared(ab.root.style.height) !== null;
}

async function measure(ws: Workspace, key: string, doc: Doc, ab: Artboard): Promise<Size | null> {
  if (!ws.renderer?.measure) return null;
  const assetBase = ws.assetBase?.(key);
  const source = `${assetBase ?? ""}\n${doc.tokens}\n${serializeArtboardElement(ab)}`;
  const id = `${key}\n${ab.id}`;
  const hit = measured.get(id);
  if (hit?.source === source) return { w: hit.w, h: hit.h };
  try {
    const out = await ws.renderer.measure({
      artboard: ab,
      tokens: doc.tokens,
      ids: [ab.id],
      assetBase,
    });
    const box = out.boxes[ab.id];
    if (!box) return null;
    const size = { w: Math.round(box.width), h: Math.round(box.height) };
    measured.delete(id);
    measured.set(id, { ...size, source });
    if (measured.size > MEASURED_LIMIT) measured.delete(measured.keys().next().value!);
    return size;
  } catch {
    // No measurement: the declared size stands in, as without a renderer.
    return null;
  }
}

/** Pairs of artboards that cover each other, involving any of `ids` when given. */
export function overlaps(boxes: Footprint[], ids?: Iterable<string>): Overlap[] {
  const only = ids ? new Set(ids) : null;
  const out: Overlap[] = [];
  for (const [i, p] of boxes.entries()) {
    for (const q of boxes.slice(i + 1)) {
      if (only && !only.has(p.id) && !only.has(q.id)) continue;
      const w = Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x);
      const h = Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y);
      // Edges that touch, or graze by a rounding pixel, aren't an overlap.
      if (w <= 1 || h <= 1) continue;
      const [a, b] = p.y < q.y || (p.y === q.y && p.x <= q.x) ? [p, q] : [q, p];
      out.push({ a, b, w: Math.round(w), h: Math.round(h) });
    }
  }
  return out;
}

/** Where the lower artboard of a pair clears the upper one. */
function fix(o: Overlap): string {
  return `${o.b.id} clears it at y ${Math.round(o.a.y + o.a.h + ARTBOARD_GAP)} (update_artboard)`;
}

/** One line per overlap, for listings. */
export function overlapLine(o: Overlap): string {
  return `${o.a.id} "${o.a.name}" and ${o.b.id} "${o.b.name}" overlap by ${o.w}×${o.h}px; ${fix(o)}.`;
}

/** Overlaps as lint issues on artboard `id`. */
export function overlapIssues(id: string, list: Overlap[]): LintIssue[] {
  return list.map((o) => {
    const other = o.a.id === id ? o.b : o.a;
    return {
      id,
      kind: "artboard-overlap",
      message: `overlaps artboard ${other.id} "${other.name}" by ${o.w}×${o.h}px on the canvas; ${fix(o)}.`,
    };
  });
}

/** A note for a write result, or nothing when no artboard overlaps another. */
export function overlapNote(list: Overlap[]): string {
  if (!list.length) return "";
  return `\nOverlap: ${list.map(overlapLine).join("\n  ")}`;
}
