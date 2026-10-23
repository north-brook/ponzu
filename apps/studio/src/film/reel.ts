import {
  type Artboard,
  type Cam,
  type Doc,
  type FilmShape,
  filmViewport,
  findArtboard,
  intentFor,
  type JournalEntry,
  noteBoards,
  type PNode,
  type Range,
  type Rect,
  replayTo,
  tryApply,
} from "@ponzu/core";
import { arrivals, artboardMarkup, artboardSize, loadArtboardFonts } from "@ponzu/react";
import type { Edit } from "./edit.ts";
import { schemeFor, settleAssets } from "./model.ts";

/*
 * The reel: a 15-second film of a design being made. What the person asked for, typed and sent;
 * then the design arriving piece by piece, as the agent wrote it, under a camera that holds still;
 * then the session's revisions landing quickly on the same frame; the result; the end card. No
 * comments, no pins, no cursor: the making is the film.
 */

/** Seconds per beat of a reel. */
export const REEL = {
  /** Before anything moves. */
  open: 0.15,
  /** The prompt: typed, sent, gone. */
  prompt: 1.45,
  /** The design arriving. */
  build: 8.4,
  /** A beat on the finished first pass before revisions start. */
  rest: 0.35,
  /** Each revision landing (its pieces swap, then a beat to see it), at most. */
  revision: 0.95,
  /** All the revisions together, about. */
  revisions: 3.2,
  /** The result, still, before the end card. */
  hold: 0.9,
  /** The end card. */
  end: 1.9,
} as const;

/** A piece arriving: the element, which board it's on, when its write landed (film s). */
export interface ReelPiece {
  id: string;
  board: string;
  at: number;
}

/** One revision: the canvas before and after, what it took away and what it brought. */
export interface ReelRevision {
  board: string;
  before: Doc;
  after: Doc;
  at: number;
  /** Pieces of the before taken away or replaced: they fade off first. */
  gone: string[];
  /** Pieces of the after that are new: they arrive once the old have gone. */
  fresh: string[];
}

export interface Reel extends Pick<Edit, "name" | "prompt" | "view" | "theme" | "assetBase"> {
  kind: "reel";
  shape: FilmShape;
  /** The boards the film is about, in the order first written, and the one frame that holds them. */
  boards: string[];
  cam: Cam;
  /** The canvas as each write left it (only the film's boards), with the film time it lands. */
  steps: { doc: Doc; at: number }[];
  pieces: ReelPiece[];
  revisions: ReelRevision[];
  /** How long each revision has. */
  revisionLen: number;
  /** The canvas at the end, with every revision. */
  result: Doc;
  /** Each board's height (canvas px) at the end of the build and at the end. */
  heights: Map<string, number>;
  /** When each board's sheet arrives: with its first piece. */
  boardAt: Map<string, number>;
  /** When the build starts, the revisions start, the result holds, the end card starts. */
  times: { build: number; revise: number; result: number; endCard: number; duration: number };
}

/** Whether to make a reel: the 15s film. */
export const isReel = (length: number) => length <= 15;

type El = Extract<PNode, { kind: "el" }>;

/**
 * The pieces a write brings, opened up so the design arrives in readable bits: a section's
 * heading, its text, each card, each image. A piece is opened when it holds several elements and
 * isn't itself a leaf of reading (a paragraph, a button, a picture), up to a depth.
 */
function openPieces(nodes: El[], depth = 0): El[] {
  const out: El[] = [];
  for (const n of nodes) {
    const kids = n.children.filter((c): c is El => c.kind === "el");
    const leaf =
      depth >= 3 ||
      kids.length < 2 ||
      /^(p|h[1-6]|button|a|img|svg|video|picture|span|label|li|input|textarea|select)$/.test(n.tag);
    if (leaf) out.push(n);
    // An opened container with a surface of its own (a card, a band) arrives first, then what's
    // in it; one that's only layout isn't a piece (it would arrive as nothing to see).
    else {
      if (surface(n)) out.push(n);
      out.push(...openPieces(kids, depth + 1));
    }
  }
  return out;
}

/** Whether an element draws something itself: a fill, a border, a shadow, an image. */
function surface(n: El): boolean {
  return Object.entries(n.style).some(
    ([k, v]) =>
      /^(background|background-color|background-image|border|border-(top|right|bottom|left)|box-shadow|outline)$/.test(
        k,
      ) && !/^(none|0|transparent|0px)$/.test(v.trim()),
  );
}

function findEl(doc: Doc, id: string): El | null {
  const walk = (n: El): El | null => {
    if (n.id === id) return n;
    for (const c of n.children) {
      if (c.kind !== "el") continue;
      const hit = walk(c);
      if (hit) return hit;
    }
    return null;
  };
  for (const p of doc.pages)
    for (const ab of p.artboards) {
      const hit = walk(ab.root);
      if (hit) return hit;
    }
  return null;
}

const union = (rects: Rect[]): Rect | undefined => {
  if (!rects.length) return undefined;
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w));
  const y1 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

/** Measures a board's height as the film draws it. */
async function heightOf(
  doc: Doc,
  ab: Artboard,
  assetBase: string | undefined,
  theme: "light" | "dark",
) {
  const fixed = artboardSize(ab).h;
  if (fixed) return fixed;
  const wrap = document.createElement("div");
  wrap.style.cssText = `position:fixed;left:0;top:0;visibility:hidden;width:${artboardSize(ab).w}px`;
  const host = document.createElement("div");
  wrap.appendChild(host);
  document.body.appendChild(wrap);
  const shadow = host.attachShadow({ mode: "open" });
  const { html, fonts, faces } = artboardMarkup(
    ab,
    doc.tokens,
    assetBase,
    schemeFor(doc, ab, theme),
  );
  loadArtboardFonts(fonts, faces);
  shadow.innerHTML = html;
  await settleAssets(shadow);
  const h = wrap.getBoundingClientRect().height || 900;
  wrap.remove();
  return h;
}

export interface ReelInput {
  name: string;
  entries: JournalEntry[];
  shape: FilmShape;
  range?: Range;
  theme: "light" | "dark";
  assetBase?: string;
}

/**
 * The reel of a session. The film is about the page the agent first built on, and on it the
 * boards that fill one frame best: the first board, and its neighbours while they still read.
 */
export async function buildReel(input: ReelInput): Promise<Reel> {
  const { entries } = input;
  const view = filmViewport(input.shape);
  const notes = noteBoards(entries);
  const inRange = (t: number) => !input.range || (t >= input.range.from && t <= input.range.to);
  const startAt = Math.max(
    0,
    entries.findIndex((e) => e.kind === "op" && inRange(e.t)),
  );
  const endAt = (() => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      if (e.kind === "op" && inRange(e.t)) return i;
    }
    return entries.length - 1;
  })();
  const blank = (): Doc => ({ name: input.name, pages: [], tokens: "", threads: [], notes: {} });
  const start = replayTo(entries, startAt - 1) ?? blank();
  const end = replayTo(entries, endAt) ?? blank();

  // The first pass: the agent's writes up to the first time the person steps in (a comment or
  // their own edit). What comes after is revision.
  const firstTouch = entries.findIndex(
    (e, i) => i >= startAt && i <= endAt && e.kind === "op" && e.origin.kind === "user",
  );
  const passEnd = firstTouch > 0 ? firstTouch - 1 : endAt;

  // The boards written in the first pass, in the order first written, on its first page.
  const order: string[] = [];
  let page: string | undefined;
  {
    const doc = structuredClone(start);
    for (let i = startAt; i <= passEnd; i++) {
      const e = entries[i]!;
      if (e.kind !== "op" || e.origin.kind !== "agent") continue;
      if (!tryApply(doc, e.op)) continue;
      for (const id of e.artboards) {
        if (notes.has(id) || order.includes(id)) continue;
        const pg = findArtboard(doc, id)?.page.id;
        page ??= pg;
        if (pg === page && arrivals(e.op).length) order.push(id);
      }
    }
  }

  // The frame: the first board, then its neighbours while the group still reads at this size.
  const pad = view.w > view.h ? 36 : 22;
  const top = 50;
  const vw = view.w - 2 * pad;
  const vh = view.h - 2 * pad - top;
  const rectOf = async (doc: Doc, id: string): Promise<Rect | null> => {
    const ab = findArtboard(doc, id)?.artboard;
    if (!ab) return null;
    return {
      x: ab.x,
      y: ab.y,
      w: artboardSize(ab).w,
      h: await heightOf(doc, ab, input.assetBase, input.theme),
    };
  };
  const firstDone = replayTo(entries, passEnd) ?? end;
  const rects = new Map<string, Rect>();
  for (const id of order) {
    const r = await rectOf(firstDone, id);
    if (r) rects.set(id, r);
  }
  // A board alone reads at its own zoom; with others it must keep most of that, and the group
  // must use the frame (a tall stack in a wide frame doesn't).
  const zoomFor = (r: Rect) => Math.min(vw / r.w, vh / r.h);
  const boards: string[] = order.slice(0, 1);
  const lead = rects.get(order[0] ?? "");
  if (lead) {
    const alone = zoomFor(lead);
    for (const id of order.slice(1)) {
      const r = rects.get(id);
      if (!r) continue;
      const group = union([...boards.map((b) => rects.get(b)!), r])!;
      const z = zoomFor(group);
      // Together only while each board keeps nearly its own size (phone screens side by side).
      if (z >= Math.min(alone, 1) * 0.85) boards.push(id);
    }
  }
  // Too tall to read whole (a long page): the top of it, at the frame's width.
  let frame = union(boards.map((b) => rects.get(b)!).filter(Boolean)) ?? { x: 0, y: 0, w: 1, h: 1 };
  const fitW = vw / frame.w;
  if (frame.h * fitW > vh && fitW > zoomFor(frame) * 1.25)
    frame = { ...frame, h: Math.min(frame.h, vh / Math.max(zoomFor(frame), Math.min(fitW, 0.6))) };
  const zoom = Math.min(1.25, zoomFor(frame));
  const cam: Cam = {
    page: page ?? start.pages[0]?.id ?? "",
    cx: frame.x + frame.w / 2,
    cy: frame.y + frame.h / 2 - top / 2 / zoom,
    zoom,
  };
  const inFrame = new Set(boards);
  const only = (doc: Doc): Doc => {
    const d = structuredClone(doc);
    for (const p of d.pages) p.artboards = p.artboards.filter((ab) => inFrame.has(ab.id));
    d.threads = [];
    return d;
  };

  // The prompt.
  const intent = intentFor(entries, entries[startAt]?.t ?? 0, entries[endAt]?.t ?? 0);
  const said = entries.find((e) => e.kind === "intent" && e.text === intent);
  const origin = said?.kind === "intent" ? said.origin : undefined;
  const prompt = intent
    ? { text: intent, who: { name: origin?.name ?? "Agent", client: origin?.client } }
    : undefined;

  // Revisions: per board in frame, every change after the first pass, as one before → after.
  // The biggest few, in the order made.
  const revs: { board: string; from: number; to: number; size: number }[] = [];
  {
    const open = new Map<string, { from: number; to: number }>();
    for (let i = passEnd + 1; i <= endAt; i++) {
      const e = entries[i]!;
      if (e.kind !== "op" || e.origin.kind !== "agent") continue;
      for (const id of e.artboards) {
        if (!inFrame.has(id)) continue;
        const o = open.get(id);
        if (o) o.to = i;
        else open.set(id, { from: i, to: i });
      }
      // A person's turn between closes the agent's runs: each run is one revision.
      const next = entries[i + 1];
      if (next?.kind === "op" && next.origin.kind === "user") {
        for (const [board, o] of open) revs.push({ board, ...o, size: 0 });
        open.clear();
      }
    }
    for (const [board, o] of open) revs.push({ board, ...o, size: 0 });
  }

  // Measure each revision: what it took away and brought, by element.
  const ids = (doc: Doc, board: string) => {
    const out = new Map<string, string>();
    const ab = findArtboard(doc, board)?.artboard;
    const walk = (n: El) => {
      for (const c of n.children) {
        if (c.kind !== "el") continue;
        out.set(
          c.id,
          JSON.stringify([c.tag, c.attrs, c.style, c.children.filter((x) => x.kind === "text")]),
        );
        walk(c);
      }
    };
    if (ab) walk(ab.root);
    return out;
  };
  const measured: (ReelRevision & { size: number; order: number })[] = [];
  for (const [k, r] of revs.entries()) {
    const before = replayTo(entries, r.from - 1);
    const after = replayTo(entries, r.to);
    if (!before || !after) continue;
    const A = ids(before, r.board);
    const B = ids(after, r.board);
    const changed = [...B].filter(([id, sig]) => A.get(id) !== sig).map(([id]) => id);
    const removed = [...A.keys()].filter((id) => !B.has(id));
    if (!changed.length && !removed.length) continue;
    // Outermost only: a changed element's descendants come with it.
    const outer = (list: string[], doc: Doc) => {
      const set = new Set(list);
      return list.filter((id) => {
        const ab = findArtboard(doc, r.board)?.artboard;
        if (!ab) return false;
        let found = false;
        let inside = false;
        const walk = (n: El, under: boolean) => {
          for (const c of n.children) {
            if (c.kind !== "el" || found) continue;
            if (c.id === id) {
              found = true;
              inside = under;
              return;
            }
            walk(c, under || set.has(c.id));
          }
        };
        walk(ab.root, false);
        return !inside;
      });
    };
    // A container that's only restyled (a column widened, a gap changed) isn't replaced: what's
    // in it stays, and only what's new or reworded inside it swaps. Otherwise a headline edit
    // would blank the whole hero and sweep it back.
    const isContainer = (doc: Doc, id: string) =>
      (findEl(doc, id)?.children ?? []).some((c) => c.kind === "el");
    const swapped = changed.filter((id) => !A.has(id) || !isContainer(after, id));
    // What it brings arrives in readable bits, as the build did.
    const fresh = openPieces(
      outer(swapped, after)
        .map((id) => findEl(after, id))
        .filter((n): n is El => Boolean(n)),
    ).map((n) => n.id);
    const gone = outer([...removed, ...swapped.filter((id) => A.has(id))], before);
    measured.push({
      board: r.board,
      before,
      after,
      at: 0,
      gone,
      fresh,
      size: fresh.length + gone.length,
      order: k,
    });
  }
  // Every revision to the boards in frame, in the order made: leaving one out would make the next
  // one's "before" jump. They come quicker the more there are.
  const chosen = measured.sort((a, b) => a.order - b.order);
  const each = chosen.length
    ? Math.min(REEL.revision, Math.max(0.5, REEL.revisions / chosen.length))
    : 0;

  // The clock. Spare time (few revisions) goes to the build, never to a long hold at the end.
  const duration = 15;
  const build = REEL.open + (prompt ? REEL.prompt : 0);
  const endCard = duration - REEL.end;
  const buildLen = Math.max(
    REEL.build,
    endCard - REEL.hold - chosen.length * each - REEL.rest - build,
  );
  const reviseAt = build + buildLen + REEL.rest;

  // The build's writes, in frame, as the canvas stood after each, and its pieces.
  const steps: Reel["steps"] = [];
  const pieces: ReelPiece[] = [];
  {
    const doc = structuredClone(start);
    const writes: { doc: Doc; bring: { id: string; board: string }[] }[] = [];
    for (let i = startAt; i <= passEnd; i++) {
      const e = entries[i]!;
      if (e.kind !== "op") continue;
      if (!tryApply(doc, e.op)) continue;
      if (e.origin.kind !== "agent" || !e.artboards.some((id) => inFrame.has(id))) continue;
      const bring = arrivals(e.op)
        .map((id) => findEl(doc, id))
        .filter((n): n is El => Boolean(n));
      const board = e.artboards.find((id) => inFrame.has(id))!;
      const opened = openPieces(bring).map((n) => ({ id: n.id, board }));
      if (!opened.length && writes.length) {
        writes.at(-1)!.doc = only(doc);
        continue;
      }
      writes.push({ doc: only(doc), bring: opened });
    }
    // Each write gets time by how much it brings, but less than in proportion (a big write pours
    // in, a small one still gets its beat), and within a write its pieces come quicker as it goes.
    const weight = (w: (typeof writes)[number]) => Math.sqrt(Math.max(1, w.bring.length)) + 0.6;
    const total = writes.reduce((a, w) => a + weight(w), 0);
    const arriveTail = 0.5;
    const span = Math.max(1, buildLen - arriveTail);
    let t = build;
    for (const w of writes) {
      const share = (span * weight(w)) / total;
      steps.push({ doc: w.doc, at: t });
      const n = w.bring.length;
      // A write's pieces arrive over most of its share, front-loaded.
      w.bring.forEach((p, i) =>
        pieces.push({ ...p, at: t + share * 0.8 * (n > 1 ? (i / (n - 1)) ** 1.6 : 0) }),
      );
      t += share;
    }
  }
  chosen.forEach((r, i) => {
    r.at = reviseAt + i * each;
    r.before = only(r.before);
    r.after = only(r.after);
  });
  const resultDoc = only(chosen.at(-1)?.after ?? firstDone);
  const heights = new Map<string, number>();
  for (const id of boards) {
    const r = await rectOf(resultDoc, id);
    if (r) heights.set(id, r.h);
  }
  const boardAt = new Map<string, number>();
  for (const p of pieces) if (!boardAt.has(p.board)) boardAt.set(p.board, p.at);

  return {
    kind: "reel",
    name: input.name,
    ...(prompt ? { prompt } : {}),
    shape: input.shape,
    view,
    theme: input.theme,
    assetBase: input.assetBase,
    boards,
    cam,
    steps,
    pieces,
    revisions: chosen.map(({ size: _s, order: _o, ...r }) => r),
    revisionLen: each,
    result: resultDoc,
    heights,
    boardAt,
    times: {
      build,
      revise: reviseAt,
      result: reviseAt + chosen.length * each,
      endCard,
      duration,
    },
  };
}
