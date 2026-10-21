import { type Doc, describeNode, findArtboard, type PonzuEvent } from "@ponzu/core";
import { z } from "zod";
import { fileArg, ToolError, tool } from "./define.ts";
import { GUIDES, type GuideTopic } from "./guides.ts";
import { apply } from "./util.ts";

const EVENT_TYPES = [
  "change",
  "comment.created",
  "comment.replied",
  "comment.edited",
  "comment.resolved",
  "comment.reopened",
  "selection",
  "file.changed",
  "presence",
] as const;

export function describeEvent(doc: Doc | undefined, e: PonzuEvent): string {
  const ab = (id: string) => (doc ? (findArtboard(doc, id)?.artboard.name ?? id) : id);
  switch (e.type) {
    case "change":
      return `#${e.seq} change by ${e.origin.name}: ${e.summary}${e.artboards.length ? ` (${e.artboards.map((a) => `"${ab(a)}"`).join(", ")})` : ""}`;
    case "comment.created":
      return `#${e.seq} new comment ${e.thread} on ${e.artboard ? `"${ab(e.artboard)}"` : "the canvas"} from ${e.author}: "${e.text}"`;
    case "comment.replied":
      return `#${e.seq} reply in ${e.thread} from ${e.author}: "${e.text}"`;
    case "comment.edited":
      return `#${e.seq} ${e.author} edited a message in ${e.thread}, now: "${e.text}"`;
    case "comment.resolved":
      return `#${e.seq} ${e.author} resolved ${e.thread}`;
    case "comment.reopened":
      return `#${e.seq} ${e.author} reopened ${e.thread}`;
    case "selection":
      return `#${e.seq} selection: ${e.ids.length ? e.ids.join(", ") : "nothing"}`;
    case "file.changed":
      return `#${e.seq} ${e.path} changed on disk${e.artboards.length ? ` (${e.artboards.map((a) => `"${ab(a)}"`).join(", ")})` : ""}`;
    case "presence":
      return `#${e.seq} presence: ${e.presence.map((p) => p.name).join(", ")}`;
  }
}

export const listenTools = [
  tool({
    name: "wait_for_activity",
    title: "Wait for activity",
    group: "listen",
    readOnly: true,
    description:
      "Long-poll for what people do in the canvas: new comments and replies, selection changes, edits made in a text editor, other agents' changes. Returns immediately if anything happened after `since`; otherwise waits up to `timeout` seconds. Pass back the returned cursor next time so nothing is missed. This is the heart of the collaborate loop (get_guide('collaborate')).",
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
    async handler(args, { ws, caller, signal }) {
      const { key, design } = await ws.resolve(args.file);
      // A cursor past the end came from a Ponzu that has since restarted: start from now.
      const cursor =
        args.since !== undefined && args.since <= ws.events.cursor ? args.since : ws.events.cursor;
      const types = args.types ?? [
        "comment.created",
        "comment.replied",
        "comment.edited",
        "comment.reopened",
        "file.changed",
      ];
      ws.presence.touch(caller, { file: key, listening: true });
      const events = await ws.events.wait(
        cursor,
        (args.timeout ?? 60) * 1000,
        {
          key,
          types: [...types],
          excludeAuthor: args.include_own ? undefined : caller.author.name,
        },
        signal,
      );
      const next = events.length
        ? events[events.length - 1]!.event.seq
        : Math.max(cursor, ws.events.cursor);
      ws.presence.touch(caller, { listening: false, listenedAt: Date.now() });
      if (!events.length)
        return { text: `Nothing new. cursor=${next}`, data: { cursor: next, events: [] } };
      return {
        text: `${events.map((e) => describeEvent(design.doc, e.event)).join("\n")}\ncursor=${next}`,
        data: { cursor: next, events: events.map((e) => e.event) },
      };
    },
  }),

  tool({
    name: "start_working",
    title: "Start working",
    group: "listen",
    description:
      "Tell the person which artboards you're about to change. The canvas traces their outline and shows your status and icon in their header; their page and file tabs shimmer. Call finish_working when you're done.",
    input: {
      file: fileArg,
      artboards: z.array(z.string()).min(1),
      status: z
        .string()
        .optional()
        .describe(
          "A few words the person reads on the artboard, e.g. 'tightening the hero'. Without it they see 'Working'.",
        ),
    },
    async handler(args, { ws, caller }) {
      const { key, design } = await ws.resolve(args.file);
      for (const id of args.artboards)
        if (!findArtboard(design.doc, id)) throw new ToolError(`No artboard ${id}.`);
      ws.presence.touch(caller, { working: args.artboards, status: args.status, file: key });
      return { text: `Working on ${args.artboards.join(", ")}.` };
    },
  }),

  tool({
    name: "finish_working",
    title: "Finish working",
    group: "listen",
    description: "Clear your working indicator. Always call this when you finish or stop.",
    input: { file: fileArg },
    async handler(_args, { ws, caller }) {
      ws.presence.touch(caller, { working: [], status: undefined });
      return { text: "Done." };
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
      const { design } = await ctx.ws.resolve(args.file);
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
    async handler(args, { ws }) {
      const { design } = await ws.resolve(args.file);
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
      "House rules and workflows for designing in Ponzu. Read 'basics' once per session before writing. Topics: basics, layout, typography, collaborate, variations, implement, format (writing the files directly), motion, mobile.",
    input: { topic: z.enum(Object.keys(GUIDES) as [GuideTopic, ...GuideTopic[]]) },
    handler({ topic }) {
      return { text: GUIDES[topic] };
    },
  }),
];

export { describeNode };
