import {
  type AgentActivity,
  firstName,
  type Person,
  type RunErrorCode,
  type ThreadItem,
} from "../model.ts";

/** A person's line in the thread: a message, or a comment from the canvas. */
type Said = Extract<ThreadItem, { kind: "message" | "comment" }>;

const said = (item: ThreadItem | undefined): item is Said =>
  item?.kind === "message" || item?.kind === "comment";

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

/**
 * The lines the thread shows, in order. What the run says about itself while starting
 * (waking, resumed, started) and a stretch of work still going (it is the working line, at the
 * foot) have no line of their own.
 */
export function threadRows(items: ThreadItem[]): ThreadRow[] {
  const shown = items.filter((item) => {
    if (item.kind === "tool") return !item.streaming;
    if (item.kind === "notice") {
      const { type } = item.payload;
      return type !== "waking" && type !== "resumed" && type !== "started";
    }
    return true;
  });
  const people = new Set(shown.filter(said).map((item) => item.payload.from.id));
  const sameSender = (a: ThreadItem | undefined, b: ThreadItem | undefined) =>
    said(a) && said(b) && a.payload.from.id === b.payload.from.id;
  const team = people.size > 1;
  return shown.map((item, i) => ({
    item,
    continues: sameSender(shown[i - 1], item),
    team: team && said(item),
    avatar: team && said(item) && !sameSender(item, shown[i + 1]),
  }));
}

/**
 * The working line at the thread's foot: what the agent is doing, while it works. Text it is
 * writing says that for itself, so there is no line under it; a sandbox coming back from sleep
 * says it is waking.
 */
export function workingLine(items: ThreadItem[], agent: AgentActivity): string | null {
  if (agent.state === "waking") return "Waking up…";
  if (agent.state !== "working") return null;
  const last = items.at(-1);
  if (last?.kind === "assistant" && last.streaming) return null;
  if (last?.kind === "notice" && last.payload.type === "waking" && last.streaming) {
    return "Waking up…";
  }
  const work = items.findLast((item) => item.kind === "tool" && item.streaming);
  if (work?.kind === "tool") return work.payload.label;
  return agent.status ?? "Working…";
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
