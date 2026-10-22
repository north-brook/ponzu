import {
  type Artboard,
  avoidCuts,
  type Cam,
  type CommentLanding,
  chooseStory,
  type Doc,
  type FilmShape,
  filmViewport,
  findArtboard,
  findNode,
  frameFocus,
  framingFor,
  type JournalEntry,
  type Look,
  type Moment,
  moments,
  noteBoards,
  type Range,
  type Rect,
  replayTo,
  type StoryShot,
  streamUnits,
  type Thread,
  type Timeline,
  timeline,
  tryApply,
} from "@ponzu/core";
import { artboardMarkup, artboardSize, loadArtboardFonts } from "@ponzu/react";
import { schemeFor, settleAssets } from "./model.ts";

/**
 * A film as an edit: the chosen moments, each with the canvas as it stands
 * before and after it (settled states only, never the ops between), where
 * its change sits, and a resting camera for it that never cuts a line of
 * text. Frames are pure functions of film time over this.
 */
export interface Edit {
  name: string;
  shape: FilmShape;
  view: { w: number; h: number; scale: number };
  theme: "light" | "dark";
  assetBase?: string;
  timeline: Timeline;
  /** Per shot: what the canvas shows, and how it gets there. */
  scenes: Scene[];
  /** The last look at the result. */
  /** `boards`: what the last look is of; the rest of the canvas fades away for it. */
  result: { doc: Doc; cam: Cam; heights: Map<string, number>; boards: string[] };
  /** Boards to keep out of every frame (the agent's notes stay, but quietly). */
  first: { doc: Doc; heights: Map<string, number> };
  /** For a track: the real span, and the real times of your comments. */
  range: Range | null;
  ticks: number[];
  /** Film times your comments land at, for a track drawn on the film's clock. */
  filmTicks: number[];
}

export interface Scene {
  /** For a turn: per landing, the board its comment is on (a tall frame dims the others). */
  subjectBoards?: string[][];
  shot: StoryShot;
  /** The canvas before this shot's change, and after it. */
  before: Doc;
  after: Doc;
  heights: { before: Map<string, number>; after: Map<string, number> };
  /** Where the camera rests for this shot. For a turn, one per landing (it hops between). */
  cams: Cam[];
  /** Work: the board that changes, its new pieces (rise in) and its restyled ones (cut). */
  board?: string;
  rise?: string[];
  /** Work: a board that's new in this shot (it's drawn in). */
  born?: boolean;
  /** Pins that leave as this work lands. */
  resolves?: string[];
  /** Turn: the threads as they stand once each comment has landed. */
  threads?: Thread[][];
  /** Turn: what each comment is about, on the canvas (its card keeps clear of it). */
  subjects?: Rect[];
  who?: { name: string; client?: string };
}

export interface EditInput {
  name: string;
  entries: JournalEntry[];
  shape: FilmShape;
  length: number;
  range?: Range;
  theme: "light" | "dark";
  assetBase?: string;
  /** The wayfinding line's box in the film's px (the film page measures it). */
  pill?: Rect;
}

/* ------------------------------------------------------------------ */
/* Measuring                                                           */
/* ------------------------------------------------------------------ */

type Host = { wrap: HTMLDivElement; shadow: ShadowRoot; html: string };

/** Lays boards out offscreen as the film draws them, to measure them. */
class Lab {
  private root: HTMLDivElement;
  private hosts: Host[] = [];
  private next = 0;
  /** Boxes the last diff found taken away (in the before layout). */
  removed: Rect[] = [];

  constructor(
    private assetBase: string | undefined,
    private theme: "light" | "dark",
  ) {
    this.root = document.createElement("div");
    this.root.style.cssText =
      "position:fixed;left:0;top:0;width:0;height:0;overflow:visible;visibility:hidden;pointer-events:none;contain:layout";
    document.body.appendChild(this.root);
  }

  /** A board laid out in its own host (two of these can be compared). */
  async show(doc: Doc, ab: Artboard, slot = 0): Promise<Host> {
    while (this.hosts.length <= slot) {
      const wrap = document.createElement("div");
      wrap.style.cssText = "position:absolute;left:0;top:0";
      const host = document.createElement("div");
      host.style.display = "contents";
      wrap.appendChild(host);
      this.root.appendChild(wrap);
      this.hosts.push({ wrap, shadow: host.attachShadow({ mode: "open" }), html: "" });
    }
    const h = this.hosts[slot]!;
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
    void this.next;
    return h;
  }

  height(h: Host): number {
    return h.wrap.getBoundingClientRect().height;
  }

  box(h: Host, id: string): Rect | null {
    const el = h.shadow.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!el) return null;
    const b = h.wrap.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    return { x: r.left - b.left, y: r.top - b.top, w: r.width, h: r.height };
  }

  /** Lines of text on the board, in board px. */
  texts(h: Host): Rect[] {
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
      if (out.length > 800) break;
    }
    return out;
  }

  /**
   * What looks different between two layouts of a board: the boxes of
   * elements that are new, gone, moved, resized or restyled, by data-id.
   */
  diff(a: Host, b: Host): Rect[] {
    this.removed = [];
    const boxes = (h: Host) => {
      const base = h.wrap.getBoundingClientRect();
      const m = new Map<string, { r: Rect; sig: string }>();
      for (const el of h.shadow.querySelectorAll<HTMLElement>("[data-id]")) {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        const own = [...el.childNodes]
          .filter((c) => c.nodeType === 3)
          .map((c) => c.textContent)
          .join("");
        const cs = getComputedStyle(el);
        const sig = `${own}|${cs.color}|${cs.backgroundColor}|${cs.fontSize}|${cs.fontWeight}|${cs.backgroundImage.slice(0, 80)}|${cs.fill}|${cs.stroke}|${cs.transform}|${el.getAttribute("src") ?? ""}|${el.getAttribute("d") ?? ""}|${el.getAttribute("points") ?? ""}`;
        m.set(el.dataset.id!, {
          r: { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height },
          sig,
        });
      }
      return m;
    };
    const A = boxes(a);
    const B = boxes(b);
    const out: Rect[] = [];
    for (const [id, nb] of B) {
      const na = A.get(id);
      if (!na) out.push(nb.r);
      else if (
        na.sig !== nb.sig ||
        Math.abs(na.r.x - nb.r.x) > 2 ||
        Math.abs(na.r.y - nb.r.y) > 2 ||
        Math.abs(na.r.w - nb.r.w) > 2 ||
        Math.abs(na.r.h - nb.r.h) > 2
      )
        out.push(nb.r);
    }
    for (const [id, na] of A)
      if (!B.has(id)) {
        out.push(na.r);
        this.removed.push(na.r);
      }
    // Keep the leaves: a container counts only when nothing inside it does.
    return out.filter(
      (r) =>
        !out.some(
          (o) =>
            o !== r &&
            o.x >= r.x - 1 &&
            o.y >= r.y - 1 &&
            o.x + o.w <= r.x + r.w + 1 &&
            o.y + o.h <= r.y + r.h + 1 &&
            o.w * o.h < r.w * r.h,
        ),
    );
  }

  dispose() {
    this.root.remove();
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
const area = (rects: Rect[]) => rects.reduce((a, r) => a + r.w * r.h, 0);
const overlap = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
const offset = (r: Rect, ab: Artboard): Rect => ({ x: ab.x + r.x, y: ab.y + r.y, w: r.w, h: r.h });

/** The corner wayfinding line's box in film px: slice, file name, page name, as Film draws it. */
function measurePill(input: EditInput, view: { w: number; h: number }): Rect {
  const k = view.w < view.h ? 1.08 : 1;
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.font = `500 ${12.5 * k}px Inter, system-ui, sans-serif`;
  const page = (() => {
    for (let i = input.entries.length - 1; i >= 0; i--) {
      const e = input.entries[i]!;
      if (e.kind === "checkpoint") return e.doc.pages[0]?.name ?? "";
    }
    return "";
  })();
  const pages = new Set<string>([page]);
  for (const e of input.entries)
    if (e.kind === "op" && e.op.op === "page.create") pages.add(e.op.page.name);
  const longest = Math.max(...[...pages].map((p) => ctx.measureText(p).width), 0);
  const w =
    20 * k +
    14 * k +
    7 * k * 4 +
    2 * ctx.measureText("/").width +
    13 * k * 2 +
    6 * 2 +
    ctx.measureText(input.name).width +
    longest;
  return { x: 14, y: 14, w: Math.ceil(w), h: Math.ceil(12 * k + 14 * k) };
}

/* ------------------------------------------------------------------ */
/* Building the edit                                                   */
/* ------------------------------------------------------------------ */

export async function buildEdit(input: EditInput): Promise<Edit> {
  const { entries } = input;
  const view = filmViewport(input.shape);
  // The wayfinding line's box: measured off the real font, as the film draws it.
  const pill = input.pill ?? measurePill(input, view);
  const framing = { ...framingFor(input.shape), pill };
  // A work shot also keeps clear of the agent's badge, top right (its width is the board's name).
  const badgeFor = (name: string) => {
    const k = view.w < view.h ? 1.08 : 1;
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.font = `400 ${12.5 * k}px Inter, system-ui, sans-serif`;
    const w = Math.min(view.w * 0.42, ctx.measureText(name).width + 20 * k + 16 * k + 6);
    return { x: view.w - 14 - w, y: 14, w, h: Math.ceil(12 * k + 14 * k) };
  };
  const lab = new Lab(input.assetBase, input.theme);
  const all = moments(entries, input.range);
  const notes = noteBoards(entries);

  // Docs at any journal index, replayed incrementally (indices only go forward per pass).
  const docAt = (() => {
    const cache = new Map<number, Doc>();
    return (i: number): Doc => {
      const hit = cache.get(i);
      if (hit) return structuredClone(hit);
      const doc = replayTo(entries, i) ?? {
        name: input.name,
        pages: [],
        tokens: "",
        threads: [],
        notes: {},
      };
      cache.set(i, doc);
      return structuredClone(doc);
    };
  })();

  // What each comment is about, in its board's px: the node it's pinned to, else around the pin.
  const askedSubjects = new Map<string, Rect[]>();
  const threadSubject = new Map<string, Rect>();
  const threadPin = new Map<string, { x: number; y: number }>();
  for (const m of all) {
    if (m.kind !== "turn") continue;
    for (const c of m.comments) {
      if (!c.board) continue;
      const d = docAt(c.entry);
      const ab = findArtboard(d, c.board)?.artboard;
      const t = d.threads.find((x) => x.id === c.thread);
      if (!ab || !t) continue;
      let r: Rect = { x: t.x - 90, y: t.y - 60, w: 180, h: 120 };
      if (t.nodeId) {
        const box = lab.box(await lab.show(d, ab, 2), t.nodeId);
        if (box) r = box;
      }
      askedSubjects.set(c.board, [...(askedSubjects.get(c.board) ?? []), r]);
      threadSubject.set(c.thread, r);
      threadPin.set(c.thread, { x: t.x, y: t.y });
    }
  }

  // The settled look of each work moment: the board before its first op, and after its last.
  const looks = new Map<Moment, Look>();
  const measured = new Map<Moment, { changed: Rect[]; removed: Rect[]; before: Doc; after: Doc }>();
  for (const m of all) {
    if (m.kind !== "work" || !m.board || notes.has(m.board)) {
      looks.set(m, { change: 0 });
      continue;
    }
    const before = docAt(m.before);
    const after = docAt(m.after);
    const abA = findArtboard(after, m.board)?.artboard;
    if (!abA) {
      looks.set(m, { change: 0 });
      continue;
    }
    const abB = findArtboard(before, m.board)?.artboard;
    const hA = await lab.show(after, abA, 1);
    const boardArea = artboardSize(abA).w * (lab.height(hA) || 900);
    let changed: Rect[];
    let removed: Rect[] = [];
    if (abB) {
      const hB = await lab.show(before, abB, 0);
      changed = lab.diff(hB, hA);
      removed = lab.removed;
    } else changed = [{ x: 0, y: 0, w: artboardSize(abA).w, h: lab.height(hA) }];
    // How much of the board the change touches: the region it spans counts, not just the pixels
    // of the leaves (a redrawn mark is a few thin paths, but it's the whole mark that changed).
    const span = union(changed);
    let change = Math.min(
      1,
      Math.max(area(changed), span ? span.w * span.h * 0.6 : 0) / Math.max(1, boardArea),
    );
    // A fix to something you commented on counts by what the comment is about, however few
    // pixels move: a colour, an icon, a label are the answer.
    const asked = askedSubjects.get(m.board) ?? [];
    const answersAsked = changed.some((r) => asked.some((a) => overlap(r, a) > 0));
    if (m.answers !== undefined && answersAsked) change = Math.max(change, 0.12);
    looks.set(m, { change });
    measured.set(m, { changed, removed, before, after });
  }

  const story = chooseStory(all, looks, { length: input.length });
  (window as unknown as { __looks?: unknown }).__looks = all.map((m) =>
    m.kind === "work"
      ? `work ${m.board} ops${m.ops} ${m.answers ?? "-"} change=${(looks.get(m)?.change ?? 0).toFixed(3)} ${story.includes(m) ? "*" : ""}`
      : `${m.kind} ${story.includes(m) ? "*" : ""}`,
  );
  // Hops: a comment on a board the turn's frame doesn't show needs the camera to move.
  const lastDoc = docAt(entries.length - 1);
  const hops = new Map<Moment, boolean[]>();
  const turnFrames = new Map<Moment, Rect[]>();
  for (const m of story) {
    if (m.kind !== "turn") continue;
    const rects = m.comments.map((c) => {
      const ab = c.board ? findArtboard(lastDoc, c.board)?.artboard : undefined;
      return ab ? { x: ab.x, y: ab.y, w: artboardSize(ab).w, h: artboardSize(ab).h ?? 900 } : null;
    });
    turnFrames.set(
      m,
      rects.filter((r): r is Rect => Boolean(r)),
    );
    hops.set(
      m,
      m.comments.map((c, i) => i > 0 && c.board !== m.comments[i - 1]!.board),
    );
  }
  const tl = timeline(story, { length: input.length, hops });

  // The canvas as each shot sees it. Between shots the canvas jumps to the next shot's before:
  // what happened off screen (build-up that didn't make the cut) is simply there.
  const scenes: Scene[] = [];
  const heightsOf = async (doc: Doc): Promise<Map<string, number>> => {
    const out = new Map<string, number>();
    for (const p of doc.pages)
      for (const ab of p.artboards) {
        const fixed = artboardSize(ab).h;
        out.set(ab.id, fixed ?? lab.height(await lab.show(doc, ab, 2)));
      }
    return out;
  };
  const textsOf = async (doc: Doc, abs: Artboard[]): Promise<Rect[]> => {
    const out: Rect[] = [];
    for (const ab of abs)
      for (const r of lab.texts(await lab.show(doc, ab, 2))) out.push(offset(r, ab));
    return out;
  };
  const boardRect = (ab: Artboard, heights: Map<string, number>): Rect => ({
    x: ab.x,
    y: ab.y,
    w: artboardSize(ab).w,
    h: heights.get(ab.id) ?? artboardSize(ab).h ?? 900,
  });
  const pageBoards = (doc: Doc, id: string) =>
    findArtboard(doc, id)?.page.artboards.filter((a) => !notes.has(a.id)) ?? [];

  // Continuity: what the viewer has seen of each board. A board keeps the look the film last
  // showed it with until the film shows it change; nothing reverts and nothing changes off cue.
  // Boards the film hasn't shown yet are taken as of the moment they first appear.
  const shown = new Map<string, Artboard>();
  const compose = (base: Doc, live: string[]): Doc => {
    const doc = structuredClone(base);
    for (const p of doc.pages)
      p.artboards = p.artboards.map((ab) =>
        !live.includes(ab.id) && shown.has(ab.id) ? structuredClone(shown.get(ab.id)!) : ab,
      );
    return doc;
  };
  // Only what the last shot showed: off screen between shots, a board may have moved on.
  const remember = (doc: Doc, cams: Cam[], heights: Map<string, number>) => {
    shown.clear();
    for (const p of doc.pages)
      for (const ab of p.artboards) {
        const r = boardRect(ab, heights);
        const seen = cams.some((c) => {
          if (c.page !== p.id) return false;
          const hw = view.w / 2 / c.zoom;
          const hh = view.h / 2 / c.zoom;
          return (
            r.x < c.cx + hw && r.x + r.w > c.cx - hw && r.y < c.cy + hh && r.y + r.h > c.cy - hh
          );
        });
        if (seen) shown.set(ab.id, structuredClone(ab));
      }
  };

  for (const [shotIndex, shot] of tl.shots.entries()) {
    const m = shot.moment;
    if (m.kind === "work") {
      const got = measured.get(m)!;
      // The film opens mid-build: the first shot starts with its board half made, not blank.
      // So does a board made in this shot: the camera arrives on it partly built, never on blank
      // canvas where it's about to be.
      const bornHere = !findArtboard(got.before, m.board);
      const partly =
        m.indices.length > 2 ? docAt(m.indices[Math.floor(m.indices.length * 0.55)]!) : null;
      const rawBefore =
        partly && (shotIndex === 0 || (bornHere && findArtboard(partly, m.board)))
          ? partly
          : got.before;
      const before = compose(rawBefore, [m.board]);
      const after = compose(got.after, [m.board]);
      const ab = findArtboard(after, m.board)!.artboard;
      const hB = await heightsOf(before);
      const hA = await heightsOf(after);
      // Frame: the board whole if it reads, else everything that changed, never cutting text.
      // A fix is framed on what it answers: the commented subject and the changes in it.
      // The comments read out in the turn this answers, on this board: the shot is about them.
      const turnOf = story.find(
        (x): x is Extract<Moment, { kind: "turn" }> => x.kind === "turn" && x.round === m.answers,
      );
      const readOut = (turnOf?.featured ?? [])
        .map((id) => turnOf!.comments.find((c) => c.thread === id))
        .filter((c) => c?.board === m.board)
        .map((c) => threadSubject.get(c!.thread))
        .filter((r): r is Rect => Boolean(r));
      const readOutPins = (turnOf?.featured ?? [])
        .map((id) => turnOf!.comments.find((c) => c.thread === id))
        .filter((c) => c?.board === m.board)
        .map((c) => threadPin.get(c!.thread))
        .filter((p): p is { x: number; y: number } => Boolean(p));
      const asked =
        m.answers === undefined
          ? []
          : readOut.length
            ? readOut
            : (askedSubjects.get(m.board) ?? []);
      // What answers it: changes in the subject, and new content right beside it ("add notes
      // under the scale" lands just below what was pinned).
      const near = (a: Rect) => {
        const m = Math.min(200, Math.max(60, a.h * 0.6));
        return { x: a.x - m, y: a.y - m, w: a.w + 2 * m, h: a.h + 2 * m };
      };
      const answering = got.changed.filter((r) => asked.some((a) => overlap(r, near(a)) > 0));
      const askedUnion = union(asked);
      // The opening is a build: frame the top of the board, at a working zoom (the board's
      // first screenful, where its headline is), not the whole board small.
      const opening = shotIndex === 0 && m.answers === undefined;
      const boardH = (await heightsOf(got.after)).get(m.board) ?? 900;
      // Its first screenful: in a tall frame, the column with the board's biggest type (the
      // headline), so it opens readable rather than the whole page small.
      const openAb = findArtboard(got.after, m.board)!.artboard;
      const bw = artboardSize(openAb).w;
      let openRect: Rect = { x: 0, y: 0, w: bw, h: Math.min(boardH, (bw * view.h) / view.w) };
      if (opening && view.h > view.w && bw > 700) {
        const host = await lab.show(got.after, openAb, 1);
        // Set across, not up the side (a rotated label reads as tall type).
        const top = lab.texts(host).filter((r) => r.y < 900 && r.w > r.h);
        const most = Math.max(0, ...top.map((r) => r.h));
        // The headline: the runs set in (near enough) the biggest type.
        const big = top.filter((r) => r.h >= most * 0.7);
        const head = union(big);
        if (head) {
          const w = Math.min(bw, Math.max(head.w + 96, 480));
          const x = Math.max(0, Math.min(bw - w, head.x + head.w / 2 - w / 2));
          openRect = { x, y: 0, w, h: Math.min(boardH, (w * view.h) / view.w) };
        }
      }
      const focusRects = opening
        ? [openRect]
        : answering.length
          ? [...answering, ...asked.filter((a) => answering.some((r) => overlap(r, near(a)) > 0))]
          : got.changed;
      const detail = union(focusRects.map((r) => offset(r, ab)));
      const neighbours = pageBoards(after, m.board);
      // The camera rests here on the before and on the after: neither may cut a line of the
      // board, and the boards around it as little as can be.
      const own = (doc: Doc) => {
        const b = findArtboard(doc, m.board)?.artboard;
        return b ? [b] : [];
      };
      const texts = [
        ...(await textsOf(after, own(after))),
        ...(await textsOf(before, own(before))),
      ];
      const context = await textsOf(
        after,
        neighbours.filter((n) => n.id !== m.board),
      );
      const cam = frameFocus(
        {
          page: findArtboard(after, m.board)!.page.id,
          board: boardRect(ab, hA),
          detail,
          parts: focusRects.map((r) => offset(r, ab)),
          texts,
          // A close look at an answer cuts the boards beside it at the edges; that's a close-up.
          context: answering.length ? [] : context,
          keep: detail,
          close: answering.length > 0,
          // Where the comment points: its pin (a whole section may be pinned; the pin says where).
          ...(answering.length && (readOutPins[0] ?? askedUnion)
            ? {
                anchor: readOutPins[0]
                  ? { x: ab.x + readOutPins[0].x, y: ab.y + readOutPins[0].y }
                  : {
                      x: ab.x + askedUnion!.x + askedUnion!.w / 2,
                      y: ab.y + askedUnion!.y + askedUnion!.h / 2,
                    },
              }
            : {}),
          key: m.board,
        },
        view,
        { ...framing, badge: badgeFor(ab.name) },
      );
      // What rises in: the new subtrees in the after state, opened into blocks.
      const hostA = await lab.show(after, ab, 1);
      const beforeAb = findArtboard(before, m.board)?.artboard;
      const fresh: string[] = [];
      const walk = (n: Artboard["root"]) => {
        for (const c of n.children) {
          if (c.kind !== "el") continue;
          if (!beforeAb || !findNode(beforeAb.root, c.id)) fresh.push(c.id);
          else walk(c);
        }
      };
      walk(ab.root);
      // New pieces rise in where there was nothing; a piece replacing something cuts in over it
      // (rising from nothing there would show a hole).
      const overlapsRemoved = (r: Rect) =>
        got.removed.some(
          (o) =>
            Math.max(0, Math.min(r.x + r.w, o.x + o.w) - Math.max(r.x, o.x)) *
              Math.max(0, Math.min(r.y + r.h, o.y + o.h) - Math.max(r.y, o.y)) >
            0.2 * Math.min(r.w * r.h, o.w * o.h),
        );
      const rise = streamUnits((id) => findNode(ab.root, id)?.node ?? null, fresh, 6, 16).filter(
        (id) => {
          const r = lab.box(hostA, id);
          return r && !overlapsRemoved(r);
        },
      );
      scenes.push({
        shot,
        before,
        after,
        heights: { before: hB, after: hA },
        cams: [cam],
        board: m.board,
        rise,
        born: !beforeAb && shotIndex > 0,
        resolves: m.resolves,
        who: m.who,
      });
      remember(after, [cam], hA);
      continue;
    }
    if (m.kind === "turn") {
      const before = compose(docAt(m.comments[0]!.entry - 1), []);
      const after = compose(docAt(m.comments[m.comments.length - 1]!.entry), []);
      const hA = await heightsOf(after);
      const threads: Thread[][] = [];
      const cams: Cam[] = [];
      const subjects: Rect[] = [];
      // Frame the turn's boards together when they read; else each comment's board in turn.
      const rects = turnFrames.get(m) ?? [];
      const all = union(rects.map((r) => ({ ...r, h: r.h })));
      const landingOrder = (shot.landings ?? []).map((l) => l.comment);
      for (const [i, c] of (landingOrder.length ? landingOrder : m.comments).entries()) {
        // Threads as they stand once this and every comment before it in the order has landed.
        const d = docAt(c.entry);
        const landedSoFar = new Set(
          (landingOrder.length ? landingOrder : m.comments).slice(0, i + 1).map((x) => x.thread),
        );
        const lastEntry = Math.max(...m.comments.map((x) => x.entry));
        threads.push(
          docAt(lastEntry).threads.filter(
            (t) => landedSoFar.has(t.id) || !m.comments.some((x) => x.thread === t.id),
          ),
        );
        const ab = c.board ? findArtboard(d, c.board)?.artboard : undefined;
        if (!ab) {
          cams.push(cams[i - 1] ?? { page: d.pages[0]?.id ?? "", cx: 0, cy: 0, zoom: 1 });
          subjects.push({ x: 0, y: 0, w: 0, h: 0 });
          continue;
        }
        const t = d.threads.find((x) => x.id === c.thread)!;
        const pin = { x: ab.x + t.x, y: ab.y + t.y };
        const host = await lab.show(d, ab, 2);
        const node = t.nodeId ? lab.box(host, t.nodeId) : null;
        const subjectOnly = node
          ? union([offset(node, ab), { x: pin.x - 16, y: pin.y - 16, w: 32, h: 32 }])!
          : { x: pin.x - 110, y: pin.y - 80, w: 220, h: 160 };
        subjects.push(subjectOnly);
        // Frame the subject with room for its card beside it (about 380×190 screen px): on the
        // side with more of the board, so the card lands on the board rather than off it.
        const cardW = 430 / framing.comfort;
        let roomRight = ab.x + artboardSize(ab).w - (subjectOnly.x + subjectOnly.w);
        let roomLeft = subjectOnly.x - ab.x;
        // A narrow board (a phone screen): the card goes in the open canvas beside it, on the
        // side with no board next to it, so it covers nothing.
        if (artboardSize(ab).w < cardW * 1.6) {
          const others = pageBoards(d, ab.id).filter((n) => n.id !== ab.id);
          const near = (x0: number, x1: number) =>
            others.some((n) => {
              const r = boardRect(n, hA);
              return r.x < x1 && r.x + r.w > x0 && r.y < ab.y + 900 && r.y + r.h > ab.y;
            });
          roomLeft = near(ab.x - cardW, ab.x) ? 0 : cardW * 2;
          roomRight = near(ab.x + artboardSize(ab).w, ab.x + artboardSize(ab).w + cardW)
            ? 0
            : cardW * 2;
        }
        const subject =
          view.w > view.h
            ? roomRight >= roomLeft
              ? { ...subjectOnly, w: subjectOnly.w + cardW }
              : { ...subjectOnly, x: subjectOnly.x - cardW, w: subjectOnly.w + cardW }
            : { ...subjectOnly, h: subjectOnly.h + 230 / framing.comfort };
        const texts = await textsOf(d, [ab]);
        const context = await textsOf(
          d,
          pageBoards(d, ab.id).filter((n) => n.id !== ab.id),
        );
        // A comment that lands as a pin only doesn't move the camera: it lands wherever the
        // camera is for the card read out (filled in below).
        const landing = shot.landings?.[i];
        if (landing && !landing.card && (shot.landings ?? []).some((l) => l.card)) {
          cams.push(null as unknown as Cam);
          continue;
        }
        const fitAll = all ? Math.min(view.w / all.w, view.h / all.h) : 0;
        const together = all && fitAll >= framing.comfort && rects.length > 1;
        const cam = frameFocus(
          together
            ? {
                page: findArtboard(d, ab.id)!.page.id,
                board: all!,
                overview: true,
                texts: [...texts, ...context],
              }
            : {
                page: findArtboard(d, ab.id)!.page.id,
                // A phone screen and the open canvas its card goes in, framed as one.
                board:
                  artboardSize(ab).w < cardW * 1.6 && view.w > view.h
                    ? union([boardRect(ab, hA), { ...subject, y: ab.y, h: 1 }])!
                    : boardRect(ab, hA),
                detail: subject,
                texts,
                context,
                keep: subjectOnly,
                pin,
                key: ab.id,
              },
          view,
          framing,
        );
        cams.push(cam);
      }
      // Pin-only landings take the camera of the first card read out.
      const firstCard = cams.find(Boolean);
      for (let k = 0; k < cams.length; k++) if (!cams[k]) cams[k] = firstCard ?? cams[0]!;
      remember(after, cams, hA);
      scenes.push({
        shot,
        before,
        after,
        heights: { before: hA, after: hA },
        cams,
        threads,
        subjects,
        subjectBoards: (landingOrder.length ? landingOrder : m.comments).map((c) =>
          c.board ? [c.board] : [],
        ),
      });
    }
  }

  // The result: the board the session was about, whole, readable.
  const endDoc = scenes.at(-1)?.after ?? lastDoc;
  const endHeights = await heightsOf(endDoc);
  const lastBoard =
    [...scenes].reverse().find((s) => s.board)?.board ??
    endDoc.pages.flatMap((p) => p.artboards)[0]?.id;
  // The board the film was about: of the fixes it showed, the biggest answer to a comment
  // (the payoff); a board that reads whole in this shape wins a close call.
  const reads = (id: string) => {
    const ab = findArtboard(endDoc, id)?.artboard;
    if (!ab) return false;
    const r = boardRect(ab, endHeights);
    return (
      Math.min((view.w - 2 * framing.pad) / r.w, (view.h - 2 * framing.pad - framing.top) / r.h) >=
      framing.minZoom
    );
  };
  // The first payoff is the heart of the film (the first comment, answered); then the biggest.
  const firstPaid = scenes.find(
    (sc) => sc.board && sc.shot.moment.kind === "work" && sc.shot.moment.answers !== undefined,
  );
  const candidates = scenes
    .filter((sc) => sc.board && sc.shot.moment.kind === "work" && !notes.has(sc.board))
    .map((sc) => {
      const m = sc.shot.moment as Extract<Moment, { kind: "work" }>;
      let v = (looks.get(m)?.change ?? 0) * (m.answers !== undefined ? 3 : 1);
      if (sc === firstPaid) v += 2;
      return { board: sc.board!, v: v * (reads(sc.board!) ? (view.h > view.w ? 3 : 1.6) : 1) };
    })
    .sort((x, y) => y.v - x.v);
  // The film ends where it left off: on the last fix shown, when it answered a comment (no cut
  // to another board in the last second); else on the biggest payoff.
  const lastScene = [...scenes].reverse().find((sc) => sc.board && sc.shot.moment.kind === "work");
  const lastPaid =
    lastScene && (lastScene.shot.moment as Extract<Moment, { kind: "work" }>).answers !== undefined
      ? lastScene
      : undefined;
  const hero = lastPaid?.board ?? candidates[0]?.board ?? lastBoard;
  const heroAb = hero ? findArtboard(endDoc, hero)?.artboard : undefined;
  const pageAll = heroAb
    ? union(pageBoards(endDoc, heroAb.id).map((ab) => boardRect(ab, endHeights)))
    : undefined;
  // A phone screen alone in a wide frame is a sliver: the result is the row of screens.
  const heroR = heroAb ? boardRect(heroAb, endHeights) : undefined;
  const narrowHero =
    heroR && input.length > 15 && heroR.w / heroR.h < (view.w / view.h) * 0.5 && pageAll;
  const readsTogether =
    narrowHero ||
    (pageAll &&
      Math.min(
        (view.w - 2 * framing.pad) / pageAll.w,
        (view.h - 2 * framing.pad - framing.top) / pageAll.h,
      ) >=
        framing.comfort * (view.h > view.w ? 1.1 : 0.95));
  const wholeCam = heroAb
    ? frameFocus(
        {
          page: findArtboard(endDoc, heroAb.id)!.page.id,
          board: readsTogether ? pageAll! : boardRect(heroAb, endHeights),
          overview: true,
          texts: await textsOf(endDoc, pageBoards(endDoc, heroAb.id)),
        },
        view,
        framing,
      )
    : { page: endDoc.pages[0]?.id ?? "", cx: 0, cy: 0, zoom: 1 };
  // When the whole board would be small (a desktop page in a tall frame, a short film's close
  // story), the last look stays on the payoff, close.
  const payoff = lastPaid ?? (firstPaid?.board === hero ? firstPaid : undefined);
  const payoffCam = payoff?.cams[0];
  // A long film pulls back to show the result whole, when whole still reads at all.
  const pullback =
    input.length > 15 && wholeCam.zoom >= framing.comfort * (view.h > view.w ? 0.5 : 0.6);
  const resultCam =
    !pullback && payoffCam && wholeCam.zoom < payoffCam.zoom * (input.length <= 15 ? 0.7 : 0.6)
      ? payoffCam
      : wholeCam;

  const firstDoc = scenes[0]?.before ?? endDoc;
  const firstHeights = await heightsOf(firstDoc);
  lab.dispose();

  const turnMoments = all.filter((m): m is Extract<Moment, { kind: "turn" }> => m.kind === "turn");
  const ticks = turnMoments.flatMap((m) => m.comments.map((c: CommentLanding) => c.t));
  const ops = entries.filter(
    (e) => e.kind === "op" && (!input.range || (e.t >= input.range.from && e.t <= input.range.to)),
  );
  return {
    name: input.name,
    shape: input.shape,
    view,
    theme: input.theme,
    assetBase: input.assetBase,
    timeline: tl,
    scenes,
    result: {
      doc: endDoc,
      cam: resultCam,
      heights: endHeights,
      boards: heroAb
        ? readsTogether && resultCam === wholeCam
          ? pageBoards(endDoc, heroAb.id).map((ab) => ab.id)
          : [heroAb.id]
        : [],
    },
    first: { doc: firstDoc, heights: firstHeights },
    range: ops.length ? { from: ops[0]!.t, to: ops[ops.length - 1]!.t } : null,
    ticks,
    filmTicks: tl.shots.flatMap((s) => s.landings?.map((l) => l.at) ?? []),
  };
}

/** Keeps `avoidCuts` reachable for callers that frame by hand. */
export { avoidCuts, tryApply };
