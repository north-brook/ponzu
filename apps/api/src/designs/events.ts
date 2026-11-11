import type { Op } from "@ponzu/core";
import { type Doc, summarize, threadEvents, touchedArtboards } from "@ponzu/core";
import type { Design, EventPriority, OpEvent } from "@ponzu/db";

/*
 * What the agent hears about a person's ops (docs/cloud.md, "Events"). A comment is `now`
 * when it is on a board the agent is working on and `next` otherwise; any other change to the
 * canvas is `later`, for the agent to see before it next touches that board. The runner's own
 * ops are not news to it, so they make no events.
 */

/**
 * The boards the agent is working on right now: none unless it is working. The runner reports
 * them (docs/cloud.md, "The runner").
 */
export function agentBoards(design: Pick<Design, "agentState" | "agentArtboards">): string[] {
  return design.agentState === "working" ? design.agentArtboards : [];
}

/**
 * One event per op a person is committing, read against the document after them. They are
 * committed with the ops, which give each its `payload.seq`.
 */
export function eventsForPersonOps(
  design: Pick<Design, "agentState" | "agentArtboards">,
  userId: string,
  ops: { id: string; op: Op }[],
  doc: Doc,
): OpEvent[] {
  const working = new Set(agentBoards(design));
  return ops.map(({ id, op }) => {
    const base = { opId: id, userId };
    const summary = summarize(doc, op);
    const comments = threadEvents(op).map((event) => {
      const threadId = event.kind === "created" ? event.thread.id : event.id;
      const thread =
        event.kind === "created" ? event.thread : doc.threads.find(({ id }) => id === threadId);
      return {
        kind: event.kind,
        threadId,
        artboardId: thread?.artboardId ?? null,
        ...(event.kind === "created" ? { text: event.thread.messages[0]?.text ?? "" } : {}),
        ...(event.kind === "message" || event.kind === "edited" ? { text: event.text } : {}),
        ...(event.kind === "status" ? { status: event.status } : {}),
      };
    });
    if (comments.length === 0) {
      return {
        ...base,
        kind: "edit",
        priority: "later",
        payload: { summary, artboards: touchedArtboards(doc, op) },
      };
    }
    const priority: EventPriority = comments.some(
      ({ artboardId }) => artboardId !== null && working.has(artboardId),
    )
      ? "now"
      : "next";
    return { ...base, kind: "comment", priority, payload: { summary, comments } };
  });
}
