import type { Doc } from "@ponzu/core";
import { COMMENT_PICTURE, type CommentItem } from "@ponzu/runner/protocol";
import type { CanvasHeadRow, LiveRows, MeRow, QuestionRow } from "../live/rows.ts";
import type {
  AgentActivity,
  Ask,
  Attachment,
  CommentPicture,
  Person,
  Repo,
  RunErrorCode,
  SteerGate,
  ThreadItem,
  ThreadNotice,
} from "./model.ts";

/*
 * The thread's live rows as the rail's model: people resolved to the workspace's members, a
 * message's attachments and a comment's picture to their addresses, a question row to what the
 * agent waits on, and the canvas's head to what the agent is doing and what keeps anyone from
 * steering it. Pure, so the rules are tested on their own.
 */

type RunnerItem = LiveRows["canvas.thread"];

/**
 * A comment of the viewer's, by its message id: its picture being drawn, or drawn. The studio's
 * comment pictures (apps/studio/src/app/comment-pictures.ts) make these.
 */
export type LocalPicture =
  | { state: "drawing"; doc: Doc; threadId: string }
  | { state: "drawn"; light: string; dark: string };
/** Someone as the runner protocol names them. */
type Named = { id: string; name: string; login: string | null };

export interface ThreadContext {
  /** The workspace's members by id, for their avatars. */
  people: ReadonlyMap<string, Person>;
  /** Where the canvas's files are served (ends in "/"), once the API has said. */
  assetsUrl: string | null;
  /** The document, for the pages comments were left on. */
  doc: Doc | null;
  /** The pictures of the viewer's own comments, by message id, made here. */
  pictures?: ReadonlyMap<string, LocalPicture>;
}

/** Someone the thread names, as the member they are when the workspace has them. */
export function personOf(named: Named, people: ReadonlyMap<string, Person>): Person {
  return (
    people.get(named.id) ?? {
      id: named.id,
      name: named.name,
      login: named.login ?? named.name,
      avatarUrl: null,
    }
  );
}

/**
 * A comment's picture as the rail shows it: the viewer's own, from here, while it is drawn and
 * after (the files themselves, so nothing loads again), else the one its thread item has, at
 * the canvas's assets address; null when there is none.
 */
export function pictureOf(
  payload: CommentItem,
  local: LocalPicture | undefined,
  assetsUrl: string | null,
): CommentPicture | null {
  const { width, height } = COMMENT_PICTURE;
  if (local?.state === "drawing") return { kind: "drawing", width, height };
  if (local) return { kind: "image", light: local.light, dark: local.dark, width, height };
  const kept = payload.picture;
  if (!kept || !assetsUrl) return null;
  return {
    kind: "image",
    light: `${assetsUrl}${kept.light}`,
    dark: `${assetsUrl}${kept.dark}`,
    width: kept.width,
    height: kept.height,
  };
}

/**
 * The page a comment on the ground was left on, by name, for its compact line: the page
 * as it is now, or as the comment named it; none for one on a board, or a canvas of one page.
 */
function pageNameOf(payload: CommentItem, doc: Doc | null): string | null {
  if (payload.artboardId !== null) return null;
  if (doc && doc.pages.length < 2) return null;
  const page = doc?.pages.find((p) => p.id === payload.pageId);
  return page?.name ?? payload.pageName ?? null;
}

/** A message's images: the canvas's files, served from under its assets address. */
function attachmentsOf(payload: unknown, assetsUrl: string | null): Attachment[] {
  const given = (payload as { attachments?: { ref: string; contentType: string }[] }).attachments;
  if (!given?.length || !assetsUrl) return [];
  return given.map(({ ref, contentType }) => ({ ref, url: `${assetsUrl}${ref}`, contentType }));
}

function noticeOf(
  notice: Extract<RunnerItem, { kind: "notice" }>["payload"],
  people: ReadonlyMap<string, Person>,
): ThreadNotice {
  switch (notice.type) {
    case "stopped":
      return { type: "stopped", by: notice.by ? personOf(notice.by, people) : null };
    case "error":
      return { type: "error", code: notice.code as RunErrorCode, message: notice.message };
    case "pull_request_agent":
      return { ...notice, as: notice.as ? personOf(notice.as, people) : null };
    case "model_changed":
      return { ...notice, account: notice.account ? personOf(notice.account, people) : null };
    default:
      return notice;
  }
}

/** One item of the thread as the rail draws it. */
export function toThreadItem(item: RunnerItem, ctx: ThreadContext): ThreadItem {
  const base = { id: item.id, seq: item.seq, at: item.at, streaming: item.streaming };
  switch (item.kind) {
    case "message":
      return {
        ...base,
        kind: "message",
        payload: {
          text: item.payload.text,
          from: personOf(item.payload.from, ctx.people),
          attachments: attachmentsOf(item.payload, ctx.assetsUrl),
        },
      };
    case "comment": {
      const comment = item.payload;
      return {
        ...base,
        kind: "comment",
        payload: {
          threadId: comment.threadId,
          messageId: comment.messageId,
          text: comment.text,
          artboardId: comment.artboardId,
          artboardName: comment.artboardName,
          pageName: pageNameOf(comment, ctx.doc),
          from: personOf(comment.from, ctx.people),
          picture: pictureOf(comment, ctx.pictures?.get(comment.messageId), ctx.assetsUrl),
        },
      };
    }
    case "assistant":
      return { ...base, kind: "assistant", payload: { text: item.payload.text } };
    case "tool":
      return { ...base, kind: "tool", payload: item.payload };
    case "notice":
      return { ...base, kind: "notice", payload: noticeOf(item.payload, ctx.people) };
  }
}

/**
 * The items the rail shows. A question still open is in the composer's place, never in the
 * thread too: its "Asked" line appears once it has closed. A pull request opening or merging that
 * the agent did is said once, by the agent's own line (who it acted as), not again by GitHub's.
 */
export function shownItems(
  items: readonly RunnerItem[],
  openAsks: ReadonlySet<string>,
): RunnerItem[] {
  const byAgent = new Set(
    items.flatMap((item) =>
      item.kind === "notice" &&
      item.payload.type === "pull_request_agent" &&
      (item.payload.action === "opened" || item.payload.action === "merged")
        ? [`${item.payload.number}:${item.payload.action}`]
        : [],
    ),
  );
  return items.filter((item) => {
    if (item.kind !== "notice") return true;
    const notice = item.payload;
    if (notice.type === "question") return !openAsks.has(notice.questionId);
    if (notice.type === "pull_request") {
      const moment = notice.state === "merged" ? "merged" : "opened";
      return notice.state === "closed" || !byAgent.has(`${notice.number}:${moment}`);
    }
    return true;
  });
}

/**
 * The seq of the thread's latest item after which the branch may have moved: a finished
 * stretch of the agent's work, or a pull request notice. 0 while there is none.
 */
export function branchMoment(items: readonly RunnerItem[]): number {
  let at = 0;
  for (const item of items) {
    const moved =
      (item.kind === "tool" && !item.streaming) ||
      (item.kind === "notice" &&
        (item.payload.type === "pull_request" || item.payload.type === "pull_request_agent"));
    if (moved && item.seq > at) at = item.seq;
  }
  return at;
}

/** How one of the agent's questions closed, as the API answers it. */
export interface StandingQuestion {
  status: "open" | "answered" | "cancelled";
  answer: { answers?: Record<string, string>; approved?: boolean } | null;
}

/** What a closed question's "Asked" line says was picked: the labels, or yes or no. */
export function answerLine(question: StandingQuestion | undefined): string | null {
  if (!question || question.status !== "answered" || !question.answer) return null;
  const { answers, approved } = question.answer;
  if (answers) {
    const picked = Object.values(answers).filter((text) => text.trim());
    return picked.length ? picked.join(", ") : null;
  }
  if (approved !== undefined) return approved ? "Yes" : "No";
  return null;
}

/** The questions whose "Asked" lines the thread shows, to read how each closed. */
export function closedQuestions(items: readonly RunnerItem[]): string[] {
  return items.flatMap((item) =>
    item.kind === "notice" && item.payload.type === "question" ? [item.payload.questionId] : [],
  );
}

/** A question row as the needs-you slot takes it. */
export function toAsk(row: QuestionRow): Ask {
  const open = { id: row.id, status: "open" as const, answeredBy: null };
  switch (row.kind) {
    case "question":
      return { ...open, kind: "question", questions: row.payload.questions };
    case "plan":
      return { ...open, kind: "plan", plan: row.payload.plan };
    case "permission":
      return {
        ...open,
        kind: "permission",
        tool: row.payload.tool,
        title: row.payload.title,
        description: row.payload.description || null,
      };
  }
}

type Head = Pick<CanvasHeadRow, "agentState" | "agentStatus" | "agentBlocker"> &
  Partial<Pick<CanvasHeadRow, "agentBlockedUntil">>;

/** What the agent is doing, from the canvas's head; idle before the head arrives. */
export function agentActivity(head: Head | undefined): AgentActivity {
  if (!head) return { state: "idle", status: null, sandbox: null };
  const sandbox =
    head.agentBlocker === "sandbox_busy"
      ? "busy"
      : head.agentBlocker === "sandbox_failed"
        ? "failed"
        : null;
  return { state: head.agentState, status: head.agentStatus, sandbox };
}

/**
 * What keeps the viewer from steering the canvas, if anything: read access only, or the owner's
 * Claude, which the canvas runs on for everyone. The head's blocker says when the owner's Claude
 * isn't connected, ran out or left with them, or when its plan is at a limit and until when:
 * every viewer reads that alike, since the canvas waits for everyone (docs/cloud.md, "Claude plan
 * limits"). Before a wake has said so on the head, the owner also learns of their own plan's
 * limit from their `me` row.
 */
export function steerGate({
  access,
  repo,
  head,
  owner,
  me,
  now,
}: {
  access: "read" | "write" | null;
  repo: Repo | null;
  head: Head | undefined;
  /** The canvas's owner among the workspace's members; null when they aren't one any more. */
  owner: Person | null;
  me: MeRow | undefined;
  now: number;
}): SteerGate | null {
  if (access === "read") return { kind: "read_only", repo };
  const blocker = head?.agentBlocker ?? null;
  const claude = blocker?.startsWith("claude_") ?? false;
  if (blocker === "claude_owner_left" || (claude && !owner)) return { kind: "claude_owner_left" };
  if (owner && blocker === "claude_not_connected") return { kind: "claude_disconnected", owner };
  if (owner && blocker === "claude_expired") return { kind: "claude_expired", owner };
  const blockedUntil = head?.agentBlockedUntil;
  if (owner && blocker === "claude_limited" && blockedUntil && Date.parse(blockedUntil) > now) {
    return { kind: "claude_limit", owner, until: blockedUntil };
  }
  const until = me?.claudeAccount?.limitedUntil;
  if (owner && me && owner.id === me.id && until && Date.parse(until) > now) {
    return { kind: "claude_limit", owner, until };
  }
  return null;
}
