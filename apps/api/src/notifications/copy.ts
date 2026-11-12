import type { QuestionKind } from "@ponzu/db/types";
import type { FailedReason } from "./kinds.ts";

/*
 * A ping's words: the only place they live, each exact (docs/cloud.md, "Notifications"). A ping
 * crosses Expo and Apple and may show on a locked phone, so what it says is kept to the least:
 *
 * - The title is the canvas's name, or for a billing ping the workspace's, clipped to
 *   `TITLE_MAX` characters with "…".
 * - The body is one of the fixed sentences below. The only things in it that anyone wrote are a
 *   person's first name and a pull request's number. Never a comment's or a question's text, the
 *   agent's words, a repo, a branch, a file path or a secret's name: no function here takes one.
 *
 * Ponzu speaks, never Claude, and the product says "ping", never "push". The billing pings use
 * billing's words (its design, §9), with "You've" and "Your" for a personal workspace as the
 * billing walls say them.
 */

/** The most characters a title has, its "…" included. */
export const TITLE_MAX = 60;
/** The most characters of a first name a body carries. */
export const FIRST_NAME_MAX = 32;

// Characters that would steer or hide text rather than show it: C0 and C1 controls (newlines,
// tabs, escapes) and the bidirectional overrides, embeddings, isolates and marks.
const UNSHOWN = /[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

/** Text a person named something, made safe to show on one line: controls dropped, spaces folded. */
export function oneLine(text: string): string {
  return text.replace(UNSHOWN, " ").replace(/\s+/gu, " ").trim();
}

/**
 * `text` in at most `max` characters, counted as code points (as Postgres counts them), cut
 * with "…" at the end when it is longer. A cut never splits a character a person sees (a
 * grapheme: an emoji with its modifiers, a letter with its accents), so a cut can leave fewer
 * than `max`.
 */
export function clip(text: string, max: number): string {
  if ([...text].length <= max) return text;
  let kept = "";
  let length = 0;
  for (const { segment } of graphemes.segment(text)) {
    const size = [...segment].length;
    if (length + size > max - 1) break;
    kept += segment;
    length += size;
  }
  return `${kept.trimEnd()}…`;
}

/** A ping's title: the canvas's (or workspace's) name on one line, clipped. */
export function titleOf(name: string, max = TITLE_MAX): string {
  return clip(oneLine(name), max) || "Untitled";
}

/** A person, as far as a ping may name them. */
export interface Named {
  /** `users.name`: whatever they or their sign-in gave. */
  name: string | null;
  /** Their GitHub login. */
  login: string | null;
}

/**
 * The most of a person a ping says: their name up to its first space, else `@login`, else
 * "Someone".
 */
export function firstName(person: Named): string {
  const first = oneLine(person.name ?? "").split(" ")[0] ?? "";
  if (first) return clip(first, FIRST_NAME_MAX);
  const login = oneLine(person.login ?? "");
  if (login) return clip(`@${login}`, FIRST_NAME_MAX);
  return "Someone";
}

export const NEEDS_YOU_BODY: Record<QuestionKind, string> = {
  question: "Ponzu has a question for you.",
  plan: "Ponzu has a plan for you to look at.",
  permission: "Ponzu is asking for your permission.",
  elicitation: "Ponzu needs a few details from you.",
  handoff: "Ponzu needs you to open a link.",
  secret: "Ponzu needs a secret to go on.",
};

export const FAILED_BODY: Record<FailedReason, string> = {
  turn: "Ponzu stopped before it finished. Open the thread to see why.",
  claude_auth: "Ponzu can't reach your Claude account. Connect it again to go on.",
  lapsed: "Ponzu couldn't get to your message. Send it again.",
  wake: "Ponzu couldn't start. Send a message to try again.",
};

export const REPLY_BODY = "Ponzu replied to your comment.";
export const FINISHED_BODY = "Ponzu finished what you asked.";
export const CLAUDE_LIMIT_BODY = "Your Claude plan hit a limit. Canvases wait until it resets.";

export function prReadyBody(number: number): string {
  return `Pull request #${number} is ready to merge.`;
}

export function prApprovedBody(number: number, approver: Named): string {
  return `${firstName(approver)} approved pull request #${number}.`;
}

/**
 * A teammate's comments on a canvas, collapsed into one ping: "Maya commented.", "Maya left 2
 * comments.", "Maya and Sam left 3 comments.", "Maya, Sam and Lee left 3 comments.", "Maya, Sam
 * and 2 others left 5 comments." `people` are the commenters, newest first; someone listed
 * twice (the same name and login) is counted once. `count` is how many comments, never fewer
 * than the people.
 */
export function commentBody(people: readonly Named[], count: number): string {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const person of people) {
    const key = `${person.name ?? ""}\u0000${person.login ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(firstName(person));
  }
  if (names.length === 0) names.push("Someone");
  const comments = Math.max(count, names.length, 1);
  const [a, b, c] = names;
  if (comments === 1) return `${a} commented.`;
  const who =
    names.length === 1
      ? a
      : names.length === 2
        ? `${a} and ${b}`
        : names.length === 3
          ? `${a}, ${b} and ${c}`
          : `${a}, ${b} and ${names.length - 2} others`;
  return `${who} left ${comments} comments.`;
}

/** The workspace a billing ping is about. */
export interface BillingWorkspace {
  name: string;
  /** A personal workspace says "You've" and "Your" rather than its name. */
  personal: boolean;
}

/** "$100": a cap, in whole dollars (caps are whole dollars). */
export function capDollars(cents: number): string {
  return `$${Math.floor(cents / 100).toLocaleString("en-US")}`;
}

/** "$1,234.50": an amount to pay, to the cent. */
export function dollarsAndCents(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "December 9": the day a period resets, as its midnight UTC falls. */
export function resetDay(at: Date): string {
  return at.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}

export function freeUsedBody(workspace: BillingWorkspace): string {
  return workspace.personal
    ? "You've used this month's free credits."
    : `${titleOf(workspace.name)} has used this month's free credits.`;
}

export function capWarningBody(workspace: BillingWorkspace, capCents: number): string {
  const who = workspace.personal ? "You've" : `${titleOf(workspace.name)} has`;
  return `${who} used 80% of this month's ${capDollars(capCents)} cap.`;
}

export function capReachedBody(
  workspace: BillingWorkspace,
  capCents: number,
  resetsOn: Date,
): string {
  const who = workspace.personal ? "You've" : titleOf(workspace.name);
  return `${who} reached this month's ${capDollars(capCents)} cap. Canvases wait until it's raised or it resets on ${resetDay(resetsOn)}.`;
}

export function paymentFailedBody(workspace: BillingWorkspace, totalCents: number): string {
  const whose = workspace.personal ? "Your" : `${titleOf(workspace.name)}'s`;
  return `${whose} payment of ${dollarsAndCents(totalCents)} didn't go through.`;
}

/** What a ping says, by what it is about: ids and numbers aside, every input is fixed. */
export type PingWords =
  | { kind: "needs_you"; canvasName: string; questionKind: QuestionKind }
  | { kind: "reply"; canvasName: string }
  | { kind: "finished"; canvasName: string }
  | { kind: "failed"; canvasName: string; reason: FailedReason }
  | { kind: "claude_limit"; canvasName: string }
  | { kind: "pr_ready"; canvasName: string; number: number }
  | { kind: "pr_approved"; canvasName: string; number: number; approver: Named }
  | { kind: "teammate_comment"; canvasName: string; people: readonly Named[]; count: number }
  | { kind: "billing_free_used"; workspace: BillingWorkspace }
  | { kind: "billing_cap_warning"; workspace: BillingWorkspace; capCents: number }
  | { kind: "billing_cap_reached"; workspace: BillingWorkspace; capCents: number; resetsOn: Date }
  | { kind: "billing_payment_failed"; workspace: BillingWorkspace; totalCents: number };

/** A ping's title and body. */
export function pingCopy(words: PingWords): { title: string; body: string } {
  switch (words.kind) {
    case "needs_you":
      return { title: titleOf(words.canvasName), body: NEEDS_YOU_BODY[words.questionKind] };
    case "reply":
      return { title: titleOf(words.canvasName), body: REPLY_BODY };
    case "finished":
      return { title: titleOf(words.canvasName), body: FINISHED_BODY };
    case "failed":
      return { title: titleOf(words.canvasName), body: FAILED_BODY[words.reason] };
    case "claude_limit":
      return { title: titleOf(words.canvasName), body: CLAUDE_LIMIT_BODY };
    case "pr_ready":
      return { title: titleOf(words.canvasName), body: prReadyBody(words.number) };
    case "pr_approved":
      return {
        title: titleOf(words.canvasName),
        body: prApprovedBody(words.number, words.approver),
      };
    case "teammate_comment":
      return { title: titleOf(words.canvasName), body: commentBody(words.people, words.count) };
    case "billing_free_used":
      return { title: titleOf(words.workspace.name), body: freeUsedBody(words.workspace) };
    case "billing_cap_warning":
      return {
        title: titleOf(words.workspace.name),
        body: capWarningBody(words.workspace, words.capCents),
      };
    case "billing_cap_reached":
      return {
        title: titleOf(words.workspace.name),
        body: capReachedBody(words.workspace, words.capCents, words.resetsOn),
      };
    case "billing_payment_failed":
      return {
        title: titleOf(words.workspace.name),
        body: paymentFailedBody(words.workspace, words.totalCents),
      };
  }
}
