import { type Doc, summarize, threadEvents, touchedArtboards } from "@ponzu/core";
import type { Design, EventPriority, NewEvent, StoredOp } from "@ponzu/db";

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

/** One event per op a person committed, read against the document after them. */
export function eventsForPersonOps(
  design: Pick<Design, "id" | "agentState" | "agentArtboards">,
  userId: string,
  ops: StoredOp[],
  doc: Doc,
): NewEvent[] {
  const working = new Set(agentBoards(design));
  return ops.map((stored) => {
    const base = { designId: design.id, userId };
    const summary = summarize(doc, stored.op);
    const comments = threadEvents(stored.op).map((event) => {
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
        payload: { seq: stored.seq, summary, artboards: touchedArtboards(doc, stored.op) },
      };
    }
    const priority: EventPriority = comments.some(
      ({ artboardId }) => artboardId !== null && working.has(artboardId),
    )
      ? "now"
      : "next";
    return { ...base, kind: "comment", priority, payload: { seq: stored.seq, summary, comments } };
  });
}
