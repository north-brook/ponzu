import type { Op } from "./doc.ts";
import type { Actor, Author, Message } from "./types.ts";

/** How an actor signs what they write. */
export function authorOf(actor: Actor): Author {
  const author: Author = { kind: actor.kind, name: actor.name, id: actor.id };
  if (actor.avatarUrl !== undefined) author.avatarUrl = actor.avatarUrl;
  return author;
}

/**
 * A copy of an op with who and when set from the API's view: `actor` from the caller's token
 * and `at` (milliseconds since 1970) from the API's clock. Whatever the client put in these
 * fields is overwritten, so nobody chooses who wrote a comment or when.
 *
 * | Op               | Stamped                                                              |
 * |------------------|----------------------------------------------------------------------|
 * | `thread.create`  | `thread.createdAt` and `updatedAt`; every message's `author` and     |
 * |                  | `createdAt`, and its `editedAt` removed                              |
 * | `thread.message` | `message.author` and `createdAt`, and its `editedAt` removed         |
 * | `thread.edit`    | `editedAt`, including a null that would hide the edit                |
 * | `thread.update`  | `updatedAt`                                                          |
 * | `batch`          | each op in it                                                        |
 *
 * Every other variant carries no authorship or time and comes back as it is.
 *
 * Stamping says who and when, not whether they may. Editing or deleting someone else's
 * comment (`thread.edit`, `thread.unmessage`, `thread.delete`) depends on who wrote it, which
 * is in the design: the API checks that against the document before it applies the op.
 *
 * Stamp what a client sends, never an inverse the API stored: undoing a deleted thread puts
 * back other people's messages with their own names and times.
 */
export function stampOp(op: Op, actor: Actor, at: number): Op {
  switch (op.op) {
    case "thread.create":
      return {
        ...op,
        thread: {
          ...op.thread,
          createdAt: at,
          updatedAt: at,
          messages: op.thread.messages.map((m) => stampMessage(m, actor, at)),
        },
      };
    case "thread.message":
      return { ...op, message: stampMessage(op.message, actor, at) };
    case "thread.edit":
      return { ...op, editedAt: at };
    case "thread.update":
      return { ...op, updatedAt: at };
    case "batch":
      return { ...op, ops: op.ops.map((child) => stampOp(child, actor, at)) };
    default:
      return op;
  }
}

function stampMessage(message: Message, actor: Actor, at: number): Message {
  const { editedAt: _, ...rest } = message;
  return { ...rest, author: authorOf(actor), createdAt: at };
}
