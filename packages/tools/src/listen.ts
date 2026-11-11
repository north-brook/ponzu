import { findArtboard, INTENT_MAX } from "@ponzu/core";
import { z } from "zod";
import { ToolError, tool } from "./define.ts";
import { apply, designOf } from "./util.ts";

export const listenTools = [
  tool({
    name: "set_status",
    title: "Set status",
    group: "listen",
    description:
      "Optional. Say in a few words what you're doing, e.g. 'tightening the hero'; the person sees it while you work. Artboards you change already show as worked on, until you go a couple of minutes without a tool call. Pass artboards to claim them before your first edit.",
    input: {
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
      const { key, design } = await designOf(ctx, args.artboards);
      for (const id of args.artboards ?? [])
        if (!findArtboard(design.doc, id)) throw new ToolError(`No artboard ${id}.`);
      if (args.artboards) ws.presence.claimed(caller, key, args.artboards, args.status);
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
      "Save a markdown note with the design: decisions, the brief, open questions, what you learned about the person's taste. Notes outlive the conversation, so a later session can pick up where you left off. Overwrites; read first to append.",
    input: {
      name: z
        .string()
        .regex(/^[\w-]+$/, "letters, numbers, dash, underscore")
        .describe("e.g. brief, decisions, field-notes"),
      content: z.string().nullable().describe("Markdown. null deletes the note."),
    },
    async handler(args, ctx) {
      const { design } = await designOf(ctx);
      apply(design, { op: "note", name: args.name, content: args.content }, ctx);
      return { text: `${args.content === null ? "Deleted" : "Saved"} note ${args.name}.` };
    },
  }),

  tool({
    name: "read_notes",
    title: "Read notes",
    group: "listen",
    readOnly: true,
    description:
      "Read the design's notes. Omit name to read them all. Do this at the start of a session.",
    input: { name: z.string().optional() },
    async handler(args, ctx) {
      const { design } = await designOf(ctx);
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
      return { text: names.map((n) => `# ${n}\n${notes[n]}`).join("\n\n") };
    },
  }),
];

/** `get_guide` over a host's guides. `about` says what each topic holds, for the description. */
export function guideTool(guides: Record<string, string>, about: string) {
  const topics = Object.keys(guides) as [string, ...string[]];
  return tool({
    name: "get_guide",
    title: "Get guide",
    group: "listen",
    readOnly: true,
    description: `House rules and workflows for designing in Ponzu. Read 'basics' once per session before writing. Topics: ${about}.`,
    input: { topic: z.enum(topics) },
    handler({ topic }) {
      return { text: guides[topic]! };
    },
  });
}
