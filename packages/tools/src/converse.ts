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
import { ToolError, tool } from "./define.ts";
import { apply, canvasOf } from "./util.ts";

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
      "Comment threads in the canvas. Open ones by default. Most are pinned to an artboard and usually a node inside it; some sit on a page, off any board, beside the artboards.",
    input: {
      status: z.enum(["open", "resolved", "all"]).optional(),
      artboard: z.string().optional(),
    },
    async handler(args, ctx) {
      const { canvas } = await canvasOf(ctx, [args.artboard]);
      const doc = canvas.doc;
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
    input: { id: z.string() },
    async handler(args, ctx) {
      const { canvas } = await canvasOf(ctx, [args.id]);
      const t = canvas.doc.threads.find((x) => x.id === args.id);
      if (!t) throw new ToolError(`No thread ${args.id}.`);
      const lines = [
        threadLine(canvas.doc, t),
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
      'Start a thread pinned to a node or artboard when you need the person: a question only they can answer, a choice for them to make, or something you couldn\'t build as asked. Each open thread is something for them to act on. Explanations and rationale go on the canvas, in a "Note: …" artboard beside the work.',
    input: {
      on: z.string().describe("Node or artboard id."),
      text: z.string().min(1),
    },
    async handler(args, ctx) {
      const { canvas } = await canvasOf(ctx, [args.on]);
      const doc = canvas.doc;
      const hit = locate(doc, args.on);
      if (!hit) throw new ToolError(`No node or artboard ${args.on}.`);
      const now = Date.now();
      const thread: Thread = {
        id: newId("th"),
        artboardId: hit.artboard.id,
        // On a node, its top-left corner, wherever the node goes.
        ...(hit.parent ? { nodeId: hit.node.id, offset: { x: 0, y: 0 } } : {}),
        x: 24,
        y: 24,
        status: "open",
        createdAt: now,
        updatedAt: now,
        messages: [{ id: newId("m"), author: ctx.caller.author, text: args.text, createdAt: now }],
      };
      apply(canvas, { op: "thread.create", thread }, ctx);
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
      thread: z.string(),
      text: z.string().min(1),
      resolve: z.boolean().optional(),
    },
    async handler(args, ctx) {
      const { key, canvas } = await canvasOf(ctx, [args.thread]);
      const t = canvas.doc.threads.find((x) => x.id === args.thread);
      if (!t) throw new ToolError(`No thread ${args.thread}.`);
      // Their reply would land in a thread gone from the canvas: it stays open for it.
      const resolve = args.resolve && !ctx.ws.writing?.(key, t.id);
      const message = {
        id: newId("m"),
        author: ctx.caller.author,
        text: args.text,
        createdAt: Date.now(),
      };
      apply(
        canvas,
        resolve
          ? {
              op: "batch",
              ops: [
                { op: "thread.message", id: t.id, message },
                { op: "thread.update", id: t.id, status: "resolved", updatedAt: message.createdAt },
              ],
            }
          : { op: "thread.message", id: t.id, message },
        ctx,
      );
      if (args.resolve && !resolve)
        return {
          text: "Replied, and left it open: the person is writing a reply in this thread. You'll hear it once they send it.",
        };
      return { text: `Replied${resolve ? " and resolved" : ""}.` };
    },
  }),

  tool({
    name: "set_comment_status",
    title: "Set comment status",
    group: "converse",
    description:
      "Resolve or reopen a thread without replying. Resolve a comment once you've done what it asked; that hides its pin from the canvas, and the change speaks for itself.",
    input: { thread: z.string(), status: z.enum(["open", "resolved"]) },
    async handler(args, ctx) {
      const { key, canvas } = await canvasOf(ctx, [args.thread]);
      if (!canvas.doc.threads.some((t) => t.id === args.thread))
        throw new ToolError(`No thread ${args.thread}.`);
      if (args.status === "resolved" && ctx.ws.writing?.(key, args.thread))
        throw new ToolError(
          `The person is writing a reply in thread ${args.thread}, so it stays open. You'll hear it once they send it; resolve the thread when you've done what it asks.`,
          "person_writing",
        );
      apply(
        canvas,
        { op: "thread.update", id: args.thread, status: args.status, updatedAt: Date.now() },
        ctx,
      );
      return { text: `Thread ${args.thread} is ${args.status}.` };
    },
  }),

  tool({
    name: "send_feedback",
    title: "Send feedback to the Ponzu team",
    group: "converse",
    description:
      "Tell the people who build Ponzu how it's working for you. Send it when a tool confused you, failed or got in your way, when you had to work around something Ponzu can't do, when something worked notably well, or when the person asks you to pass something on. Keep it about Ponzu: no canvas content, names, paths or personal details. It goes to the Ponzu team, not to the person; carry on with their task afterwards.",
    input: {
      sentiment: z.enum(["positive", "neutral", "negative", "mixed"]),
      category: z.enum(["bug", "missing_capability", "confusing_tool", "praise", "other"]),
      summary: z.string().min(1).max(300).describe("One sentence."),
      details: z
        .string()
        .max(4000)
        .optional()
        .describe(
          "What happened, which tool, and what would have helped. Leave canvas content, names, paths and personal details out of any argument or error you quote.",
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
