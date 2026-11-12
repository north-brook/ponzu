import {
  type AgentActivity,
  firstName,
  type Person,
  type RunErrorCode,
  type ThreadItem,
  type ThreadNotice,
  type TurnRecord,
} from "./model.ts";

/** A person's line in the thread: a message, or a comment from the canvas. */
type Said = Extract<ThreadItem, { kind: "message" | "comment" }>;
type Work = Extract<ThreadItem, { kind: "tool" }>;
type Reply = Extract<ThreadItem, { kind: "assistant" }>;

const said = (item: ThreadItem | undefined): item is Said =>
  item?.kind === "message" || item?.kind === "comment";
const isTurn = (item: ThreadItem): item is Work & { payload: { turn: TurnRecord } } =>
  item.kind === "tool" && !!item.payload.turn;
/** What the run says of itself while it starts: no line of its own, and no answer to anyone. */
const starting = (item: ThreadItem): boolean =>
  item.kind === "notice" &&
  (item.payload.type === "waking" ||
    item.payload.type === "resumed" ||
    item.payload.type === "started");
/** What the run says as it starts, or of how it starts: a line, but no answer to anyone. */
const noAnswer = (item: ThreadItem): boolean =>
  starting(item) || (item.kind === "notice" && item.payload.type === "model_changed");

/** One line of the thread as the rail draws it. */
export interface ThreadRow {
  item: ThreadItem;
  /** The same person's run of messages goes on from the line above: it sits tight under it. */
  continues: boolean;
  /** More than one person speaks in the thread, so bubbles carry their senders' avatars. */
  team: boolean;
  /** Stamp the sender's avatar: the thread is a team's, and their run ends here. */
  avatar: boolean;
  /**
   * Something the agent said on the way, not its answer: set quieter than the answer, in
   * italics. A message is one once the agent has gone on working after it, and it shows only
   * while its turn runs.
   */
  aside?: boolean;
  /** An aside straight after another: it sits tight under it, as one run of them. */
  asideContinues?: boolean;
}

/**
 * The thread split into turns. A turn is opened by its work item when the runner keeps one per
 * turn (`turn` on a `tool` item); an older runner's turn is opened by the agent's first item
 * after a person's. Everything up to the next opening is the turn's: the API's items within it
 * (a person's message mid-turn, a question, a pull request) stay where they are.
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

/** Whether this, the thread's last turn, is still running: its asides still show. */
function live(turn: Turn, agent: AgentActivity | undefined): boolean {
  if (!active(agent)) return false;
  if (turn.work) return turn.work.streaming;
  // An older runner says nothing of its turns: the last one runs while the agent works, unless
  // a person has spoken since its last item (a new turn for them is on its way).
  const last = turn.items.findLast((i) => i.kind === "assistant" || i.kind === "tool");
  return !turn.items.slice(last ? turn.items.indexOf(last) + 1 : 0).some(said);
}

/**
 * The lines the thread shows, in order: what people said, what the agent said, and how a turn
 * ended. What the run says about itself while starting (waking, resumed, started) has no line,
 * and neither do the agent's tools: while a turn runs, the working line at the foot says what
 * it is doing, and what the agent says on the way shows as asides; once the turn has ended
 * only its answer stays, with whatever else happened in it (a question answered, a pull
 * request, a stop or an error).
 */
export function threadRows(items: ThreadItem[], agent?: AgentActivity): ThreadRow[] {
  const shown = items.filter((item) => !starting(item));
  const { before, turns } = turnsOf(shown);
  const out: ThreadItem[] = [...before];
  const asides = new Set<string>();
  turns.forEach((turn, i) => {
    const running = i === turns.length - 1 && live(turn, agent);
    const these = new Set(asidesOf(turn, running));
    out.push(
      ...turn.items.filter((item) => item.kind !== "tool" && (running || !these.has(item.id))),
    );
    if (running) for (const id of these) asides.add(id);
  });
  return withRuns(out, asides);
}

/**
 * The agent's messages in a turn that are not its answer. In a running turn, every message the
 * agent has gone on working after: a later message, or steps logged after it. Its newest words,
 * with nothing after them yet, read as an answer until it carries on. In a finished turn, every
 * message but its answer (answerOf).
 */
function asidesOf(turn: Turn, running: boolean): string[] {
  const { items, work } = turn;
  const messages = items.filter((i): i is Reply => i.kind === "assistant");
  if (running) {
    const after = new Set(work?.payload.turn.log.map((group) => group.after));
    return messages
      .filter((message, at) => {
        if (at < messages.length - 1 || after.has(message.id)) return true;
        // An older runner: a tool item after it is the work it went on to.
        return !work && items.slice(items.indexOf(message) + 1).some((i) => i.kind === "tool");
      })
      .map((message) => message.id);
  }
  const answer = answerOf(turn, messages);
  return messages.filter((message) => message.id !== answer).map((message) => message.id);
}

/**
 * A finished turn's answer: the one message of its that stays. The runner names it (`final`):
 * the agent's last message, unless it went on working after it. A turn that still ended as it
 * meant to (`done`) with work after its last words keeps those words: they are the last thing
 * it said, and without them the person's message would stand unanswered. One stopped or failed
 * has none: how it ended is its last line. A record not yet closed (the head said idle a moment
 * before the thread did) keeps its last words too, so they don't go and come back. An older
 * runner says none of this, so its answer is its last message, unless the turn was stopped or
 * failed after it.
 */
function answerOf(turn: Turn, messages: Reply[]): string | null {
  const { items, work } = turn;
  const last = messages.at(-1)?.id ?? null;
  if (work) {
    const { final, ended } = work.payload.turn;
    if (final && messages.some((m) => m.id === final)) return final;
    return ended === "stopped" || ended === "failed" ? null : last;
  }
  const lastAgent = items.findLast((i) => i.kind === "assistant" || i.kind === "tool");
  if (lastAgent?.kind === "assistant") return lastAgent.id;
  const cut = items.some(
    (i) => i.kind === "notice" && (i.payload.type === "stopped" || i.payload.type === "error"),
  );
  return cut ? null : last;
}

/** Lines in order: each person's run of messages marked, and the running turn's asides. */
function withRuns(items: ThreadItem[], asides: ReadonlySet<string>): ThreadRow[] {
  const people = new Set(
    items.filter((i): i is Said => said(i)).map((item) => item.payload.from.id),
  );
  const sameSender = (a: ThreadItem | undefined, b: ThreadItem | undefined) =>
    said(a) && said(b) && a.payload.from.id === b.payload.from.id;
  const team = people.size > 1;
  return items.map((s, i) => {
    const aside = asides.has(s.id);
    const above = items[i - 1];
    return {
      item: s,
      continues: sameSender(above, s),
      team: team && said(s),
      avatar: team && said(s) && !sameSender(s, items[i + 1]),
      ...(aside ? { aside, asideContinues: above !== undefined && asides.has(above.id) } : {}),
    };
  });
}

/** How long after a person sends that the rail says the agent is thinking, if nothing else has. */
export const SENT_GRACE_MS = 20_000;

/**
 * The working line at the thread's foot: what the agent is doing, from the moment a person sends
 * until its turn ends, never blank between. Waking while its sandbox starts; the runner's
 * working state while it works (thinking, or the specific thing); nothing while it waits on a
 * question (that is in the composer's place) or once its turn has ended, which happens in the
 * frame its asides go. In the moment between a send and the agent's first report, thinking.
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
  // runner's own word that it started (`waking`, `resumed`, `started`), or the API's that it
  // runs on another model, is no answer to it.
  const lastAgent = items.findLast(
    (i) => i.kind === "assistant" || i.kind === "tool" || (i.kind === "notice" && !noAnswer(i)),
  );
  const lastSaid = items.findLast(said);
  if (!lastSaid || (lastAgent && lastAgent.seq > lastSaid.seq)) return null;
  const sending = lastSaid.kind === "message" && lastSaid.payload.delivery === "sending";
  if (lastSaid.kind === "message" && lastSaid.payload.delivery === "failed") return null;
  const fresh = now - Date.parse(lastSaid.at) < SENT_GRACE_MS;
  return sending || fresh ? "Thinking" : null;
}

/**
 * What the thread's foot says while the canvas's sandbox can't run, in place of the working
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
      text: "Ponzu couldn't start a machine for this canvas. Send a message to try again.",
      failed: true,
    };
  }
  return null;
}

/** What each way a turn can fail means to a person, in a sentence. */
export const ERROR_COPY: Record<RunErrorCode, string> = {
  clone_failed:
    "Couldn't check out the repo, so Claude is working without it. It tries again the next time the canvas wakes.",
  claude_auth: "Claude turned down the owner's account. Reconnect Claude in Settings to go on.",
  claude_limit: "The owner's Claude plan hit its limit. This canvas waits until it resets.",
  model_unavailable: "The chosen model isn't available. Pick another in Settings, under Agents.",
  max_turns: "Claude stopped after a long stretch of work. Send a message to keep it going.",
  turn_failed: "Something went wrong in that turn.",
  agent_exited: "Claude stopped unexpectedly and started again.",
  message_refused: "The repo's Claude Code settings turned that message away.",
  question_failed: "Claude couldn't ask its question, so it went on without an answer.",
  push_failed: "Ponzu couldn't push the branch to GitHub. The commits are safe in Ponzu.",
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

/**
 * The thread's line once someone took over a canvas whose owner left, word for word from
 * the sweep plan, §8, and said to the taker as "you".
 */
export function ownerChangedLine(by: Person, meId: string): string {
  return by.id === meId
    ? "You took this canvas over. It runs on your Claude from now on."
    : `${who(by, meId)} took this canvas over. It runs on their Claude from now on.`;
}

/**
 * The thread's line when a canvas's model gave way (docs/cloud.md, "Models"): "Maya's Claude
 * doesn't offer Fable 5.2 any more, so this canvas now runs on Opus 5.5."
 */
export function modelChangedLine(
  notice: Extract<ThreadNotice, { type: "model_changed" }>,
  meId: string,
): string {
  const whose = notice.account
    ? notice.account.id === meId
      ? "Your Claude"
      : `${firstName(notice.account)}'s Claude`
    : "The Claude this canvas runs on";
  return `${whose} doesn't offer ${notice.fromName} any more, so this canvas now runs on ${notice.toName}.`;
}
