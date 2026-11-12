import type { Doc, Op } from "./doc.ts";
import type { Actor } from "./types.ts";

/**
 * How a canvas's ops travel between a replica and the API (docs/cloud.md, "The document and
 * how it syncs"). The API orders ops; everyone applies them in that order.
 */

/** An op on its way to the API. The sender makes up `id`, and posts it again unchanged on a retry. */
export interface ClientOp {
  id: string;
  op: Op;
}

/**
 * An op the API accepted, as everyone applies it. `op` is what the API applied, which is the
 * sender's op sanitized and stamped, so it can differ from what was sent.
 */
export interface CommittedOp {
  /** Its place in the canvas's order, counting from 1 with no gaps. */
  seq: number;
  /** The `ClientOp.id` it was sent with. */
  id: string;
  op: Op;
  actor: Actor;
  /** When the API committed it, as an ISO 8601 time. */
  at: string;
}

export interface CommitResult {
  /** The ops of this post that are in the canvas, in order. A retried op comes back as first committed. */
  committed: CommittedOp[];
  /** The ops of this post that will never be, and why. */
  rejected: { id: string; reason: string }[];
  /** The canvas's latest seq once the post was handled. */
  seq: number;
}

/** The most ops one post carries. A replica with more pending sends them in turns. */
export const MAX_COMMIT_OPS = 64;

/**
 * The most one post's ops weigh, as JSON in UTF-8 bytes. A Vercel function takes a body of
 * 4.5 MB and answers with no more, and the answer carries every committed op back, so this
 * leaves room for the rest of both. One op alone always fits: `MAX_OP_BYTES` is smaller.
 */
export const MAX_COMMIT_BYTES = 3 * 1024 * 1024;

/**
 * What `commit` throws when the API will never take the post as it was sent (too large,
 * malformed, not allowed), so that sending it again can't help. Any other failure is taken
 * to be passing, and the post is sent again.
 */
export class CommitRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "CommitRefusedError";
  }
}

/** What a replica needs from the API, for one canvas. */
export interface SyncTransport {
  /** Rejects with `CommitRefusedError` for a post that will never be taken, and with anything else for a failure worth another try. */
  commit(ops: ClientOp[]): Promise<CommitResult>;
  /** Every op after `after`, in order, or "gone" when the API no longer keeps ops that old. */
  fetchOps(after: number): Promise<{ ops: CommittedOp[]; seq: number } | "gone">;
  fetchDoc(): Promise<{ doc: Doc; seq: number }>;
}

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** An id for a `ClientOp`, like `op_4k2j…`: 20 random characters, about 100 bits. */
export function newOpId(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  let out = "op_";
  for (const b of bytes) out += ALPHABET[b % 36];
  return out;
}
