import { type Doc, describeNode, findArtboard, locate, newId, type Thread } from "@ponzu/core";
import { z } from "zod";
import { fileArg, ToolError, tool } from "./define.ts";
import { apply } from "./util.ts";

export function threadLine(doc: Doc, t: Thread): string {
  const ab = findArtboard(doc, t.artboardId)?.artboard;
  const node = t.nodeId ? locate(doc, t.nodeId)?.node : undefined;
  const where = `${ab ? `"${ab.name}"` : t.artboardId}${node ? ` › ${describeNode(node)} (${node.id})` : ""}`;
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
      "Comment threads in the file. Open ones by default. Each thread is pinned to an artboard and usually a node inside it.",
    input: {
      file: fileArg,
      status: z.enum(["open", "resolved", "all"]).optional(),
      artboard: z.string().optional(),
    },
    async handler(args, { ws }) {
      const { design } = await ws.resolve(args.file);
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
    async handler(args, { ws }) {
      const { design } = await ws.resolve(args.file);
      const t = design.doc.threads.find((x) => x.id === args.id);
      if (!t) throw new ToolError(`No thread ${args.id}.`);
      const lines = [
        threadLine(design.doc, t),
        ...t.messages.map(
          (m) =>
            `  ${m.author.name} (${m.author.kind}), ${new Date(m.createdAt).toISOString()}: ${m.text}`,
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
      const { design } = await ctx.ws.resolve(args.file);
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
      "Reply in a comment thread. When you've done what a comment asked, reply with what changed (one or two sentences) and set resolve: true. Leave questions and decisions open for the person.",
    input: {
      file: fileArg,
      thread: z.string(),
      text: z.string().min(1),
      resolve: z.boolean().optional(),
    },
    async handler(args, ctx) {
      const { design } = await ctx.ws.resolve(args.file);
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
    description: "Resolve or reopen a thread without replying.",
    input: { file: fileArg, thread: z.string(), status: z.enum(["open", "resolved"]) },
    async handler(args, ctx) {
      const { design } = await ctx.ws.resolve(args.file);
      if (!design.doc.threads.some((t) => t.id === args.thread))
        throw new ToolError(`No thread ${args.thread}.`);
      apply(design, { op: "thread.update", id: args.thread, status: args.status }, ctx);
      return { text: `Thread ${args.thread} is ${args.status}.` };
    },
  }),
];

export { findArtboard };
