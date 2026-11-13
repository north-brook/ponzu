import { ApiError, type CanvasHeadRow } from "@ponzu/client";
import {
  agentActivity,
  blockerWords,
  gateMessage,
  type Person,
  sandboxLine,
  shownItems,
  steerGate,
  type ThreadContext,
  type ThreadItem,
  type ThreadRow,
  threadRows,
  toThreadItem,
  workingLine,
} from "@ponzu/client/model";
import { firstSentence } from "../cloud/create";
import { CHAT } from "../copy";
import type { PendingMessage, RunnerItem } from "./thread-store";

/*
 * What the chat sheet shows (iPhone design §9), pure so bun tests it: the thread's lines by the
 * Mac's own rules (@ponzu/client/model's `shownItems`, `toThreadItem` and `threadRows`: bubbles,
 * avatars once more than one person has written, a comment's picture, Ponzu's replies, asides
 * only while the turn runs, no tool calls), the person's messages on their way, and the line at
 * the foot: what keeps the canvas waiting, or what the agent is doing.
 */

type Head = Pick<
  CanvasHeadRow,
  "agentState" | "agentStatus" | "agentBlocker" | "agentBlockedUntil" | "seq"
>;

/** The thread's items as the sheet reads them, the person's messages on their way at the end. */
export function chatItems({
  items,
  pending,
  openAsks,
  context,
  me,
}: {
  items: readonly RunnerItem[] | null;
  pending: readonly PendingMessage[];
  /** The questions still open: they are in the composer's place, never in the thread too. */
  openAsks: ReadonlySet<string>;
  context: ThreadContext;
  me: Person;
}): ThreadItem[] {
  const shown = shownItems(items ?? [], openAsks).map((item) => toThreadItem(item, context));
  const lastSeq = shown.at(-1)?.seq ?? 0;
  const mine: ThreadItem[] = pending.map((message, i) => ({
    id: message.id,
    // After everything held, in the order sent: the rules read who spoke last by seq.
    seq: lastSeq + 1 + i,
    at: message.at,
    streaming: false,
    kind: "message",
    payload: {
      text: message.text,
      from: me,
      attachments: message.pictures.map((p) => ({
        ref: p.ref,
        url: p.uri,
        contentType: p.contentType,
      })),
      delivery: "sending",
    },
  }));
  return [...shown, ...mine];
}

/** The thread's lines, oldest first: the Mac's rules over `chatItems`. */
export function chatRows(items: readonly ThreadItem[], head: Head | undefined): ThreadRow[] {
  return threadRows(items as ThreadItem[], agentActivity(head));
}

/** The workspace a billing blocker names: its name, and whether it is the person's own. */
export interface ChatWorkspace {
  name: string;
  personal: boolean;
}

/** The line at the thread's foot. */
export type ChatFoot =
  /** The agent at work, or about to be: the turning slice and what it's doing. */
  | { kind: "working"; text: string }
  /** The canvas can't run now: why, in plain words. `failed` when starting a machine failed. */
  | { kind: "waiting"; text: string; failed: boolean };

/**
 * The phone's words for a billing blocker: the neutral first sentence and "This canvas waits.",
 * never a way to pay (the program's settlement 6, App Store 3.1.3). Credits and a failed payment
 * are the shared words' phone line exactly; a cap names no amount here, since the phone doesn't
 * hold it (W11 adds the full billing words).
 */
export function billingWait(
  blocker: "credits_used_up" | "cap_reached" | "payment_failed",
  workspace: ChatWorkspace,
): string {
  if (blocker === "cap_reached")
    return `${workspace.name} has reached this month's cap. ${CHAT.waits}`;
  return blockerWords({ blocker, workspace, canManage: false }).phone;
}

/**
 * The thread's foot, most pressing first: a billing blocker; the owner's Claude (not connected,
 * signed out, at its plan's limit, or gone with them); the sandbox (waiting for a machine,
 * paused while Ponzu updates, or failed to start); then the working line, from the moment a
 * person sends until the turn ends. Nothing while the agent waits on a question (that is in the
 * composer's place) or rests.
 */
export function chatFoot({
  items,
  head,
  owner,
  meId,
  workspace,
  now,
}: {
  /** `chatItems`: a message on its way counts as said, so the line says Thinking from the tap. */
  items: readonly ThreadItem[];
  head: Head | undefined;
  /** The canvas's owner among the workspace's members; null when they aren't one any more. */
  owner: Person | null;
  meId: string;
  workspace: ChatWorkspace | null;
  now: number;
}): ChatFoot | null {
  const blocker = head?.agentBlocker ?? null;
  if (
    workspace &&
    (blocker === "credits_used_up" || blocker === "cap_reached" || blocker === "payment_failed")
  ) {
    return { kind: "waiting", text: billingWait(blocker, workspace), failed: false };
  }
  const gate = steerGate({ access: "write", repo: null, head, owner, me: undefined, now });
  if (gate) return { kind: "waiting", text: gateMessage(gate, meId), failed: false };
  const agent = agentActivity(head);
  const sandbox = sandboxLine(agent);
  if (sandbox) return { kind: "waiting", text: sandbox.text, failed: sandbox.failed };
  if (!head) return null;
  const working = workingLine(items as ThreadItem[], agent, now);
  return working ? { kind: "working", text: working } : null;
}

/**
 * What a send that didn't go leaves under the field. At a billing limit, the neutral first
 * sentence of the API's words and "This canvas waits."; while Ponzu updates, what it said; else
 * "Couldn't send. Tap to try again."
 */
export function sendFailed(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 402) {
      const first = error.message ? firstSentence(error.message) : "";
      return first ? `${first} ${CHAT.waits}` : CHAT.waits;
    }
    if (error.code === "maintenance" && error.message) return error.message;
  }
  return CHAT.sendFailed;
}

/** The newest seq the thread holds: how far the person has read it once the sheet closes. */
export function readTo(items: readonly RunnerItem[] | null): number | null {
  return items?.length ? items[items.length - 1]!.seq : null;
}

/** The row a `message=<seq>` link opens at: the first at or after it, else the last. */
export function revealRow(rows: readonly ThreadRow[], seq: number): number {
  const at = rows.findIndex((row) => row.item.seq >= seq);
  return at < 0 ? rows.length - 1 : at;
}
