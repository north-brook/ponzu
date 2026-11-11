import {
  type Doc,
  findArtboard,
  type Op,
  summarize,
  type Thread,
  threadPage,
  touchedArtboards,
} from "@ponzu/core";
import type { Design, EventPriority, OpEvent } from "@ponzu/db";
import type { CommentEvent, CommentItem, EditEvent, Person } from "@ponzu/runner/protocol";

/*
 * What the agent hears about a person's ops (docs/cloud.md, "Events"), in the shapes of the
 * runner protocol. A new comment or a reply is a `comment` event, `now` when it is on a board
 * the agent is working on and `next` otherwise, with the `comment` thread item that shows it in
 * the thread; any other change to the canvas (an edited or resolved comment among them, and
 * every undo and redo) is an `edit`, `later`, for the agent to see before it next touches that
 * board. The runner's own ops are not news to it, so they make no events.
 */

/**
 * The boards the agent is working on right now: none unless it is working. The runner reports
 * them (docs/cloud.md, "The runner").
 */
export function agentBoards(design: Pick<Design, "agentState" | "agentArtboards">): string[] {
  return design.agentState === "working" ? design.agentArtboards : [];
}

/**
 * The events of each op a person is committing, read against the document before and after
 * them. They are committed with the ops, which give each its `payload.seq`.
 */
export function eventsForPersonOps(
  design: Pick<Design, "agentState" | "agentArtboards">,
  person: Person,
  ops: { id: string; op: Op }[],
  docs: { before: Doc; after: Doc },
): OpEvent[] {
  const working = new Set(agentBoards(design));
  return ops.flatMap(({ id, op }): OpEvent[] => {
    const base = { opId: id, userId: person.id };
    const comments = commentsIn(op, docs.after);
    if (comments.length === 0) return [editEvent(person, { id, op }, docs)];
    return comments.map((comment) => {
      const priority: EventPriority =
        comment.artboardId !== null && working.has(comment.artboardId) ? "now" : "next";
      const item: CommentItem = {
        threadId: comment.threadId,
        messageId: comment.messageId,
        text: comment.text,
        artboardId: comment.artboardId,
        artboardName: comment.artboardName,
        ...placeOf(docs.after, comment.threadId),
        from: person,
      };
      return { ...base, kind: "comment", priority, payload: { ...comment }, comment: { ...item } };
    });
  });
}

/**
 * An op's `edit` event. An undo or a redo a person commits makes only this: the comments it
 * puts back (a redone comment, an undone thread deletion) were heard when they were first
 * made, so they are neither said to the agent again nor shown in the thread again.
 */
export function editEvent(
  person: Person,
  { id, op }: { id: string; op: Op },
  docs: { before: Doc; after: Doc },
): OpEvent {
  const artboards = touchedArtboards(docs.after, op).map((board) => ({
    id: board,
    name: artboardName(docs, board) ?? "",
  }));
  const payload: EditEvent = { summary: summarize(docs.after, op), artboards };
  return { opId: id, userId: person.id, kind: "edit", priority: "later", payload: { ...payload } };
}

/** The new comments and replies an op makes, as the agent is told of them. */
function commentsIn(op: Op, doc: Doc): CommentEvent[] {
  if (op.op === "batch") return op.ops.flatMap((inner) => commentsIn(inner, doc));
  if (op.op === "thread.create") {
    const [first] = op.thread.messages;
    return first ? [comment(doc, op.thread, first.id, first.text, false)] : [];
  }
  if (op.op === "thread.message") {
    const thread = doc.threads.find(({ id }) => id === op.id);
    return thread ? [comment(doc, thread, op.message.id, op.message.text, true)] : [];
  }
  return [];
}

function comment(
  doc: Doc,
  thread: Thread,
  messageId: string,
  text: string,
  reply: boolean,
): CommentEvent {
  const artboardId = thread.artboardId ?? null;
  return {
    threadId: thread.id,
    messageId,
    text,
    reply,
    artboardId,
    artboardName: artboardId ? (findArtboard(doc, artboardId)?.artboard.name ?? null) : null,
    nodeId: thread.nodeId ?? null,
  };
}

/**
 * Where a comment was left, as its thread item keeps it: the page and its name, and the pin's
 * place on that page, so the thread can name it and the canvas go to it after the thread is
 * gone. Its picture is its author's app's to attach (`attachCommentPicture`).
 */
export function placeOf(
  doc: Doc,
  threadId: string,
): Pick<CommentItem, "pageId" | "pageName" | "at"> {
  const thread = doc.threads.find(({ id }) => id === threadId);
  const page = thread ? threadPage(doc, thread) : null;
  if (!thread || !page) return {};
  const board = thread.artboardId ? findArtboard(doc, thread.artboardId)?.artboard : undefined;
  return {
    pageId: page.id,
    pageName: page.name,
    at: { x: (board?.x ?? 0) + thread.x, y: (board?.y ?? 0) + thread.y },
  };
}

/** A board's name after the ops, or before them for one they deleted. */
function artboardName(docs: { before: Doc; after: Doc }, id: string): string | undefined {
  return (findArtboard(docs.after, id) ?? findArtboard(docs.before, id))?.artboard.name;
}
