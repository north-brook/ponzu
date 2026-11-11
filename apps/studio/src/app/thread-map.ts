import type { DesignHeadRow, LiveRows, MeRow, QuestionRow } from "@ponzu/client";
import type { Artboard, Doc } from "@ponzu/core";
import type {
  AgentActivity,
  Ask,
  Attachment,
  Person,
  Pin,
  Repo,
  RunErrorCode,
  SteerGate,
  ThreadItem,
  ThreadNotice,
} from "../cloud/model.ts";

/*
 * The thread's live rows as the rail's model: people resolved to the workspace's members, a
 * message's attachments to their addresses, a comment's pin to its place in the board's
 * miniature, a question row to what the agent waits on, and the design's head to what the agent
 * is doing and what keeps anyone from steering it. Pure, so the rules are tested on their own.
 */

type RunnerItem = LiveRows["design.thread"];
/** Someone as the runner protocol names them. */
type Named = { id: string; name: string; login: string | null };

export interface ThreadContext {
  /** The workspace's members by id, for their avatars. */
  people: ReadonlyMap<string, Person>;
  /** Where the design's files are served (ends in "/"), once the API has said. */
  assetsUrl: string | null;
  /** The document, for where comments' pins sit. */
  doc: Doc | null;
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

/** The size of a comment's frame in the thread (lines.tsx `CommentFrame`). */
export const FRAME = { width: 132, height: 72 } as const;

/** An artboard's declared size, from its root's style. */
export function boardSize(board: Artboard): { width: number; height: number } {
  const px = (value: string | undefined, fallback: number) => {
    const n = Number.parseFloat(value ?? "");
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return { width: px(board.root.style.width, 1280), height: px(board.root.style.height, 800) };
}

/**
 * How a board fills a comment's frame: scaled to cover it and centered, as its miniature draws
 * it (board-miniature.tsx).
 */
export function frameFit(board: { width: number; height: number }) {
  const scale = Math.max(FRAME.width / board.width, FRAME.height / board.height);
  return {
    scale,
    left: (FRAME.width - board.width * scale) / 2,
    top: (FRAME.height - board.height * scale) / 2,
  };
}

/**
 * The boards comments were made on, as they were then, by the comment's thread item: what each
 * comment's miniature shows, so it stays what was commented on as the board changes after.
 */
export function frozenBoards(items: readonly RunnerItem[]): Map<string, Artboard> {
  const boards = new Map<string, Artboard>();
  for (const item of items) {
    if (item.kind === "comment" && item.payload.board) {
      boards.set(item.id, item.payload.board as Artboard);
    }
  }
  return boards;
}

/**
 * Where a comment's pin lands in its board's miniature; null when it falls outside it. Measured
 * on the board as the comment saw it, where that was kept.
 */
export function pinOf(
  doc: Doc | null,
  threadId: string,
  artboardId: string | null,
  frozen: Artboard | null = null,
): Pin | null {
  if (!doc || !artboardId) return null;
  const thread = doc.threads.find((t) => t.id === threadId);
  const board =
    frozen ?? doc.pages.flatMap((page) => page.artboards).find((ab) => ab.id === artboardId);
  if (!thread || !board) return null;
  const fit = frameFit(boardSize(board));
  const x = (fit.left + thread.x * fit.scale) / FRAME.width;
  const y = (fit.top + thread.y * fit.scale) / FRAME.height;
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
}

/** A message's images: the design's files, served from under its assets address. */
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
      const { threadId, artboardId, board: _board, ...rest } = item.payload;
      return {
        ...base,
        kind: "comment",
        payload: {
          ...rest,
          threadId,
          artboardId,
          from: personOf(item.payload.from, ctx.people),
          pin: pinOf(ctx.doc, threadId, artboardId, (item.payload.board as Artboard) ?? null),
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
 * thread too: its "Asked" line appears once it has closed.
 */
export function shownItems(
  items: readonly RunnerItem[],
  openAsks: ReadonlySet<string>,
): RunnerItem[] {
  return items.filter(
    (item) =>
      !(
        item.kind === "notice" &&
        item.payload.type === "question" &&
        openAsks.has(item.payload.questionId)
      ),
  );
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
      (item.kind === "notice" && item.payload.type === "pull_request");
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

type Head = Pick<DesignHeadRow, "agentState" | "agentStatus" | "agentBlocker">;

/** What the agent is doing, from the design's head; idle before the head arrives. */
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
 * What keeps the viewer from steering the design, if anything: read access only, or the owner's
 * Claude, which the design runs on for everyone. The head's blocker says when the owner's Claude
 * isn't connected, ran out or left with them; a plan at its limit is known only for the viewer's
 * own account, from their `me` row.
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
  /** The design's owner among the workspace's members; null when they aren't one any more. */
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
  const until = me?.claudeAccount?.limitedUntil;
  if (owner && me && owner.id === me.id && until && Date.parse(until) > now) {
    return { kind: "claude_limit", owner, until };
  }
  return null;
}
