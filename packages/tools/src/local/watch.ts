import { type Doc, findArtboard, type PonzuEvent, type Thread } from "@ponzu/core";
import { z } from "zod";
import type { OpenCanvas } from "../canvas.ts";
import type { KeyedEvent, ToolContext } from "../context.ts";
import { threadLine } from "../converse.ts";
import { type ToolDef, tool } from "../define.ts";
import { fileArg, label, resolveFile } from "./files.ts";

/*
 * The watch loop: a local agent polls for the person's comments instead of ending its turn.
 * The cloud has none (comments arrive as turns), so this goes with the local server.
 */

const EVENT_TYPES = [
  "change",
  "comment.created",
  "comment.replied",
  "comment.edited",
  "comment.resolved",
  "comment.reopened",
  "file.changed",
  "presence",
] as const;

export function describeEvent(doc: Doc | undefined, e: PonzuEvent): string {
  const ab = (id: string) => (doc ? (findArtboard(doc, id)?.artboard.name ?? id) : id);
  switch (e.type) {
    case "change":
      return `change by ${e.origin.name}: ${e.summary}${e.artboards.length ? ` (${e.artboards.map((a) => `"${ab(a)}"`).join(", ")})` : ""}`;
    case "comment.created":
      return `new comment ${e.thread} on ${e.artboard ? `"${ab(e.artboard)}"` : "the canvas"} from ${e.author}: "${e.text}"`;
    case "comment.replied":
      return `reply in ${e.thread} from ${e.author}: "${e.text}"`;
    case "comment.edited":
      return `${e.author} edited a message in ${e.thread}, now: "${e.text}"`;
    case "comment.resolved":
      return `${e.author} resolved ${e.thread}`;
    case "comment.reopened":
      return `${e.author} reopened ${e.thread}`;
    case "file.changed":
      return `${e.path} changed on disk${e.artboards.length ? ` (${e.artboards.map((a) => `"${ab(a)}"`).join(", ")})` : ""}`;
    case "presence":
      return `presence: ${e.presence.map((p) => p.name).join(", ")}`;
  }
}

const GAP_NOTE = {
  restart: "Ponzu restarted since your last wait, so what happened before then isn't here.",
  dropped: "More happened since your last wait than Ponzu keeps, so some of it isn't here.",
} as const;

/** How many waiting threads a wait spells out; list_comments has the rest. */
const WAITING_SHOWN = 10;

/** Open threads where the person spoke last: each still needs the agent. */
function waitingOn(threads: Thread[]): Thread[] {
  return threads.filter(
    (t) => t.status === "open" && t.messages[t.messages.length - 1]?.author.kind === "user",
  );
}

/** The waiting threads in each design, naming the design for any but the one the call is on. */
function waitingText(files: OpenCanvas[], all: OpenCanvas[]): { text: string; ids: string[] } {
  const lines: string[] = [];
  const ids: string[] = [];
  for (const [i, f] of files.entries()) {
    for (const t of waitingOn(f.canvas.doc.threads)) {
      ids.push(t.id);
      // threadLine ends "last from Sam" on a thread with replies: say what they said last.
      const latest = t.messages.length > 1 ? `: "${t.messages.at(-1)!.text}"` : "";
      lines.push(`${threadLine(f.canvas.doc, t)}${latest}${i ? ` (in ${label(f, all)})` : ""}`);
    }
  }
  if (!lines.length) return { text: "No open threads are waiting on you.", ids };
  const shown = lines.slice(0, WAITING_SHOWN);
  if (lines.length > WAITING_SHOWN)
    shown.push(`… and ${lines.length - WAITING_SHOWN} more (list_comments)`);
  return { text: `Open threads waiting on you; handle these first:\n${shown.join("\n")}`, ids };
}

const COMMENT_EVENTS = new Set(["comment.created", "comment.replied"]);

/**
 * Comments the person left after `cursor` in designs the wait didn't hear
 * from: what a wider watch would have caught. Counted, never shown.
 */
function missedElsewhere(events: KeyedEvent[], scope: string[], all: OpenCanvas[]): number {
  return events.filter((e) => {
    if (scope.includes(e.key) || !COMMENT_EVENTS.has(e.event.type) || !("thread" in e.event))
      return false;
    const { thread, author } = e.event as { thread: string; author: string };
    const doc = all.find((d) => d.key === e.key)?.canvas.doc;
    const t = doc?.threads.find((x) => x.id === thread);
    return !!t?.messages.some((m) => m.author.kind === "user" && m.author.name === author);
  }).length;
}

export const waitForActivity = tool({
  name: "wait_for_activity",
  title: "Wait for activity",
  group: "listen",
  readOnly: true,
  description:
    "Watch the canvas. Call this instead of ending your turn whenever the person might react to your work there: after you put something up for review, or while you design together. Calling it again and again is the loop (get_guide('watch')). Long-polls for what people do in the canvas: new comments and replies, edits made in a text editor, other agents' changes, in this file and the others you've worked in this session, saying which file each is in. Returns immediately if anything happened after `since`; otherwise waits up to `timeout` seconds. Pass back the returned cursor next time so nothing is missed. If Ponzu restarts during the wait, the wait carries on once it's back. If it restarted or lost track before you waited, it returns at once with the open threads waiting on you: handle those, then keep watching with the cursor it gives. The person's chat messages still reach you between waits.",
  input: {
    file: fileArg,
    since: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Cursor from the last call. Omit to start from now."),
    types: z.array(z.enum(EVENT_TYPES)).optional().describe("Default: comments and file changes."),
    timeout: z.number().min(0).max(300).optional().describe("Seconds to wait. Default 60."),
    include_own: z.boolean().optional().describe("Include events caused by you. Default false."),
  },
  async handler(args, ctx) {
    const { ws, caller, signal } = ctx;
    const { key } = await resolveFile(ctx, args.file);
    const gap = args.since === undefined ? undefined : ws.events.gap(args.since);
    const types = args.types ?? [
      "comment.created",
      "comment.replied",
      "comment.edited",
      "comment.reopened",
      "file.changed",
    ];
    // Going back to listening ends a pass: what it was working on is done.
    ws.presence.touch(caller, { file: key, listening: true, working: [], status: undefined });
    // Every design this agent has worked in, so moving to a new one doesn't deafen it to the last.
    const all = ws.canvases();
    const scope = [key, ...(ctx.session?.files ?? []).filter((k) => k !== key)];
    const files = scope.flatMap((k) => all.filter((d) => d.key === k));
    // What happened after the cursor can't all be told: say so, with what still needs the agent.
    const recover = (gap: "restart" | "dropped") => {
      const next = ws.events.cursor;
      ws.presence.touch(caller, { listening: false, listenedAt: Date.now() });
      const waiting = waitingText(files, all);
      return {
        text: `${GAP_NOTE[gap]} ${waiting.text}\nKeep watching: wait again with cursor=${next}.`,
        data: { cursor: next, events: [], gap, waiting: waiting.ids },
        metrics: { cursor: gap, events: 0, scope_files: files.length },
      };
    };
    if (gap) return recover(gap);
    const cursor = args.since ?? ws.events.cursor;
    const excludeAuthor = args.include_own ? undefined : caller.author.name;
    const events = await ws.events.wait(
      cursor,
      (args.timeout ?? 60) * 1000,
      { keys: scope, types: [...types], excludeAuthor },
      signal,
    );
    // The ring can let go of what came in while the wait settled, too.
    const lost = ws.events.gap(cursor);
    if (lost) return recover(lost);
    const next = events.length
      ? events[events.length - 1]!.event.seq
      : Math.max(cursor, ws.events.cursor);
    ws.presence.touch(caller, { listening: false, listenedAt: Date.now() });
    // Designs can open while the wait runs: look again, so their comments are counted and named.
    const open = ws.canvases();
    const metrics = {
      cursor: args.since === undefined ? "none" : "ok",
      events: events.length,
      scope_files: files.length,
      missed_elsewhere: missedElsewhere(ws.events.since(cursor, { excludeAuthor }), scope, open),
    };
    if (!events.length)
      return {
        text: `Nothing new. Wait again with cursor=${next}. The person's chat messages reach you between waits, so keep watching.`,
        data: { cursor: next, events: [] },
        metrics,
      };
    const line = (e: KeyedEvent) => {
      const f = open.find((d) => d.key === e.key);
      const where = f && e.key !== key ? ` (in ${label(f, open)})` : "";
      return describeEvent(f?.canvas.doc, e.event) + where;
    };
    return {
      text: `${events.map(line).join("\n")}\ncursor=${next}`,
      data: { cursor: next, events: events.map((e) => ({ ...e.event, file: e.key })) },
      metrics,
    };
  },
});

/**
 * Checking work is the moment before an agent hands it back, and so the moment
 * it decides whether to end its turn or watch for the person's comments.
 */
export const WATCH_REMINDER =
  "Once this pass is done, watch the canvas (wait_for_activity) instead of ending your turn: the person can steer with comments, and chat still reaches you between waits.";

function remindToWatch({ ws, caller }: ToolContext): boolean {
  return caller.author.kind === "agent" && ws.presence.shouldRemindToWatch(caller.id);
}

/** A tool that looks at the work, ending with the reminder when the agent isn't watching. */
export function reminding(def: ToolDef<any>): ToolDef<any> {
  return {
    ...def,
    async handler(args, ctx) {
      const result = await def.handler(args, ctx);
      if (result.isError || !remindToWatch(ctx)) return result;
      return { ...result, text: `${result.text}\n${WATCH_REMINDER}` };
    },
  };
}
