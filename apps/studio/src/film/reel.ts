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
  type Op,
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
 * The reel: a 15-second film of a design being made. The prompt; then each screen arriving piece
 * by piece, as the agent wrote it, one quick shot per group of screens that fit a frame together;
 * then the comments left on them sweep in and the revisions land; all the screens together; the
 * bloom. Every board is drawn at the layout it reaches, so pieces arrive in place and nothing
 * reflows under them.
 */

/** Seconds, and the pace of a reel. */
export const REEL = {
  /** The prompt, typed and sent; the first screen starts as it goes. */
  prompt: 1.05,
  /** One group of screens revising: its comments sweep in, then the changes land. */
  revise: 2.1,
  /** At most this many groups revise; the rest show their final look in the last shot. */
  maxRevise: 2,
  /** All the screens together. */
  result: 1.05,
  /** The bloom. */
  end: 1.6,
  /** A build shot is never shorter than this. */
  minShot: 1.0,
} as const;

/** One piece's arrival in a reel (ms): quicker than the canvas, so pieces read one by one. */
export const PIECE_MS = 380;
/** A screen's blank sheet and its trace show this long before its first piece (s): working. */
export const SHEET_LEAD = 0.3;

/** The frame's insets (film px): room for the logo and board names on top. */
const INSET = { x: 34, top: 46, bottom: 28 };

type El = Extract<PNode, { kind: "el" }>;

export interface ReelState {
  ab: Artboard;
  /** Carries the tokens the board is drawn with (and its theme). */
  doc: Doc;
  h: number;
}

export interface ReelBoard {
  id: string;
  name: string;
  w: number;
  /** As the agent first finished it, and as the session left it. */
  before: ReelState;
  after: ReelState;
}

/** Boards seen together, each placed (film canvas px), and the camera on them. */
export interface ReelShot {
  boards: string[];
  place: Map<string, { x: number; y: number }>;
  cam: Cam;
}

export interface ReelRevision {
  at: number;
  /** Pieces of the before taken away, replaced or restyled: they fade off over the after. */
  gone: string[];
  /** Pieces of the after that are new: they arrive. */
  fresh: string[];
  /** The board's colours changed (its tokens): the whole of it crossfades. */
  recolor: boolean;
}

export interface ReelComment {
  thread: string;
  board: string;
  /** On its board, in board px. */
  x: number;
  y: number;
  /** A glimpse of it: the person's own words, cut short. */
  text: string;
  at: number;
  /** Its card leaves; later its pin checks off. */
  cardOut: number;
  resolveAt: number;
}

export type ReelSegment = {
  kind: "build" | "revise" | "result";
  shot: number;
  t0: number;
  t1: number;
};

export interface Reel extends Pick<Edit, "name" | "prompt" | "view" | "theme" | "assetBase"> {
  kind: "reel";
  shape: FilmShape;
  boards: Map<string, ReelBoard>;
  shots: ReelShot[];
  segments: ReelSegment[];
  /** Per board: its pieces and when each arrives. */
  pieces: Map<string, { id: string; at: number }[]>;
  /** When each board's sheet arrives (with its first piece) and its last piece lands. */
  boardAt: Map<string, number>;
  lastAt: Map<string, number>;
  revisions: Map<string, ReelRevision>;
  comments: ReelComment[];
  times: { prompt: number; build: number; endCard: number; duration: number };
}

/** Whether to make a reel: the 15s film. */
export const isReel = (length: number) => length <= 15;

/**
 * The pieces a write brings, opened up so the design arrives in readable bits: a section's
 * heading, its text, each card, each image. A container with a surface of its own (a card, a band)
 * arrives first, then what's in it; one that's only layout isn't a piece.
 */
function openPieces(nodes: El[], depth = 0): El[] {
  const out: El[] = [];
  for (const n of nodes) {
    const kids = n.children.filter((c): c is El => c.kind === "el");
    const leaf =
      depth >= 6 ||
      !kids.length ||
      /^(p|h[1-6]|button|a|img|svg|video|picture|label|input|textarea|select)$/.test(n.tag) ||
      // A line of text with a word set apart in it (a headline's emphasis) is one piece.
      n.children.some((c) => c.kind === "text" && c.value.trim());
    if (leaf) out.push(n);
    else {
      if (surface(n)) out.push(n);
      out.push(...openPieces(kids, depth + 1));
    }
  }
  return out;
}

/** Whether an element draws something itself: a fill, a border, a shadow. */
function surface(n: El): boolean {
  return Object.entries(n.style).some(
    ([k, v]) =>
      /^(background|background-color|background-image|border|border-(top|right|bottom|left)|box-shadow|outline)$/.test(
        k,
      ) && !/^(none|0|transparent|0px)$/.test(v.trim()),
  );
}

function findIn(root: El, id: string): El | null {
  if (root.id === id) return root;
  for (const c of root.children) {
    if (c.kind !== "el") continue;
    const hit = findIn(c, id);
    if (hit) return hit;
  }
  return null;
}

function walkEls(root: El, fn: (n: El) => void) {
  for (const c of root.children) {
    if (c.kind !== "el") continue;
    fn(c);
    walkEls(c, fn);
  }
}

const union = (rects: Rect[]): Rect | undefined => {
  if (!rects.length) return undefined;
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w));
  const y1 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

const leaves = (op: Op): Op[] => (op.op === "batch" ? op.ops.flatMap(leaves) : [op]);

/** A glimpse of a comment: a short sentence of it whole, else its first words. */
export function glimpse(text: string, n = 9): string {
  const sentences = text
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean);
  const words = (s: string) => s.split(/\s+/).length;
  const first = sentences[0] ?? text;
  if (words(first) <= n + 2) return first;
  const ask = sentences.find((s) => s.endsWith("?") && words(s) <= n + 2);
  if (ask) return ask;
  return `${first
    .split(/\s+/)
    .slice(0, n)
    .join(" ")
    .replace(/[,;:]$/, "")}…`;
}

/** A board's height as the film draws it. */
async function heightOf(
  doc: Doc,
  ab: Artboard,
  assetBase: string | undefined,
  theme: "light" | "dark",
): Promise<number> {
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

export async function buildReel(input: ReelInput): Promise<Reel> {
  const { entries } = input;
  const view = filmViewport(input.shape);
  const notes = noteBoards(entries);
  const inRange = (t: number) => !input.range || (t >= input.range.from && t <= input.range.to);
  const startAt = Math.max(
    0,
    entries.findIndex((e) => e.kind === "op" && inRange(e.t)),
  );
  let endAt = entries.length - 1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.kind === "op" && inRange(e.t)) {
      endAt = i;
      break;
    }
  }
  const blank = (): Doc => ({ name: input.name, pages: [], tokens: "", threads: [], notes: {} });
  const tokensDoc = (tokens: string): Doc => ({ ...blank(), tokens });

  // Walk the session once. A board's build is the agent's writes on it until the person next
  // steps in (a comment, an edit); what the agent does to it after that is its revision.
  const doc = replayTo(entries, startAt - 1) ?? blank();
  let page: string | undefined;
  const order: string[] = [];
  const writes: { board: string; ids: string[] }[] = [];
  const frozen = new Map<string, { ab: Artboard; tokens: string; at: number }>();
  const comments: {
    thread: string;
    board: string;
    x: number;
    y: number;
    text: string;
    i: number;
  }[] = [];
  for (let i = startAt; i <= endAt; i++) {
    const e = entries[i]!;
    if (e.kind !== "op") continue;
    if (e.origin.kind === "user") {
      // The person steps in: every board the agent has started is, as it stands, its first pass.
      for (const id of order)
        if (!frozen.has(id)) {
          const ab = findArtboard(doc, id)?.artboard;
          if (ab) frozen.set(id, { ab: structuredClone(ab), tokens: doc.tokens, at: i });
        }
      for (const o of leaves(e.op))
        if (o.op === "thread.create" && o.thread.artboardId)
          comments.push({
            thread: o.thread.id,
            board: o.thread.artboardId,
            x: o.thread.x,
            y: o.thread.y,
            text: o.thread.messages[0]?.text ?? "",
            i,
          });
    }
    if (!tryApply(doc, e.op)) continue;
    if (e.origin.kind !== "agent") continue;
    const brought = arrivals(e.op);
    for (const id of e.artboards) {
      if (notes.has(id) || frozen.has(id)) continue;
      const pg = findArtboard(doc, id)?.page.id;
      if (!pg) continue;
      page ??= pg;
      if (pg !== page) continue;
      const ab = findArtboard(doc, id)!.artboard;
      const mine = brought.filter((x) => findIn(ab.root, x));
      if (!mine.length) continue;
      if (!order.includes(id)) order.push(id);
      const opened = openPieces(
        mine.map((x) => findIn(ab.root, x)).filter((n): n is El => Boolean(n)),
      ).map((n) => n.id);
      writes.push({ board: id, ids: opened });
    }
  }
  for (const id of order)
    if (!frozen.has(id)) {
      const ab = findArtboard(doc, id)?.artboard;
      if (ab) frozen.set(id, { ab: structuredClone(ab), tokens: doc.tokens, at: endAt + 1 });
    }

  // Each board as first finished and as left.
  const boards = new Map<string, ReelBoard>();
  for (const id of order) {
    const f = frozen.get(id);
    const ab1 = findArtboard(doc, id)?.artboard;
    if (!f || !ab1) continue;
    const d0 = tokensDoc(f.tokens);
    const d1 = tokensDoc(doc.tokens);
    boards.set(id, {
      id,
      name: ab1.name,
      w: artboardSize(ab1).w,
      before: { ab: f.ab, doc: d0, h: await heightOf(d0, f.ab, input.assetBase, input.theme) },
      after: {
        ab: structuredClone(ab1),
        doc: d1,
        h: await heightOf(d1, ab1, input.assetBase, input.theme),
      },
    });
  }
  const ids = order.filter((id) => boards.has(id));
  const canvasAt = (id: string) => {
    const ab = findArtboard(doc, id)!.artboard;
    return { x: ab.x, y: ab.y };
  };
  const rectAt = (id: string, p = canvasAt(id)): Rect => {
    const b = boards.get(id)!;
    return { x: p.x, y: p.y, w: b.w, h: Math.max(b.before.h, b.after.h) };
  };

  // Framing: whole boards, padded, never cut.
  const vw = view.w - 2 * INSET.x;
  const vh = view.h - INSET.top - INSET.bottom;
  const zoomFor = (r: Rect) => Math.min(1.15, vw / r.w, vh / r.h);
  const camFor = (r: Rect): Cam => {
    const zoom = zoomFor(r);
    return {
      page: page ?? "",
      cx: r.x + r.w / 2,
      cy: r.y + r.h / 2 - (INSET.top - INSET.bottom) / 2 / zoom,
      zoom,
    };
  };
  const shotOf = (members: string[], place: Map<string, { x: number; y: number }>): ReelShot => ({
    boards: members,
    place,
    cam: camFor(union(members.map((id) => rectAt(id, place.get(id))))!),
  });

  // Build shots: screens written one after another share a shot while each keeps nearly its own
  // size together (phone screens side by side), and nothing else sits between them.
  const groups: string[][] = [];
  for (const id of ids) {
    const g = groups.at(-1);
    if (g) {
      const together = union([...g, id].map((x) => rectAt(x)))!;
      const alone = Math.min(zoomFor(rectAt(id)), zoomFor(union(g.map((x) => rectAt(x)))!));
      const between = ids.some((o) => {
        if ([...g, id].includes(o)) return false;
        const r = rectAt(o);
        return (
          r.x < together.x + together.w &&
          r.x + r.w > together.x &&
          r.y < together.y + together.h &&
          r.y + r.h > together.y
        );
      });
      if (!between && zoomFor(together) >= alone * 0.82) {
        g.push(id);
        continue;
      }
    }
    groups.push([id]);
  }
  const shots: ReelShot[] = groups.map((g) =>
    shotOf(g, new Map(g.map((id) => [id, canvasAt(id)]))),
  );

  // The last shot: every screen together, as the canvas has them when that fills the frame,
  // else packed into rows in the order made.
  const resultShot = (() => {
    const canvas = shotOf(ids, new Map(ids.map((id) => [id, canvasAt(id)])));
    let best: ReelShot | null = null;
    const GAP = 90;
    for (let rows = 1; rows <= ids.length; rows++) {
      const total = ids.reduce((a, id) => a + boards.get(id)!.w, 0);
      const target = total / rows;
      const lines: string[][] = [[]];
      let w = 0;
      for (const id of ids) {
        const bw = boards.get(id)!.w;
        if (lines.at(-1)!.length && w + bw / 2 > target && lines.length < rows) {
          lines.push([]);
          w = 0;
        }
        lines.at(-1)!.push(id);
        w += bw;
      }
      const widths = lines.map(
        (l) => l.reduce((a, id) => a + boards.get(id)!.w, 0) + GAP * (l.length - 1),
      );
      const widest = Math.max(...widths);
      const place = new Map<string, { x: number; y: number }>();
      let y = 0;
      lines.forEach((l, k) => {
        let x = (widest - widths[k]!) / 2;
        const rowH = Math.max(...l.map((id) => rectAt(id).h));
        for (const id of l) {
          place.set(id, { x, y });
          x += boards.get(id)!.w + GAP;
        }
        y += rowH + GAP * 1.4;
      });
      const s = shotOf(ids, place);
      if (!best || s.cam.zoom > best.cam.zoom) best = s;
    }
    return best && best.cam.zoom > canvas.cam.zoom * 1.12 ? best : canvas;
  })();

  // Revisions: per board, what changed between its first pass and the end.
  const sig = (n: El) =>
    JSON.stringify([n.tag, n.attrs, n.style, n.children.filter((c) => c.kind === "text")]);
  const revisions = new Map<string, ReelRevision>();
  const reviseSize = new Map<string, number>();
  for (const [id, b] of boards) {
    const A = new Map<string, El>();
    const B = new Map<string, El>();
    walkEls(b.before.ab.root, (n) => A.set(n.id, n));
    walkEls(b.after.ab.root, (n) => B.set(n.id, n));
    const added: string[] = [];
    const removed: string[] = [];
    // A changed leaf is swapped (it fades off and the new arrives).
    const swapped: string[] = [];
    for (const [nid, n] of B) {
      const was = A.get(nid);
      if (!was) added.push(nid);
      else if (sig(was) !== sig(n)) {
        // Its own words changed (a headline with an emphasis in it): it's swapped whole, so it
        // never shows half old, half new. A container only restyled keeps what's in it.
        const own = (x: El) => JSON.stringify(x.children.filter((c) => c.kind === "text"));
        if (!n.children.some((c) => c.kind === "el") || own(was) !== own(n)) swapped.push(nid);
      }
    }
    for (const nid of A.keys()) if (!B.has(nid)) removed.push(nid);
    const outer = (list: string[], root: El) => {
      const set = new Set(list);
      const out: string[] = [];
      const walk = (n: El, under: boolean) => {
        for (const c of n.children) {
          if (c.kind !== "el") continue;
          const hit = set.has(c.id);
          if (hit && !under) out.push(c.id);
          walk(c, under || hit);
        }
      };
      walk(root, false);
      return out;
    };
    const fresh = openPieces(
      outer([...added, ...swapped], b.after.ab.root)
        .map((x) => findIn(b.after.ab.root, x))
        .filter((n): n is El => Boolean(n)),
    ).map((n) => n.id);
    const gone = outer([...removed, ...swapped], b.before.ab.root);
    const recolor =
      b.before.doc.tokens !== b.after.doc.tokens &&
      artboardMarkup(b.after.ab, b.before.doc.tokens, input.assetBase).html !==
        artboardMarkup(b.after.ab, b.after.doc.tokens, input.assetBase).html;
    if (!fresh.length && !gone.length && !recolor) continue;
    revisions.set(id, { at: 0, gone, fresh, recolor });
    reviseSize.set(id, fresh.length + gone.length + (recolor ? 6 : 0));
  }

  // The prompt.
  const intent = intentFor(entries, entries[startAt]?.t ?? 0, entries[endAt]?.t ?? 0);
  const said = entries.find((e) => e.kind === "intent" && e.text === intent);
  const origin = said?.kind === "intent" ? said.origin : undefined;
  const prompt = intent
    ? { text: intent, who: { name: origin?.name ?? "Agent", client: origin?.client } }
    : undefined;

  // The clock. The groups that revise most get a shot each, in the order built.
  const reviseShots = shots
    .map((s, k) => ({ k, size: s.boards.reduce((a, id) => a + (reviseSize.get(id) ?? 0), 0) }))
    .filter((x) => x.size > 0)
    .sort((a, b) => b.size - a.size)
    .slice(0, REEL.maxRevise)
    .sort((a, b) => a.k - b.k)
    .map((x) => x.k);
  const duration = 15;
  const endCard = duration - REEL.end;
  const resultAt = endCard - REEL.result;
  const reviseAt = resultAt - reviseShots.length * REEL.revise;
  const promptEnd = prompt ? REEL.prompt : 0.1;
  // The first screen's sheet lands as the prompt finishes lifting away: never under it, never
  // a beat of empty canvas after it.
  const buildAt = Math.max(0.1, promptEnd - 0.06);
  const buildLen = reviseAt - buildAt;

  // Build shots share the build by how much each brings (less than in proportion).
  const piecesOf = (g: string[]) => writes.filter((w) => g.includes(w.board));
  const weights = groups.map(
    (g) => Math.sqrt(piecesOf(g).reduce((a, w) => a + w.ids.length, 0)) + 1.5,
  );
  const total = weights.reduce((a, b) => a + b, 0);
  const lens = weights.map((w) => Math.max(REEL.minShot, (buildLen * w) / total));
  const scale = buildLen / lens.reduce((a, b) => a + b, 0);
  const segments: ReelSegment[] = [];
  const pieces = new Map<string, { id: string; at: number }[]>();
  let t = buildAt;
  groups.forEach((g, k) => {
    const len = lens[k]! * scale;
    segments.push({ kind: "build", shot: k, t0: t, t1: t + len });
    // The screen is assembled: its pieces one after another, in the order written, on an even
    // beat that quickens a little as it fills. A new write starts when the last one's pieces
    // have started, so the agent's rhythm shows, never a whole screen at once.
    const ws = piecesOf(g).map((w) => ({
      ...w,
      ids: w.ids.filter((id) => findIn(boards.get(w.board)!.before.ab.root, id)),
    }));
    const all = ws.flatMap((w) => w.ids.map((id) => ({ id, board: w.board })));
    // The last piece has landed with a beat to spare before the cut.
    const span = Math.max(0.3, len - SHEET_LEAD - PIECE_MS / 1000 - 0.22);
    const n = all.length;
    all.forEach((p, j) => {
      const list = pieces.get(p.board) ?? [];
      list.push({ id: p.id, at: t + SHEET_LEAD + span * (n > 1 ? (j / (n - 1)) ** 1.12 : 0) });
      pieces.set(p.board, list);
    });
    t += len;
  });
  const boardAt = new Map<string, number>();
  const lastAt = new Map<string, number>();
  for (const [id, list] of pieces) {
    boardAt.set(id, Math.min(...list.map((p) => p.at)));
    lastAt.set(id, Math.max(...list.map((p) => p.at)));
  }

  // Revise shots: the comments left on its screens sweep in left to right, then the changes land
  // and each pin checks off.
  const sweep: ReelComment[] = [];
  reviseShots.forEach((k, n) => {
    const t0 = reviseAt + n * REEL.revise;
    segments.push({ kind: "revise", shot: k, t0, t1: t0 + REEL.revise });
    const shot = shots[k]!;
    const zoom = shot.cam.zoom;
    const mine = comments
      .filter((c) => shot.boards.includes(c.board) && c.i >= (frozen.get(c.board)?.at ?? 0))
      .map((c) => ({ ...c, sx: (shot.place.get(c.board)!.x + c.x) * zoom }))
      .sort((a, b) => a.sx - b.sx);
    const changeAt = t0 + 1.2;
    shot.boards.forEach((id, j) => {
      const r = revisions.get(id);
      if (r) r.at = changeAt + j * 0.08;
    });
    // The sweep: pins land left to right; each one's words show while the sweep is on it, so
    // cards never pile up.
    const step = mine.length > 1 ? Math.min(0.36, 0.95 / (mine.length - 1)) : 0;
    mine.forEach((c, j) => {
      const at = t0 + 0.08 + j * step;
      sweep.push({
        thread: c.thread,
        board: c.board,
        x: c.x,
        y: c.y,
        text: glimpse(c.text),
        at,
        cardOut:
          j === mine.length - 1 ? changeAt - 0.05 : Math.min(changeAt - 0.05, at + step + 0.12),
        resolveAt: changeAt + 0.6 + j * 0.04,
      });
    });
  });
  shots.push(resultShot);
  segments.push({ kind: "result", shot: shots.length - 1, t0: resultAt, t1: endCard });
  segments.sort((a, b) => a.t0 - b.t0);

  return {
    kind: "reel",
    name: input.name,
    ...(prompt ? { prompt } : {}),
    shape: input.shape,
    view,
    theme: input.theme,
    assetBase: input.assetBase,
    boards,
    shots,
    segments,
    pieces,
    boardAt,
    lastAt,
    revisions,
    comments: sweep,
    times: { prompt: promptEnd, build: buildAt, endCard, duration },
  };
}
