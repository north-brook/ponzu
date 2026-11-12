import type { Actor, Doc, Op } from "@ponzu/core";

/*
 * Who may commit which op. `applyOp` takes anything that fits the document; this decides who
 * may send it. People move, rename and delete artboards, manage pages, name the canvas and
 * write comments; the canvas's runner edits everything else (docs/cloud.md, "The replica").
 * Every variant is in
 * `OP_RULES`, so a new one does not compile until someone has decided who may send it.
 */

export type OpRule =
  /** Anyone who may steer the canvas: a person with write access, or its runner. */
  | "anyone"
  /** Only the canvas's runner. */
  | "runner"
  /** Anyone who may steer it, on a message they wrote themselves. */
  | "own-message"
  /** Each op inside is judged on its own. */
  | "each"
  /** Nobody: it means something only in the local app. */
  | "nobody";

export const OP_RULES: Record<Op["op"], OpRule> = {
  insert: "runner",
  remove: "runner",
  move: "runner",
  style: "runner",
  attrs: "runner",
  name: "runner",
  children: "runner",
  "artboard.create": "runner",
  // Deleting, moving (x and y) and renaming boards are a person's to do from the canvas.
  "artboard.delete": "anyone",
  "artboard.update": "anyone",
  "artboard.move": "anyone",
  "page.create": "anyone",
  "page.delete": "anyone",
  "page.update": "anyone",
  "page.order": "anyone",
  "page.move": "anyone",
  // The canvas's name and icon: PATCH /v1/canvases/:id sends these for a person, and the
  // agent's `update_canvas` for the agent. The row follows the document.
  "file.rename": "anyone",
  "file.icon": "anyone",
  // Hides a canvas from the local app's home screen. The cloud has no such list.
  "file.scratch": "nobody",
  tokens: "runner",
  note: "runner",
  "thread.create": "anyone",
  "thread.message": "anyone",
  // Resolving, reopening and moving a pin are anyone's, as on the canvas today.
  "thread.update": "anyone",
  // The canvas offers to delete a whole thread to anyone who can comment.
  "thread.delete": "anyone",
  // The canvas offers to edit or delete a message only to whoever wrote it.
  "thread.edit": "own-message",
  "thread.unmessage": "own-message",
  batch: "each",
};

/**
 * Why `actor` may not commit `op` to `doc` as it is, or null when they may. `actor` is the
 * runner's agent or a person who may steer the canvas; whoever may only look commits nothing.
 */
export function refusal(actor: Actor, op: Op, doc: Doc): string | null {
  switch (OP_RULES[op.op]) {
    case "anyone":
      return null;
    case "runner":
      return actor.kind === "agent" ? null : `Only the agent can send ${op.op}.`;
    case "nobody":
      return `${op.op} is not used in Ponzu Cloud.`;
    case "own-message":
      return wroteMessage(actor, op as Extract<Op, { messageId: string }>, doc)
        ? null
        : "Only whoever wrote a message can change or delete it.";
    case "each": {
      for (const child of (op as Extract<Op, { op: "batch" }>).ops) {
        const why = refusal(actor, child, doc);
        if (why) return why;
      }
      return null;
    }
  }
}

/**
 * Whether the message an op names was written by `actor`, as the canvas decides it, but by
 * id now that every person has one. A message the document does not hold yet passes: the
 * only way to bring one in is `thread.create` or `thread.message`, which are stamped with the
 * actor who sends them, so `applyOp` either finds it theirs or refuses the op.
 */
function wroteMessage(actor: Actor, op: { id: string; messageId: string }, doc: Doc): boolean {
  const message = doc.threads
    .find((thread) => thread.id === op.id)
    ?.messages.find((candidate) => candidate.id === op.messageId);
  if (!message) return true;
  const { author } = message;
  return author.kind === actor.kind && author.id === actor.id;
}
