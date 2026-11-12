import type { Unsaved } from "@ponzu/client/canvas";
import { type Author, newId, type Op, type Thread } from "@ponzu/core";
import type { PendingPin } from "../../canvas/protocol";
import { CANVAS_WORDS, COMMENT_WORDS } from "../copy";

/*
 * Comments on the phone (iPhone design §8): a new thread where a pin was dropped, a reply in a
 * thread, and Resolve or Reopen, each one op through the canvas's replica (`source.apply`), as
 * the Mac's canvas makes them. Pure, so bun tests them over CloudSource and the fake backend.
 *
 * An op shows on the canvas the moment it is applied. `commit` answers once the API has it, or
 * rejects with the API's reason when it never will be; until then the words stay in their
 * draft (lib/drafts.ts), so a phone killed in between still has them.
 */

/** Where a new comment goes: a pin as the canvas page reports it. */
export type Spot = PendingPin & { nodeId?: string; offset?: { x: number; y: number } };

/** What a comment needs of the canvas's source (CloudSource). */
export interface CommentSource {
  apply(op: Op): void;
  saved(): Promise<void>;
  onUnsaved(listener: (unsaved: Unsaved) => void): () => void;
}

/** The API turned the op away, or it no longer fits: `message` says why, in words. */
export class CommentRefusedError extends Error {
  override name = "CommentRefusedError";
}

/** A new thread at `spot`, its first message `text`. Pins sit on whole pixels, as the Mac's. */
export function newThreadOp(
  spot: Spot,
  text: string,
  author: Author,
  now = Date.now(),
): Extract<Op, { op: "thread.create" }> {
  return {
    op: "thread.create",
    thread: {
      id: newId("th"),
      ...(spot.artboardId ? { artboardId: spot.artboardId } : { pageId: spot.pageId }),
      ...(spot.nodeId ? { nodeId: spot.nodeId } : {}),
      ...(spot.nodeId && spot.offset ? { offset: spot.offset } : {}),
      x: Math.round(spot.x),
      y: Math.round(spot.y),
      status: "open",
      createdAt: now,
      updatedAt: now,
      messages: [{ id: newId("m"), author, text, createdAt: now }],
    },
  };
}

/**
 * A reply in `thread`, with the new message's id. Resolved while it was open, a reply is
 * something more to do: it opens again, in the same op.
 */
export function replyOp(
  thread: Pick<Thread, "id" | "status">,
  text: string,
  author: Author,
  now = Date.now(),
): { op: Op; messageId: string } {
  const message = {
    op: "thread.message" as const,
    id: thread.id,
    message: { id: newId("m"), author, text, createdAt: now },
  };
  const op: Op =
    thread.status === "resolved"
      ? {
          op: "batch",
          ops: [message, { op: "thread.update", id: thread.id, status: "open", updatedAt: now }],
        }
      : message;
  return { op, messageId: message.message.id };
}

/** Resolve or reopen a thread. */
export function statusOp(threadId: string, status: Thread["status"], now = Date.now()): Op {
  return { op: "thread.update", id: threadId, status, updatedAt: now };
}

/**
 * Apply `op` and wait for the API: resolves once it is committed, rejects with
 * `CommentRefusedError` once it never will be (refused, no longer fitting, a canvas the person
 * may only look at, a canvas that went away). Offline, it waits for as long as that lasts.
 */
export function commit(source: CommentSource, op: Op): Promise<void> {
  return new Promise((resolve, reject) => {
    let refused = false;
    const off = source.onUnsaved((unsaved) => {
      if (unsaved.op !== op || refused) return;
      refused = true;
      off();
      reject(new CommentRefusedError(unsaved.reason.trim() || COMMENT_WORDS.refused));
    });
    source.apply(op);
    if (refused) return;
    source.saved().then(
      () => {
        if (refused) return;
        off();
        resolve();
      },
      (error: unknown) => {
        if (refused) return;
        off();
        reject(new CommentRefusedError(error instanceof Error ? error.message : String(error)));
      },
    );
  });
}

/** The words for a refusal, from whatever was thrown. */
export function refusalWords(error: unknown): string {
  const words = error instanceof Error ? error.message.trim() : "";
  return words || COMMENT_WORDS.refused;
}

/**
 * The line a canvas the person can't comment on says, or null when they can. A canvas still
 * opening says nothing (it isn't known yet); one shown from the last copy says it is offline;
 * one the person may only read says what steering it takes.
 */
export function readOnlyLine(input: {
  writable: boolean;
  status: "connecting" | "ready" | "offline" | "error" | string;
  hasDoc: boolean;
  repo: string | null | undefined;
}): string | null {
  if (input.writable) return null;
  if (input.status === "offline") return input.hasDoc ? CANVAS_WORDS.offline : null;
  if (input.status !== "ready") return null;
  return input.repo ? CANVAS_WORDS.readOnly(input.repo) : COMMENT_WORDS.readOnlyScratch;
}
