import {
  type Doc,
  describeNode,
  findArtboard,
  INTENT_MAX,
  type PonzuEvent,
  type Thread,
} from "@ponzu/core";
import { z } from "zod";
import { threadLine } from "./converse.ts";
import { fileArg, ToolError, tool } from "./define.ts";
import { GUIDES, type GuideTopic } from "./guides.ts";
import { apply, resolveFile } from "./util.ts";

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

function waitingText(doc: Doc, waiting: Thread[]): string {
  if (!waiting.length) return "No open threads are waiting on you.";
  // threadLine ends "last from Sam" on a thread with replies: say what they said last.
  const lines = waiting
    .slice(0, WAITING_SHOWN)
    .map(
      (t) =>
        `${threadLine(doc, t)}${t.messages.length > 1 ? `: "${t.messages.at(-1)!.text}"` : ""}`,
    );
  if (waiting.length > WAITING_SHOWN)
    lines.push(`… and ${waiting.length - WAITING_SHOWN} more (list_comments)`);
  return `Open threads waiting on you; handle these first:\n${lines.join("\n")}`;
}

export const listenTools = [
  tool({
    name: "wait_for_activity",
    title: "Wait for activity",
    group: "listen",
    readOnly: true,
    description:
      "Watch the canvas. Call this instead of ending your turn whenever the person might react to your work there: after you put something up for review, or while you design together. Calling it again and again is the loop (get_guide('watch')). Long-polls for what people do in the canvas: new comments and replies, edits made in a text editor, other agents' changes. Returns immediately if anything happened after `since`; otherwise waits up to `timeout` seconds. Pass back the returned cursor next time so nothing is missed. If Ponzu restarted or lost track since then, it returns at once with the open threads waiting on you. The person's chat messages still reach you between waits.",
    input: {
      file: fileArg,
      since: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Cursor from the last call. Omit to start from now."),
      types: z
        .array(z.enum(EVENT_TYPES))
        .optional()
        .describe("Default: comments and file changes."),
      timeout: z.number().min(0).max(300).optional().describe("Seconds to wait. Default 60."),
      include_own: z.boolean().optional().describe("Include events caused by you. Default false."),
    },
    async handler(args, ctx) {
      const { ws, caller, signal } = ctx;
      const { key, design } = await resolveFile(ctx, args.file);
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
      // What happened after the cursor can't all be told: say so, with what still needs the agent.
      const recover = (gap: "restart" | "dropped") => {
        const next = ws.events.cursor;
        ws.presence.touch(caller, { listening: false, listenedAt: Date.now() });
        const waiting = waitingOn(design.doc.threads);
        return {
          text: `${GAP_NOTE[gap]} ${waitingText(design.doc, waiting)}\nWait again with cursor=${next}.`,
          data: { cursor: next, events: [], gap, waiting: waiting.map((t) => t.id) },
          metrics: { cursor: gap, events: 0 },
        };
      };
      if (gap) return recover(gap);
      const cursor = args.since ?? ws.events.cursor;
      const events = await ws.events.wait(
        cursor,
        (args.timeout ?? 60) * 1000,
        {
          keys: [key],
          types: [...types],
          excludeAuthor: args.include_own ? undefined : caller.author.name,
        },
        signal,
      );
      // The ring can let go of what came in while the wait settled, too.
      const lost = ws.events.gap(cursor);
      if (lost) return recover(lost);
      const next = events.length
        ? events[events.length - 1]!.event.seq
        : Math.max(cursor, ws.events.cursor);
      ws.presence.touch(caller, { listening: false, listenedAt: Date.now() });
      const metrics = { cursor: args.since === undefined ? "none" : "ok", events: events.length };
      if (!events.length)
        return {
          text: `Nothing new. Wait again with cursor=${next}. The person's chat messages reach you between waits, so keep watching.`,
          data: { cursor: next, events: [] },
          metrics,
        };
      return {
        text: `${events.map((e) => describeEvent(design.doc, e.event)).join("\n")}\ncursor=${next}`,
        data: { cursor: next, events: events.map((e) => e.event) },
        metrics,
      };
    },
  }),

  tool({
    name: "set_status",
    title: "Set status",
    group: "listen",
    description:
      "Optional. Say in a few words what you're doing, e.g. 'tightening the hero'; the person reads it on hover over the yuzu rain in the header of each artboard you're working on. Artboards you change already show as worked on (a yuzu ring breathes round them, their page and file tabs shimmer) until you go two minutes without a tool call or call wait_for_activity. Pass artboards to claim them before your first edit.",
    input: {
      file: fileArg,
      status: z.string().min(1).describe("A few words, lowercase, e.g. 'adding the autumn drop'."),
      intent: z
        .string()
        .min(1)
        .max(INTENT_MAX)
        .optional()
        .describe(
          "When you take on a new request: what the person asked for, distilled to one plain line in their voice, e.g. 'A fitness app: today, workout and progress screens.' It's kept in the design's history. Not your plan, and only once per request.",
        ),
      artboards: z
        .array(z.string())
        .optional()
        .describe(
          "The artboards this is about, replacing the ones you were working on. Omit to keep them.",
        ),
    },
    async handler(args, ctx) {
      const { ws, caller } = ctx;
      const { key, design } = await resolveFile(ctx, args.file, args.artboards);
      for (const id of args.artboards ?? [])
        if (!findArtboard(design.doc, id)) throw new ToolError(`No artboard ${id}.`);
      if (args.artboards)
        ws.presence.touch(caller, { file: key, working: args.artboards, status: args.status });
      else ws.presence.worked(caller, key, { status: args.status });
      if (args.intent) ws.intent?.(key, args.intent.trim(), caller.author);
      return { text: `Status: ${args.status}.` };
    },
  }),

  tool({
    name: "write_note",
    title: "Write note",
    group: "listen",
    description:
      "Save a markdown note inside the .design (notes/<name>.md): decisions, the brief, open questions, what you learned about the person's taste. Notes outlive the chat, so the next agent session can pick up where you left off. Overwrites; read first to append.",
    input: {
      file: fileArg,
      name: z
        .string()
        .regex(/^[\w-]+$/, "letters, numbers, dash, underscore")
        .describe("e.g. brief, decisions, field-notes"),
      content: z.string().nullable().describe("Markdown. null deletes the note."),
    },
    async handler(args, ctx) {
      const { design } = await resolveFile(ctx, args.file);
      apply(design, { op: "note", name: args.name, content: args.content }, ctx);
      return {
        text:
          args.content === null ? `Deleted notes/${args.name}.md` : `Saved notes/${args.name}.md`,
      };
    },
  }),

  tool({
    name: "read_notes",
    title: "Read notes",
    group: "listen",
    readOnly: true,
    description:
      "Read the file's notes. Omit name to read them all. Do this at the start of a session.",
    input: { file: fileArg, name: z.string().optional() },
    async handler(args, ctx) {
      const { design } = await resolveFile(ctx, args.file);
      const notes = design.doc.notes;
      if (args.name) {
        const n = notes[args.name];
        if (n === undefined)
          throw new ToolError(
            `No note ${args.name}. Notes: ${Object.keys(notes).join(", ") || "none"}`,
          );
        return { text: n };
      }
      const names = Object.keys(notes);
      if (!names.length) return { text: "No notes yet." };
      return { text: names.map((n) => `# notes/${n}.md\n${notes[n]}`).join("\n\n") };
    },
  }),

  tool({
    name: "get_guide",
    title: "Get guide",
    group: "listen",
    readOnly: true,
    description:
      "House rules and workflows for designing in Ponzu. Read 'basics' once per session before writing. Topics: basics, layout, typography, watch (the comment loop), variations, implement, format (writing the files directly), motion, mobile.",
    input: { topic: z.enum(Object.keys(GUIDES) as [GuideTopic, ...GuideTopic[]]) },
    handler({ topic }) {
      return { text: GUIDES[topic] };
    },
  }),
];

export { describeNode };
