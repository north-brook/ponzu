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
}

/** Seconds per kind of shot. */
export const SHOT = {
  /** Glide between subjects. */
  travel: 0.75 as number,
  /** Settle on the subject before anything changes. */
  settle: 0.2,
  /** The change itself: pieces rising in. */
  change: 0.9,
  /** Hold on the result. */
  hold: 0.65,
  /** A comment landing, read. */
  comment: 1.35,
  /** The end card. */
  end: 1.6,
  /** The last look at the result. */
  result: 1.8,
  /** The first frame, before anything moves. */
  open: 0.25 as number,
};

/** Time to read a comment: about a second, plus a quarter second per four words. */
export function commentTime(words: number, length: number): number {
  const base = Math.min(2.9, Math.max(1.2, 0.6 + words * 0.075));
  return length <= 15 ? Math.min(2.4, base) : base;
}

/**
 * The moments to show, in order. Always your first turn and the work that
 * answers it; then as many more as fit, the biggest changes first, payoffs
 * before build-up. A 15s film is one turn of at most two comments and its
 * payoff. Tiny changes never make the cut.
 */
export function chooseStory(all: Moment[], looks: Map<Moment, Look>, opts: StoryOptions): Moment[] {
  const budget = opts.length - SHOT.end - SHOT.result - SHOT.open;
  const work = all.filter((m): m is Extract<Moment, { kind: "work" }> => m.kind === "work");
  const turns = all.filter((m): m is Extract<Moment, { kind: "turn" }> => m.kind === "turn");
  const shotCost = (m: Moment): number => {
    if (m.kind === "turn")
      return (
        SHOT.travel +
        m.comments
          .slice(0, opts.length <= 15 ? 2 : 4)
          .reduce((a, c) => a + commentTime(c.words, opts.length), 0)
      );
    if (m.kind === "reply") return 0;
    return SHOT.travel + SHOT.settle + SHOT.change + SHOT.hold;
  };
  const visible = (m: Extract<Moment, { kind: "work" }>) => (looks.get(m)?.change ?? 0) >= 0.03;
  const picked = new Set<Moment>();
  let spent = 0;
  const take = (m: Moment) => {
    if (picked.has(m)) return true;
    const c = shotCost(m);
    if (spent + c > budget + 1e-9) return false;
    picked.add(m);
    spent += c;
    return true;
  };
  // Opening: the biggest piece of work before your first turn (the film opens on it, mid-build).
  const firstTurn = turns[0];
  const before = firstTurn ? work.filter((w) => all.indexOf(w) < all.indexOf(firstTurn)) : work;
  // A short film is one story on one board: it opens on the board its first comment is about.
  const firstBoard = firstTurn?.comments[0]?.board;
  const opening =
    (opts.length <= 15 && firstBoard
      ? before.filter((w) => w.board === firstBoard && visible(w)).at(-1)
      : undefined) ?? [...before].filter(visible).sort((a, b) => score(b) - score(a))[0];
  function score(w: Extract<Moment, { kind: "work" }>) {
    const look = looks.get(w);
    return (look?.change ?? 0) * (w.answers !== undefined ? 2.5 : 1) + Math.min(0.3, w.ops * 0.01);
  }
  if (opening) take(opening);
  // Your first turn and its payoff.
  if (firstTurn) {
    take(firstTurn);
    // The payoff a short film shows is the fix to the first comment it reads out: the one
    // that starts the conversation. Otherwise the biggest.
    const firstAsked = firstTurn.comments[0]?.board;
    const payoff = work
      .filter((w) => w.answers === firstTurn.round && visible(w))
      .sort(
        (a, b) =>
          Number(b.board === firstAsked) - Number(a.board === firstAsked) || score(b) - score(a),
      );
    // A short film pays off the comments it reads out: the first two boards asked about.
    if (opts.length <= 15) {
      const asked = [...new Set(firstTurn.comments.map((c) => c.board))].slice(0, 1);
      for (const b of asked) {
        const w = payoff.find((x) => x.board === b);
        if (w) take(w);
      }
      if (![...picked].some((m) => m.kind === "work" && m.answers === firstTurn.round) && payoff[0])
        take(payoff[0]);
    } else for (const w of payoff) take(w);
  }
  if (opts.length > 15) {
    // Further turns with their payoffs, then the biggest remaining work.
    for (const t of turns.slice(1)) {
      const payoff = work
        .filter((w) => w.answers === t.round && visible(w))
        .sort((a, b) => score(b) - score(a));
      if (!payoff.length) continue;
      if (!take(t)) break;
      for (const w of payoff) take(w);
    }
    const rest = work
      .filter((w) => !picked.has(w) && visible(w))
      .sort((a, b) => score(b) - score(a));
    for (const w of rest) take(w);
  }
  // Each turn features the comments whose fixes are in the film: a short film shows two cards,
  // so it spends them on the comments the film pays off.
  // The boards whose fixes for each turn are shown.
  const paidFor = (round: number) =>
    new Set(
      [...picked]
        .filter(
          (m): m is Extract<Moment, { kind: "work" }> => m.kind === "work" && m.answers === round,
        )
        .map((w) => w.board),
    );
  const cards = opts.length <= 15 ? 2 : 4;
  return all
    .filter((m) => picked.has(m))
    .map((m) => {
      if (m.kind !== "turn") return m;
      const shownBoards = paidFor(m.round);
      const paid = m.comments.filter((c) => c.board && shownBoards.has(c.board));
      const rest = m.comments.filter((c) => !paid.includes(c));
      // A short film only reads out the comments it pays off; the others land as pins.
      const pool = opts.length <= 15 && paid.length ? paid : [...paid, ...rest];
      return { ...m, featured: pool.slice(0, cards).map((c) => c.thread) };
    });
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
  const HOP = 0.6;
  const raw = story.map((m) => {
    if (m.kind === "turn") {
      const cards = opts.length <= 15 ? 2 : 4;
      const hops = opts.hops?.get(m) ?? [];
      const featured = m.featured ?? m.comments.slice(0, cards).map((c) => c.thread);
      const shown = m.comments.map((c, i) => ({
        comment: c,
        card: featured.includes(c.thread),
        hop: i > 0 && Boolean(hops[i]) && featured.includes(c.thread),
        d: featured.includes(c.thread) ? commentTime(c.words, opts.length) : 0.4,
      }));
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
  const fixed = SHOT.open + SHOT.result + SHOT.end;
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
    // Spare time: longer looks at each result, then a calmer change, evenly across the work.
    // Spare time: a longer look at each result (never a long still), a calmer change, and
    // longer reads of the cards; what's left goes to the last look at the result.
    let spare = room - used;
    const works = raw.filter((r) => r.m.kind === "work");
    const turns = raw.filter((r) => r.m.kind === "turn");
    const cards = turns.flatMap((r) => r.shown.filter((x) => x.card));
    for (let pass = 0; pass < 3 && spare > 0.05; pass++) {
      const slots = works.length * 2 + cards.length;
      if (!slots) break;
      const each = spare / slots;
      let usedNow = 0;
      for (const r of works) {
        const h = Math.max(0, Math.min(each * 2 * 0.6, 1.5 - r.hold));
        const c = Math.max(0, Math.min(each * 2 * 0.4, 1.7 - r.change));
        r.hold += h;
        r.change += c;
        usedNow += h + c;
      }
      for (const r of turns)
        for (const x of r.shown) {
          if (!x.card) continue;
          const d = Math.max(0, Math.min(each, 2.4 - x.d));
          x.d += d;
          r.change += d;
          usedNow += d;
        }
      spare -= usedNow;
      if (usedNow < 0.01) break;
    }
  }
  const shots: StoryShot[] = [];
  let t = SHOT.open;
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
  return { shots, result, endCard, duration: endCard + SHOT.end };
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
