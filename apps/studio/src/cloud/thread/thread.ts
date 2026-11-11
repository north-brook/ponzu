import {
  type AgentActivity,
  firstName,
  type Person,
  type RunErrorCode,
  type ThreadItem,
  type TurnRecord,
} from "../model.ts";

/** A person's line in the thread: a message, or a comment from the canvas. */
type Said = Extract<ThreadItem, { kind: "message" | "comment" }>;
type Work = Extract<ThreadItem, { kind: "tool" }>;
type Reply = Extract<ThreadItem, { kind: "assistant" }>;
type Notice = Extract<ThreadItem, { kind: "notice" }>;

const said = (item: ThreadItem | undefined): item is Said =>
  item?.kind === "message" || item?.kind === "comment";
const isTurn = (item: ThreadItem): item is Work & { payload: { turn: TurnRecord } } =>
  item.kind === "tool" && !!item.payload.turn;
const asked = (item: ThreadItem): item is Notice =>
  item.kind === "notice" && item.payload.type === "question";
/** What the run says of itself while it starts: no line of its own, and no answer to anyone. */
const starting = (item: ThreadItem): boolean =>
  item.kind === "notice" &&
  (item.payload.type === "waking" ||
    item.payload.type === "resumed" ||
    item.payload.type === "started");

/** One line of the thread as the rail draws it. */
export interface ThreadRow {
  item: ThreadItem;
  /** The same person's run of messages goes on from the line above: it sits tight under it. */
  continues: boolean;
  /** More than one person speaks in the thread, so bubbles carry their senders' avatars. */
  team: boolean;
  /** Stamp the sender's avatar: the thread is a team's, and their run ends here. */
  avatar: boolean;
}

/** A finished turn's middle, folded to one line that opens on it. */
export interface FoldRow {
  fold: TurnFold;
}

export type Row = ThreadRow | FoldRow;

export const isFold = (row: Row): row is FoldRow => "fold" in row;

export interface TurnFold {
  /** Stable while the turn is in the thread: the item it starts at. */
  id: string;
  /** The line it folds to: "Worked for 2 min · 9 boards · 3 files". */
  summary: string;
  ended: "done" | "stopped" | "failed";
  /** What it holds, in order: the agent's messages before its answer, and its steps after each. */
  parts: FoldPart[];
}

export type FoldPart =
  | { kind: "message"; item: Reply }
  | { kind: "asked"; item: Notice }
  | { kind: "steps"; id: string; steps: FoldStep[] };

export interface FoldStep {
  /** "Drew "Hero"", or for what a turn only counted, "12 more steps". */
  text: string;
  count: number;
}

/**
 * The thread split into turns. A turn is opened by its work item when the runner keeps one per
 * turn (`turn` on a `tool` item); an older runner's turn is opened by the agent's first item
 * after a person's. Everything up to the next opening is the turn's: the API's items within it
 * (a person's message mid-turn, a pull request) stay where they are, never folded.
 */
interface Turn {
  items: ThreadItem[];
  /** The work item that opened it, for a runner that keeps one. */
  work: (Work & { payload: { turn: TurnRecord } }) | null;
}

function turnsOf(items: ThreadItem[]): { before: ThreadItem[]; turns: Turn[] } {
  const before: ThreadItem[] = [];
  const turns: Turn[] = [];
  let current: Turn | null = null;
  // A person spoke since the agent last did: the agent's next item opens a turn of its own.
  let heard = false;
  for (const item of items) {
    if (isTurn(item)) {
      current = { items: [item], work: item };
      turns.push(current);
      heard = false;
      continue;
    }
    const agents = item.kind === "assistant" || item.kind === "tool";
    if (agents && (!current || (heard && (!current.work || current.work.payload.turn.ended)))) {
      current = { items: [item], work: null };
      turns.push(current);
      heard = false;
      continue;
    }
    if (said(item)) heard = true;
    else if (agents) heard = false;
    (current?.items ?? before).push(item);
  }
  return { before, turns };
}

/** The agent is at it, or about to be: a turn still streaming is live only while it is. */
const active = (agent: AgentActivity | undefined) =>
  agent?.state === "working" || agent?.state === "waking" || agent?.state === "needs_you";

/** Whether this, the thread's last turn, is still running: shown in full, never folded. */
function live(turn: Turn, agent: AgentActivity | undefined): boolean {
  if (!active(agent)) return false;
  if (turn.work) return turn.work.streaming;
  // An older runner says nothing of its turns: the last one runs while the agent works, unless
  // a person has spoken since its last item (a new turn for them is on its way).
  const last = turn.items.findLast((i) => i.kind === "assistant" || i.kind === "tool");
  return !turn.items.slice(last ? turn.items.indexOf(last) + 1 : 0).some(said);
}

/**
 * The lines the thread shows, in order. What the run says about itself while starting (waking,
 * resumed, started) has no line. A running turn shows the agent's messages and nothing of its
 * tools: the working line at the foot says what it is doing. A finished turn keeps its answer
 * in full and folds what came before it into one line that opens on it; a turn that was only
 * its answer has no fold.
 */
export function threadRows(items: ThreadItem[], agent?: AgentActivity): Row[] {
  const shown = items.filter((item) => !starting(item));
  const { before, turns } = turnsOf(shown);
  const out: (ThreadItem | FoldRow)[] = [...before];
  turns.forEach((turn, i) => {
    if (i === turns.length - 1 && live(turn, agent)) {
      out.push(...turn.items.filter((item) => item.kind !== "tool"));
      return;
    }
    out.push(...folded(turn));
  });
  return withRuns(out);
}

/** A finished turn: its middle folded into one row where it began, the rest as it was. */
function folded(turn: Turn): (ThreadItem | FoldRow)[] {
  const { items, work } = turn;
  const agentItems = items.filter((i) => i.kind === "assistant" || i.kind === "tool");
  const lastAgent = agentItems.at(-1);
  // The answer: the runner names it; for an older runner, its last message unless it went on
  // working after it.
  const finalId = work
    ? work.payload.turn.final
    : lastAgent?.kind === "assistant"
      ? lastAgent.id
      : null;
  const final = items.find((i) => i.id === finalId && i.kind === "assistant") ?? null;
  const endAt = final ? items.indexOf(final) : items.length;
  const lastWork = lastAgent ? items.indexOf(lastAgent) : -1;
  // What folds: the agent's own items before the answer, and the questions it asked on the way
  // (one asked after its last item is how the turn ended: it stays).
  const folds = (item: ThreadItem, at: number) =>
    at < endAt &&
    (item.kind === "tool" ||
      (item.kind === "assistant" && item !== final) ||
      (asked(item) && at < lastWork));
  const parts = foldParts(items.filter(folds), work);
  const out: (ThreadItem | FoldRow)[] = [];
  let placed = false;
  items.forEach((item, at) => {
    if (folds(item, at)) {
      if (!placed && parts.length) out.push({ fold: foldOf(turn, parts, final) });
      placed = true;
      return;
    }
    out.push(item);
  });
  return out;
}

/** The fold's parts: each message, with its steps after it, in order. */
function foldParts(inside: ThreadItem[], work: Turn["work"]): FoldPart[] {
  const parts: FoldPart[] = [];
  if (work) {
    const log = work.payload.turn.log;
    const stepsAfter = (after: string | null): FoldPart[] => {
      const steps = log
        .filter((g) => g.after === after)
        .map((g) =>
          g.text === null
            ? { text: `${g.count} more ${g.count === 1 ? "step" : "steps"}`, count: 1 }
            : { text: g.text, count: g.count },
        );
      return steps.length ? [{ kind: "steps", id: `${work.id}:${after ?? "start"}`, steps }] : [];
    };
    parts.push(...stepsAfter(null));
    const known = new Set<string | null>([null]);
    for (const item of inside) {
      if (item.kind === "assistant") {
        parts.push({ kind: "message", item });
        parts.push(...stepsAfter(item.id));
        known.add(item.id);
      } else if (asked(item)) parts.push({ kind: "asked", item });
    }
    // Steps after a message this window doesn't hold (or its answer): at the end, in order.
    for (const after of new Set(log.map((g) => g.after)))
      if (!known.has(after)) parts.push(...stepsAfter(after));
    return parts;
  }
  // An older runner's stretches of work, each as one step. Its labels said only the stretch's
  // weightiest step, or whatever the agent last set as its status, which then named every
  // stretch after it ("Setting direction" ten times over). A label is trusted only where it
  // tells its stretch apart: said once in a turn whose stretches say different things.
  // Otherwise the stretch is what can be counted: its steps, and the boards it was on.
  const stretches = inside.filter((i): i is Work => i.kind === "tool");
  const times = new Map<string, number>();
  for (const w of stretches) times.set(w.payload.label, (times.get(w.payload.label) ?? 0) + 1);
  const telling = (label: string) => times.size > 1 && times.get(label) === 1;
  for (const item of inside) {
    if (item.kind === "assistant") parts.push({ kind: "message", item });
    else if (asked(item)) parts.push({ kind: "asked", item });
    else if (item.kind === "tool") {
      const { label, steps, artboards } = item.payload;
      const boards = new Set(artboards).size;
      const counted = [
        `${steps} ${steps === 1 ? "step" : "steps"}`,
        boards ? ` on ${boards} ${boards === 1 ? "board" : "boards"}` : "",
      ].join("");
      const step = { text: telling(label) ? `${label} · ${counted}` : counted, count: 1 };
      const prev = parts.at(-1);
      if (prev?.kind === "steps") prev.steps.push(step);
      else parts.push({ kind: "steps", id: item.id, steps: [step] });
    }
  }
  return parts;
}

function foldOf(turn: Turn, parts: FoldPart[], final: ThreadItem | null): TurnFold {
  const { items, work } = turn;
  const first = items[0]!;
  if (work) {
    const t = work.payload.turn;
    const ended = t.ended ?? "stopped";
    return {
      id: first.id,
      summary: summary(t.ms, t.boards, t.files, work.payload.steps),
      ended,
      parts,
    };
  }
  // An older runner: how long from its first item to its answer (or its last), and the boards
  // its stretches were on.
  const stretches = items.filter((i): i is Work => i.kind === "tool");
  const end = final ?? items.findLast((i) => i.kind === "assistant" || i.kind === "tool")!;
  const ms = Date.parse(end.at) - Date.parse(first.at);
  const boards = new Set(stretches.flatMap((w) => w.payload.artboards)).size;
  const steps = stretches.reduce((n, w) => n + w.payload.steps, 0);
  const stopped = items.some((i) => i.kind === "notice" && i.payload.type === "stopped");
  const failed = items.some((i) => i.kind === "notice" && i.payload.type === "error");
  const ended = stopped ? "stopped" : failed ? "failed" : "done";
  return { id: first.id, summary: summary(ms, boards, 0, steps), ended, parts };
}

/**
 * The folded line, in a person's words: how long it worked and what it made ("Worked for 2 min
 * · 9 boards · 3 files"). With nothing made, how many steps it took. How it ended (a stop, an
 * error, a question) is the line after the fold, so the fold doesn't say it again.
 */
export function summary(ms: number, boards: number, files: number, steps: number): string {
  const made = [
    boards ? `${boards} ${boards === 1 ? "board" : "boards"}` : "",
    files ? `${files} ${files === 1 ? "file" : "files"}` : "",
  ].filter(Boolean);
  if (!made.length && steps) made.push(`${steps} ${steps === 1 ? "step" : "steps"}`);
  return [`Worked for ${took(ms)}`, ...made].join(" · ");
}

/**
 * "a moment", "8 s", "40 s", "2 min", "1 h 5 min". Past ten seconds, to the nearest five: the
 * turn's last write can land a moment after the fold first shows, and the line shouldn't tick.
 */
export function took(ms: number): string {
  const s = Math.round(Math.max(0, ms) / 1000);
  if (s < 1) return "a moment";
  if (s < 10) return `${s} s`;
  if (s < 58) return `${Math.round(s / 5) * 5} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}

/** Lines in order, each person's run of messages marked. */
function withRuns(shown: (ThreadItem | FoldRow)[]): Row[] {
  // A fold sits between two of a person's messages as a line of its own: it breaks their run.
  const items = shown.map((s) => ("fold" in s ? undefined : s));
  const people = new Set(
    items.filter((i): i is Said => said(i)).map((item) => item.payload.from.id),
  );
  const sameSender = (a: ThreadItem | undefined, b: ThreadItem | undefined) =>
    said(a) && said(b) && a.payload.from.id === b.payload.from.id;
  const team = people.size > 1;
  return shown.map((s, i) => {
    if ("fold" in s) return s;
    return {
      item: s,
      continues: sameSender(items[i - 1], s),
      team: team && said(s),
      avatar: team && said(s) && !sameSender(s, items[i + 1]),
    };
  });
}

/** How long after a person sends that the rail says the agent is thinking, if nothing else has. */
export const SENT_GRACE_MS = 20_000;

/**
 * The working line at the thread's foot: what the agent is doing, from the moment a person sends
 * until its turn ends, never blank between. Waking while its sandbox starts; the runner's
 * working state while it works (thinking, or the specific thing); nothing while it waits on a
 * question (that is in the composer's place) or once its turn has folded, which happens in the
 * same frame. In the moment between a send and the agent's first report, thinking.
 */
export function workingLine(
  items: ThreadItem[],
  agent: AgentActivity,
  now: number = Date.now(),
): string | null {
  if (agent.state === "needs_you") return null;
  if (agent.state === "waking") return "Waking up";
  const lastTurn = items.findLast(isTurn);
  const after = lastTurn ? items.slice(items.indexOf(lastTurn) + 1) : items;
  if (agent.state === "working") {
    // The turn has ended in the thread, and nothing new has come for the agent since: its
    // report that it is idle is on its way.
    if (lastTurn && !lastTurn.streaming && !after.some(said)) return null;
    return agent.status?.trim() || "Thinking";
  }
  // Idle as far as the head knows, but a person has just sent something it hasn't taken yet. A
  // runner's own word that it started (`waking`, `resumed`, `started`) is no answer to it.
  const lastAgent = items.findLast(
    (i) => i.kind === "assistant" || i.kind === "tool" || (i.kind === "notice" && !starting(i)),
  );
  const lastSaid = items.findLast(said);
  if (!lastSaid || (lastAgent && lastAgent.seq > lastSaid.seq)) return null;
  const sending = lastSaid.kind === "message" && lastSaid.payload.delivery === "sending";
  if (lastSaid.kind === "message" && lastSaid.payload.delivery === "failed") return null;
  const fresh = now - Date.parse(lastSaid.at) < SENT_GRACE_MS;
  return sending || fresh ? "Thinking" : null;
}

/**
 * What the thread's foot says while the design's sandbox can't run, in place of the working
 * line: a quiet wait for a machine, or a start that failed. Messages are kept either way.
 */
export function sandboxLine(agent: AgentActivity): { text: string; failed: boolean } | null {
  if (agent.sandbox === "busy") {
    return {
      text: "Waiting for a free machine. Your messages go in as soon as one starts.",
      failed: false,
    };
  }
  if (agent.sandbox === "failed") {
    return {
      text: "Ponzu couldn't start a machine for this design. Send a message to try again.",
      failed: true,
    };
  }
  return null;
}

/** What each way a turn can fail means to a person, in a sentence. */
export const ERROR_COPY: Record<RunErrorCode, string> = {
  clone_failed:
    "Couldn't check out the repo, so Claude is working without it. It tries again the next time the design wakes.",
  claude_auth: "Claude turned down the owner's account. Reconnect Claude in Settings to go on.",
  claude_limit: "The owner's Claude plan hit its limit. This design waits until it resets.",
  model_unavailable: "The chosen model isn't available. Pick another in Settings, under Agents.",
  max_turns: "Claude stopped after a long stretch of work. Send a message to keep it going.",
  turn_failed: "Something went wrong in that turn.",
  agent_exited: "Claude stopped unexpectedly and started again.",
  message_refused: "The repo's Claude Code settings turned that message away.",
  question_failed: "Claude couldn't ask its question, so it went on without an answer.",
  push_failed: "Ponzu couldn't push the branch to GitHub. The commits are safe in the design.",
};

/** Errors whose own message says more than the sentence does. */
export const ERROR_DETAIL: ReadonlySet<RunErrorCode> = new Set([
  "turn_failed",
  "message_refused",
  "push_failed",
]);

/** "You", or the person's first name. */
export function who(person: Person, meId: string): string {
  return person.id === meId ? "You" : firstName(person);
}
