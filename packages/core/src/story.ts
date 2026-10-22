import type { Op } from "./doc.ts";
import type { JournalEntry, OpEntry } from "./journal.ts";
import type { Range } from "./timelapse.ts";

/**
 * A timelapse as a short edit, not a replay. The journal becomes a handful
 * of moments: the agent's work on one board between two of your turns is one
 * moment, shown as its settled before and its settled after; your turn is one
 * moment, its comments landing one by one. Then the film picks the moments
 * that tell the story best for its length, and gives each a shot: the camera
 * glides to it, settles, the change plays, it holds on the result, then moves
 * on. The camera never moves while something changes.
 *
 * Pure: what each moment looks like (how much changed, where) is measured by
 * the film page and passed in.
 */

/* ------------------------------------------------------------------ */
/* Moments                                                             */
/* ------------------------------------------------------------------ */

export interface CommentLanding {
  /** Index of the journal entry that created it. */
  entry: number;
  thread: string;
  board?: string;
  t: number;
  words: number;
}

export type Moment =
  | {
      kind: "work";
      /** The board the agent changed. */
      board: string;
      /** Journal index of the state before (the entry just before its first op). */
      before: number;
      /** Journal index of its last op: the settled after. */
      after: number;
      /** Real time of its first and last op. */
      from: number;
      to: number;
      ops: number;
      /** Journal indices of its ops, in order. */
      indices: number[];
      /** Threads this work resolved (their pins leave when it lands). */
      resolves: string[];
      /** Which of your turns it answers: the index of the comment round just before, if it commented on this board. */
      answers?: number;
      who: { name: string; client?: string };
    }
  | {
      kind: "turn";
      /** Your round of comments, in order. */
      comments: CommentLanding[];
      round: number;
      /** The comments that show their cards (in a short film, the ones whose fix is shown). */
      featured?: string[];
      from: number;
      to: number;
    }
  | {
      kind: "reply";
      entry: number;
      thread: string;
      board?: string;
      t: number;
    };

const leaves = (op: Op): Op[] => (op.op === "batch" ? op.ops.flatMap(leaves) : [op]);

function opText(op: Op): string {
  const c = leaves(op).find((o) => o.op === "thread.create");
  return c?.op === "thread.create" ? (c.thread.messages[0]?.text ?? "") : "";
}

/**
 * The session as moments. Each of your rounds of comments is a turn. Between
 * turns, the agent's work is grouped per board, in the order the agent first
 * touched each board, and each board's work is one moment: everything it did
 * there, as one change. Resolves ride along with the work on their board.
 */
export function moments(entries: JournalEntry[], range?: Range): Moment[] {
  const inRange = (e: JournalEntry) => !range || (e.t >= range.from && e.t <= range.to);
  const out: Moment[] = [];
  let round = -1;
  let open: Map<string, Extract<Moment, { kind: "work" }>> = new Map();
  let turn: Extract<Moment, { kind: "turn" }> | null = null;
  let asked = new Map<string, number>();
  const threadBoard = new Map<string, string | undefined>();
  const flushWork = () => {
    for (const w of open.values()) out.push(w);
    open = new Map();
  };
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.kind !== "op" || !inRange(e)) continue;
    const ls = leaves(e.op);
    const create = ls.find((o) => o.op === "thread.create");
    if (create?.op === "thread.create") threadBoard.set(create.thread.id, create.thread.artboardId);
    if (create?.op === "thread.create" && e.origin.kind === "user") {
      // Your turn: the agent's work so far is done; a new round starts unless one is open.
      if (!turn) {
        flushWork();
        round++;
        asked = new Map();
        turn = { kind: "turn", comments: [], round, from: e.t, to: e.t };
        out.push(turn);
      }
      turn.comments.push({
        entry: i,
        thread: create.thread.id,
        board: create.thread.artboardId,
        t: e.t,
        words: opText(e.op).split(/\s+/).filter(Boolean).length,
      });
      turn.to = e.t;
      if (create.thread.artboardId) asked.set(create.thread.artboardId, round);
      continue;
    }
    if (e.origin.kind !== "user" && e.origin.kind !== "agent") continue;
    // Anything else ends your turn.
    if (e.origin.kind === "agent" || e.artboards.length) turn = null;
    if (e.origin.kind === "agent" && ls.some((o) => o.op === "thread.message") && !create) {
      const msg = ls.find((o) => o.op === "thread.message");
      if (msg?.op === "thread.message")
        out.push({
          kind: "reply",
          entry: i,
          thread: msg.id,
          board: threadBoard.get(msg.id),
          t: e.t,
        });
      continue;
    }
    const resolved = ls
      .filter((o) => o.op === "thread.update" && o.status === "resolved")
      .map((o) => (o as { id: string }).id);
    if (resolved.length && !e.artboards.length) {
      // A resolve on its own joins the work on its board, or the latest work.
      for (const id of resolved) {
        const b = threadBoard.get(id);
        const w = (b && open.get(b)) ?? [...open.values()].at(-1);
        if (w) w.resolves.push(id);
        else
          out.push({
            kind: "work",
            board: b ?? "",
            before: i - 1,
            after: i,
            from: e.t,
            to: e.t,
            ops: 0,
            indices: [],
            resolves: [id],
            who: { name: e.origin.name, client: (e.origin as { client?: string }).client },
          });
      }
      continue;
    }
    // A token change shows on the boards that use it: it joins the latest work, whose after includes it.
    if (!e.artboards.length && ls.some((o) => o.op === "tokens")) {
      const w = [...open.values()].at(-1);
      if (w) {
        w.after = i;
        w.to = e.t;
        w.indices.push(i);
      }
      continue;
    }
    for (const board of e.artboards) {
      let w = open.get(board);
      if (!w) {
        w = {
          kind: "work",
          board,
          before: i - 1,
          after: i,
          from: e.t,
          to: e.t,
          ops: 0,
          indices: [],
          resolves: [],
          ...(asked.has(board) ? { answers: asked.get(board) } : {}),
          who: { name: e.origin.name, client: (e.origin as { client?: string }).client },
        };
        open.set(board, w);
      }
      w.after = i;
      w.to = e.t;
      w.ops++;
      w.indices.push(i);
      for (const id of resolved) w.resolves.push(id);
    }
  }
  flushWork();
  // Work keeps the order the agent first touched each board within its stretch.
  return out;
}

/* ------------------------------------------------------------------ */
/* Choosing the story                                                  */
/* ------------------------------------------------------------------ */

/** What the film page measured about a work moment. */
export interface Look {
  /** How much changed on screen, 0–1 of the board's area (rendered layout diff). */
  change: number;
}

export interface StoryOptions {
  length: number;
  /** The film opens on what the person asked for. */
  prompt?: boolean;
}

/** Seconds per kind of shot. */
export const SHOT = {
  /** Glide between subjects. */
  travel: 0.95 as number,
  /** Settle on the subject before anything changes: long enough to see the before. */
  settle: 0.45,
  /** The change itself: pieces rising in. */
  change: 0.9,
  /** Hold on the result. */
  hold: 0.65,
  /** A comment landing, read. */
  comment: 1.35,
  /** The end card: long enough to read ponzu.design. */
  end: 2.1,
  /** The last look at the result: a short glide, then a still hold. */
  result: 2.2,
  /** The first frame, before anything moves. */
  open: 0.25 as number,
  /** The opening build: the board filling in, write by write, compressed. */
  build: 4.2 as number,
  /** A short film's opening build. */
  buildShort: 2.4 as number,
  /** The prompt the film opens on, typed into the agent's chat and sent, then a beat of the agent. */
  prompt: 2.9 as number,
};

/**
 * How a comment arrives, in seconds: the cursor comes to its spot, clicks and the pin springs in,
 * then the card opens out of the pin and the words type themselves in.
 */
export const COMMENT_IN = { cursor: 0.55, click: 0.12, open: 0.28 };

/** How long a comment's words take to type in: brisk, never a crawl. */
export function typeTime(words: number): number {
  return Math.min(1.4, Math.max(0.45, words * 0.06));
}

/** Time to read a comment: about a second, plus a quarter second per four words. */
export function commentTime(words: number, length: number): number {
  // About four words a second on a phone, plus a beat to find the card: a long note gets its read.
  const base = Math.min(5.2, Math.max(1.8, 0.8 + words * 0.125));
  return length <= 15 ? Math.min(4.6, base) : base;
}

/** A card's whole stay: arriving, typing, then read. */
export function cardTime(words: number, length: number): number {
  const arrive = COMMENT_IN.cursor + COMMENT_IN.click + COMMENT_IN.open;
  // A short film can't afford the whole arrival: the cursor's glide is shortened, never the read.
  // The words are read as they type in: the hold after is what's left of the read, and a beat.
  const typing = typeTime(words);
  const after = Math.max(1.2, commentTime(words, length) - typing * 0.8);
  return (length <= 15 ? arrive * 0.75 : arrive) + typing + after;
}

/**
 * The moments to show, in order: stories, each a turn of your comments and the
 * fixes that answer them, shown at rest. A comment is read out only when its
 * fix is in the film (others land as pins); a fix is in the film only when it
 * answers a comment that's read out or it's the opening build. Your first story
 * always; then more, while they fit, each whole. A 15s film is one story on one
 * board. Tiny changes never make the cut.
 */
export function chooseStory(all: Moment[], looks: Map<Moment, Look>, opts: StoryOptions): Moment[] {
  const short = opts.length <= 15;
  const budget = opts.length - SHOT.end - SHOT.result - SHOT.open - (opts.prompt ? SHOT.prompt : 0);
  const work = all.filter((m): m is Extract<Moment, { kind: "work" }> => m.kind === "work");
  const turns = all.filter((m): m is Extract<Moment, { kind: "turn" }> => m.kind === "turn");
  const visible = (m: Extract<Moment, { kind: "work" }>) => (looks.get(m)?.change ?? 0) >= 0.03;
  const score = (w: Extract<Moment, { kind: "work" }>) =>
    (looks.get(w)?.change ?? 0) * (w.answers !== undefined ? 2.5 : 1) + Math.min(0.3, w.ops * 0.01);
  const workCost = SHOT.travel + SHOT.settle + SHOT.change + SHOT.hold;
  // What the timeline will spend on it: the glide, a settle, each card read (a hop between
  // cards on different boards), the pin-only landings (none in a short film), a beat after.
  const turnCost = (t: Extract<Moment, { kind: "turn" }>, featured: CommentLanding[]) =>
    SHOT.travel +
    0.25 +
    featured.reduce((a, c) => a + cardTime(c.words, opts.length), 0) +
    Math.max(0, featured.length - 1) * 0.6 +
    (short ? 0 : (t.comments.length - featured.length) * 0.3);

  const picked = new Set<Moment>();
  const featured = new Map<Moment, string[]>();
  let spent = 0;

  // A story: the turn, and for each board it asks about (in the order asked), its fix.
  const story = (t: Extract<Moment, { kind: "turn" }>, maxBoards: number) => {
    const boards = [...new Set(t.comments.map((c) => c.board).filter(Boolean))] as string[];
    const fixes: Extract<Moment, { kind: "work" }>[] = [];
    for (const b of boards) {
      const w = work
        .filter((x) => x.answers === t.round && x.board === b && visible(x))
        .sort((x, y) => score(y) - score(x))[0];
      if (w) fixes.push(w);
      if (fixes.length >= maxBoards) break;
    }
    const paidBoards = new Set(fixes.map((w) => w.board));
    // One card per paid board: the first comment on it.
    const cards: CommentLanding[] = [];
    for (const c of t.comments)
      if (c.board && paidBoards.has(c.board) && !cards.some((x) => x.board === c.board))
        cards.push(c);
    return { fixes, cards };
  };

  const firstTurn = turns[0];
  // Opening: a build. A short film opens on the board its story is about.
  const before = firstTurn ? work.filter((w) => all.indexOf(w) < all.indexOf(firstTurn)) : work;
  const firstBoard = firstTurn?.comments[0]?.board;
  // Every film opens on the board its story is about, when that board was being built.
  const opening =
    (firstBoard ? before.filter((w) => w.board === firstBoard && visible(w)).at(-1) : undefined) ??
    [...before].filter(visible).sort((a, b) => score(b) - score(a))[0];
  const buildCost = short ? SHOT.buildShort : SHOT.build;
  if (opening) {
    picked.add(opening);
    spent += SHOT.settle + buildCost + SHOT.hold;
  }

  const takeStory = (
    t: Extract<Moment, { kind: "turn" }>,
    maxBoards: number,
    must = false,
  ): boolean => {
    let { fixes, cards } = story(t, maxBoards);
    // Shrink until it fits: fewer boards, never a card without its fix. The first story is the
    // film: down to one board it stays, and the timeline tightens around it.
    while (fixes.length > (must ? 1 : 0)) {
      const cost = turnCost(t, cards) + fixes.length * workCost;
      if (spent + cost <= budget + 1e-9) break;
      fixes = fixes.slice(0, -1);
      const paid = new Set(fixes.map((w) => w.board));
      cards = cards.filter((c) => c.board && paid.has(c.board));
    }
    if (!fixes.length) return false;
    picked.add(t);
    featured.set(
      t,
      cards.map((c) => c.thread),
    );
    for (const w of fixes) picked.add(w);
    spent += turnCost(t, cards) + fixes.length * workCost;
    return true;
  };

  if (firstTurn) takeStory(firstTurn, short ? 1 : 3, true);
  if (!short) for (const t of turns.slice(1)) if (!takeStory(t, 3)) break;
  // Leftover room in a long film: one more build before the first turn, if it's big; the rest
  // of the room goes to reading and holds, not a long tour before the story starts.
  if (!short)
    for (const w of before
      .filter((x) => !picked.has(x) && visible(x) && (looks.get(x)?.change ?? 0) >= 0.2)
      .sort((a, b) => score(b) - score(a))
      .slice(0, 0))
      if (spent + workCost <= budget) {
        picked.add(w);
        spent += workCost;
      }

  const out = all
    .filter((m) => picked.has(m))
    .map((m) => (m.kind === "turn" ? { ...m, featured: featured.get(m) ?? [] } : m));
  // One question, one answer: a turn with several cards read out becomes a beat per card, each
  // followed straight away by its fix, in the order asked. The viewer never holds a comment in
  // mind while another is read. (Pins for the rest of the turn land with the first card.)
  const told: Moment[] = [];
  for (let i = 0; i < out.length; i++) {
    const t = out[i]!;
    if (t.kind !== "turn") {
      told.push(t);
      continue;
    }
    let j = i + 1;
    while (j < out.length && out[j]!.kind === "work") j++;
    const fixes = out.slice(i + 1, j) as Extract<Moment, { kind: "work" }>[];
    const cards = t.comments.filter((c) => t.featured?.includes(c.thread));
    const used = new Set<Moment>();
    cards.forEach((c, n) => {
      const others = n === 0 ? t.comments.filter((x) => !t.featured?.includes(x.thread)) : [];
      told.push({ ...t, comments: [...others, c], featured: [c.thread] });
      const fix = fixes.find((w) => !used.has(w) && w.board === c.board);
      if (fix) {
        used.add(fix);
        told.push(fix);
      }
    });
    if (!cards.length) told.push(t);
    for (const w of fixes) if (!used.has(w)) told.push(w);
    i = j - 1;
  }
  return told;
}

/* ------------------------------------------------------------------ */
/* The timeline                                                        */
/* ------------------------------------------------------------------ */

export type Phase =
  /** The camera gliding to the shot's frame; nothing changes. */
  | "travel"
  /** Settled, before the change. */
  | "settle"
  /** The change playing. */
  | "change"
  /** Holding on the result. */
  | "hold"
  /** A comment landing and being read. */
  | "comment"
  /** The last look at the result. */
  | "result"
  | "end";

export interface StoryShot {
  moment: Moment;
  /** Film time this shot starts (its travel), and the phases after. */
  start: number;
  arrive: number;
  /** When the change starts and ends (work), or each comment lands (turn). */
  change: number;
  changed: number;
  end: number;
  /**
   * For a turn: when each comment lands and how long it's read, which land as
   * pins only, and which need the camera to move first (it moves just before `at`).
   */
  landings?: { comment: CommentLanding; at: number; until: number; card: boolean; hop: boolean }[];
}

export interface Timeline {
  /** The prompt the film opens on, from the start until this. */
  prompt?: { start: number; end: number };
  shots: StoryShot[];
  /** When the camera leaves for the last look at the result. */
  result: number;
  /** When the end card starts. */
  endCard: number;
  duration: number;
}

/**
 * Lays the chosen moments out in time. Every shot: glide there, settle, the
 * change plays, hold. A turn: glide there, then each comment lands and is read
 * (a short film shows two cards; the rest land as pins). Leftover time is
 * shared out as longer holds, so the film is exactly `length` seconds.
 */
export function timeline(
  story: Moment[],
  opts: StoryOptions & {
    /** Per turn: which landings need the camera to move first (their comment is elsewhere). */
    hops?: Map<Moment, boolean[]>;
  },
): Timeline {
  const HOP = 0.9;
  const raw = story.map((m) => {
    if (m.kind === "turn") {
      const cards = opts.length <= 15 ? 2 : 4;
      const hops = opts.hops?.get(m) ?? [];
      const featured = m.featured ?? m.comments.slice(0, cards).map((c) => c.thread);
      // Pin-only comments land first, quickly, wherever the camera is; the comments read out come
      // last, so the fix follows the card straight away.
      // A short film tells one comment's story: the others don't land at all.
      const order = [
        ...m.comments
          .map((c, i) => ({ c, i }))
          .filter((x) => opts.length > 15 && !featured.includes(x.c.thread)),
        ...m.comments.map((c, i) => ({ c, i })).filter((x) => featured.includes(x.c.thread)),
      ];
      // A card on another board than the card before it: the camera glides there first.
      let lastCardBoard: string | undefined;
      const shown = order.map(({ c, i }, k) => {
        const card = featured.includes(c.thread);
        const hop =
          card &&
          k > 0 &&
          (lastCardBoard !== undefined ? c.board !== lastCardBoard : Boolean(hops[i]));
        if (card) lastCardBoard = c.board;
        return { comment: c, card, hop, d: card ? cardTime(c.words, opts.length) : 0.3 };
      });
      return {
        m,
        travel: SHOT.travel,
        settle: 0.15,
        change: shown.reduce((a, x) => a + x.d + (x.hop ? HOP : 0), 0),
        hold: 0.1,
        shown,
      };
    }
    return {
      m,
      travel: SHOT.travel,
      settle: SHOT.settle,
      change: SHOT.change,
      hold: SHOT.hold,
      shown: [] as { comment: CommentLanding; card: boolean; hop: boolean; d: number }[],
    };
  });
  if (raw[0]) raw[0].travel = 0;
  // The opening build is the first act: the board filling in, write by write.
  const first = raw[0];
  if (first && first.m.kind === "work" && first.m.answers === undefined) {
    // Straight from the prompt into the first pieces: no beat of empty canvas.
    first.settle = 0;
    first.change = opts.length <= 15 ? SHOT.buildShort : SHOT.build;
  }
  const lead = opts.prompt ? SHOT.prompt : 0;
  const fixed = SHOT.open + lead + SHOT.result + SHOT.end;
  const room = Math.max(1, opts.length - fixed);
  const used = raw.reduce((a, r) => a + r.travel + r.settle + r.change + r.hold, 0);
  if (used > room) {
    // Over: everything a little quicker, alike (the story was chosen to fit, so this is small).
    const k = room / used;
    for (const r of raw) {
      r.travel *= k;
      r.settle *= k;
      r.change *= k;
      r.hold *= k;
      for (const x of r.shown) x.d *= k;
    }
  } else {
    // Spare time: a longer look at each result (never a long still), a calmer change, and
    // longer reads of the cards; what's left goes to the last look at the result.
    let spare = room - used;
    // The build is the magic: it takes spare time first, up to a calm pace for its length.
    if (first && first.m.kind === "work" && first.m.answers === undefined) {
      const most = opts.length <= 15 ? 4.6 : opts.length <= 30 ? 11 : 20;
      const extra = Math.max(0, Math.min(spare, most - first.change));
      first.change += extra;
      spare -= extra;
    }
    const works = raw.filter((r) => r.m.kind === "work" && r !== first);
    const turns = raw.filter((r) => r.m.kind === "turn");
    const cards = turns.flatMap((r) => r.shown.filter((x) => x.card));
    for (let pass = 0; pass < 3 && spare > 0.05; pass++) {
      // A card reads at its pace and no longer; slack goes to seeing the answers.
      const cardShare = 0;
      const slots = works.length * 2 + cards.length * cardShare;
      if (!slots) break;
      const each = spare / slots;
      let usedNow = 0;
      for (const r of works) {
        // A short film's opening build is a beat, not a hold: its time goes to the story.
        if (opts.length <= 15 && r.m.kind === "work" && r.m.answers === undefined) continue;
        const h = Math.max(0, Math.min(each * 2 * 0.6, (opts.length <= 15 ? 2.4 : 2) - r.hold));
        const c = Math.max(0, Math.min(each * 2 * 0.4, 2.2 - r.change));
        r.hold += h;
        r.change += c;
        usedNow += h + c;
      }
      for (const r of turns)
        for (const x of r.shown) {
          if (!x.card) continue;
          // A long comment reads at its own pace: cards take their share first in a short film.
          const d = Math.max(
            0,
            Math.min(each * cardShare, Math.min(11, cardTime(x.comment.words, 60) * 1.15) - x.d),
          );
          x.d += d;
          r.change += d;
          usedNow += d;
        }
      spare -= usedNow;
      if (usedNow < 0.01) break;
    }
  }
  const shots: StoryShot[] = [];
  let t = SHOT.open + lead;
  for (const r of raw) {
    const start = t;
    const arrive = start + r.travel;
    const change = arrive + r.settle;
    const changed = change + r.change;
    const end = changed + r.hold;
    let landings: StoryShot["landings"];
    if (r.m.kind === "turn") {
      let at = change;
      const scale = r.shown.length
        ? r.change / r.shown.reduce((a, x) => a + x.d + (x.hop ? HOP : 0), 0)
        : 1;
      landings = r.shown.map((x) => {
        if (x.hop) at += HOP * scale;
        const l = { comment: x.comment, at, until: at + x.d * scale, card: x.card, hop: x.hop };
        at += x.d * scale;
        return l;
      });
    }
    shots.push({
      moment: r.m,
      start,
      arrive,
      change,
      changed,
      end,
      ...(landings ? { landings } : {}),
    });
    t = end;
  }
  const result = t;
  const endCard = Math.max(result + SHOT.result, opts.length - SHOT.end);
  return {
    ...(lead ? { prompt: { start: 0, end: SHOT.open + lead } } : {}),
    shots,
    result,
    endCard,
    duration: endCard + SHOT.end,
  };
}

/** The shot at film time `f`, and where in it. */
export function shotAt(tl: Timeline, f: number): { index: number; phase: Phase } {
  if (f >= tl.endCard) return { index: tl.shots.length - 1, phase: "end" };
  if (f >= tl.result) return { index: tl.shots.length - 1, phase: "result" };
  let i = 0;
  while (i + 1 < tl.shots.length && tl.shots[i + 1]!.start <= f) i++;
  const s = tl.shots[i];
  if (!s) return { index: -1, phase: "result" };
  const phase: Phase =
    f < s.arrive
      ? "travel"
      : s.moment.kind === "turn" && f >= s.change && f < s.changed
        ? "comment"
        : f < s.change
          ? "settle"
          : f < s.changed
            ? "change"
            : "hold";
  return { index: i, phase };
}

/** Real time at film time `f`, for a track's playhead. */
export function realTimeOf(tl: Timeline, f: number): number | null {
  const s = tl.shots[shotAt(tl, f).index];
  if (!s) return null;
  const m = s.moment;
  if (m.kind === "work") return f < s.change ? m.from : m.to;
  if (m.kind === "turn") {
    const l = s.landings?.filter((x) => x.at <= f).at(-1);
    return l ? l.comment.t : m.from;
  }
  return m.t;
}

export type { OpEntry };
