import {
  type Doc,
  describeNode,
  findArtboard,
  locate,
  newId,
  type Thread,
  threadPage,
} from "@ponzu/core";
import { z } from "zod";
import { fileArg, ToolError, tool } from "./define.ts";
import { apply, resolveFile } from "./util.ts";

export function threadLine(doc: Doc, t: Thread): string {
  const node = t.nodeId ? locate(doc, t.nodeId)?.node : undefined;
  let where: string;
  if (t.artboardId) {
    const ab = findArtboard(doc, t.artboardId)?.artboard;
    where = `${ab ? `"${ab.name}"` : t.artboardId}${node ? ` › ${describeNode(node)} (${node.id})` : ""}`;
  } else {
    const page = threadPage(doc, t);
    where = `the canvas of page "${page?.name ?? t.pageId}" at ${t.x}, ${t.y}`;
  }
  const first = t.messages[0];
  const last = t.messages[t.messages.length - 1];
  const replies = t.messages.length - 1;
  return `${t.id} [${t.status}] on ${where}: ${first?.author.name}: "${first?.text}"${replies ? ` · ${replies} repl${replies === 1 ? "y" : "ies"}, last from ${last?.author.name}` : ""}`;
}

export const converseTools = [
  tool({
    name: "list_comments",
    title: "List comments",
    group: "converse",
    readOnly: true,
    description:
      "Comment threads in the file. Open ones by default. Most are pinned to an artboard and usually a node inside it; some sit on the open canvas of a page, beside the artboards.",
    input: {
      file: fileArg,
      status: z.enum(["open", "resolved", "all"]).optional(),
      artboard: z.string().optional(),
    },
    async handler(args, ctx) {
      const { design } = await resolveFile(ctx, args.file, [args.artboard]);
      const doc = design.doc;
      const status = args.status ?? "open";
      const threads = doc.threads.filter(
        (t) =>
          (status === "all" || t.status === status) &&
          (!args.artboard || t.artboardId === args.artboard),
      );
      if (!threads.length)
        return { text: status === "open" ? "No open comments." : "No comments." };
      return { text: threads.map((t) => threadLine(doc, t)).join("\n") };
    },
  }),

  tool({
    name: "get_comment",
    title: "Get comment thread",
    group: "converse",
    readOnly: true,
    description: "A thread with every message, and what its pin points at.",
    input: { file: fileArg, id: z.string() },
    async handler(args, ctx) {
      const { design } = await resolveFile(ctx, args.file, [args.id]);
      const t = design.doc.threads.find((x) => x.id === args.id);
      if (!t) throw new ToolError(`No thread ${args.id}.`);
      const lines = [
        threadLine(design.doc, t),
        ...t.messages.map(
          (m) =>
            `  ${m.author.name} (${m.author.kind}), ${new Date(m.createdAt).toISOString()}${m.editedAt ? " (edited)" : ""}: ${m.text}`,
        ),
      ];
      return { text: lines.join("\n") };
    },
  }),

  tool({
    name: "create_comment",
    title: "Create comment",
    group: "converse",
    description:
      "Start a thread pinned to a node or artboard: ask the person a question, explain a decision, or flag something.",
    input: {
      file: fileArg,
      on: z.string().describe("Node or artboard id."),
      text: z.string().min(1),
    },
    async handler(args, ctx) {
      const { design } = await resolveFile(ctx, args.file, [args.on]);
      const doc = design.doc;
      const hit = locate(doc, args.on);
      if (!hit) throw new ToolError(`No node or artboard ${args.on}.`);
      const now = Date.now();
      const thread: Thread = {
        id: newId("th"),
        artboardId: hit.artboard.id,
        ...(hit.parent ? { nodeId: hit.node.id } : {}),
        x: 24,
        y: 24,
        status: "open",
        createdAt: now,
        updatedAt: now,
        messages: [{ id: newId("m"), author: ctx.caller.author, text: args.text, createdAt: now }],
      };
      apply(design, { op: "thread.create", thread }, ctx);
      return { text: `Created thread ${thread.id}.` };
    },
  }),

  tool({
    name: "reply",
    title: "Reply",
    group: "converse",
    description:
      "Reply in a comment thread, in one or two sentences. Only when the person needs to read it: to answer a question, give a recommendation, say how you read an ambiguous comment, or explain what you couldn't do. For a change you simply made, don't reply; resolve it with set_comment_status. Leave a thread you replied to open: resolved threads leave the canvas, so resolve: true hides your reply from the person.",
    input: {
      file: fileArg,
      thread: z.string(),
      text: z.string().min(1),
      resolve: z.boolean().optional(),
    },
    async handler(args, ctx) {
      const { design } = await resolveFile(ctx, args.file, [args.thread]);
      const t = design.doc.threads.find((x) => x.id === args.thread);
      if (!t) throw new ToolError(`No thread ${args.thread}.`);
      const message = {
        id: newId("m"),
        author: ctx.caller.author,
        text: args.text,
        createdAt: Date.now(),
      };
      apply(
        design,
        args.resolve
          ? {
              op: "batch",
              ops: [
                { op: "thread.message", id: t.id, message },
                { op: "thread.update", id: t.id, status: "resolved" },
              ],
            }
          : { op: "thread.message", id: t.id, message },
        ctx,
      );
      return { text: `Replied${args.resolve ? " and resolved" : ""}.` };
    },
  }),

  tool({
    name: "set_comment_status",
    title: "Set comment status",
    group: "converse",
    description:
      "Resolve or reopen a thread without replying. Resolve a comment once you've done what it asked; that hides its pin from the canvas, and the change speaks for itself.",
    input: { file: fileArg, thread: z.string(), status: z.enum(["open", "resolved"]) },
    async handler(args, ctx) {
      const { design } = await resolveFile(ctx, args.file, [args.thread]);
      if (!design.doc.threads.some((t) => t.id === args.thread))
        throw new ToolError(`No thread ${args.thread}.`);
      apply(design, { op: "thread.update", id: args.thread, status: args.status }, ctx);
      return { text: `Thread ${args.thread} is ${args.status}.` };
    },
  }),

  tool({
    name: "send_feedback",
    title: "Send feedback to the Ponzu team",
    group: "converse",
    description:
      "Tell the people who build Ponzu how it's working for you. Send it when a tool confused you, failed or got in your way, when you had to work around something Ponzu can't do, when something worked notably well, or when the person asks you to pass something on. Keep it about Ponzu: no design content, file names, paths or personal details. It goes to the Ponzu team, not to the person; carry on with their task afterwards.",
    input: {
      sentiment: z.enum(["positive", "neutral", "negative", "mixed"]),
      category: z.enum(["bug", "missing_capability", "confusing_tool", "praise", "other"]),
      summary: z.string().min(1).max(300).describe("One sentence."),
      details: z
        .string()
        .max(4000)
        .optional()
        .describe(
          "What happened, which tool, and what would have helped. Leave design content, file names, paths and personal details out of any argument or error you quote.",
        ),
      tool: z.string().optional().describe("The Ponzu tool it's about, if any."),
    },
    async handler(args, { ws, caller }) {
      const sent = await ws.telemetry?.feedback({ ...args, client: caller.client });
      if (!sent)
        return {
          text: "Not sent: this Ponzu doesn't share anything with the Ponzu team (telemetry is off). Mention it to the person if it matters.",
        };
      return { text: "Sent to the Ponzu team. Thank you." };
    },
  }),
];

export { findArtboard };
