import {
  type Artboard,
  type Doc,
  describeNode,
  findArtboard,
  locate,
  type Op,
  type Origin,
  type PElement,
  type PNode,
  walk,
} from "@ponzu/core";
import type { ToolContext } from "./context.ts";
import { ToolError } from "./define.ts";
import type { Applied, OpenDesign, ToolDesign } from "./design.ts";

/**
 * The design a call works on: the workspace's one design, unless the tool list set a way to
 * pick among several. `ids` are the ids the call passes, which say which design it means.
 */
export function designOf(ctx: ToolContext, ids: (string | undefined)[] = []): Promise<OpenDesign> {
  return ctx.pick ? ctx.pick(ids) : ctx.ws.resolve();
}

/**
 * Something a host says right after an artboard's name about where it keeps it. Only a host
 * that keeps designs as files has anything to say.
 */
export type ArtboardNote = (open: OpenDesign, artboardId: string) => string | Promise<string>;

/**
 * ` · link: <address>` for a page or board, where the host has links that the person's thread
 * follows in place (`Workspace.linkTo`), to go after its id and name in a result; else nothing.
 */
export function linkNote(
  ctx: ToolContext,
  key: string,
  at: { page: string } | { artboard: string },
): string {
  const link = ctx.ws.linkTo?.(key, at);
  return link ? ` · link: ${link}` : "";
}

export function origin(ctx: ToolContext): Origin {
  return ctx.caller.author;
}

/** Apply an agent's op. The artboards it changed show as theirs while they keep working. */
export function apply(design: ToolDesign, op: Op, ctx: ToolContext): Applied {
  const event = design.apply(op, origin(ctx));
  const key = ctx.ws.designs().find((d) => d.design === design)?.key;
  if (key && event.artboards.length) {
    // A deleted artboard is no longer anyone's to work on.
    const gone = event.artboards.filter((id) => !findArtboard(design.doc, id));
    const artboards = event.artboards.filter((id) => !gone.includes(id));
    ctx.ws.presence.worked(ctx.caller, key, { artboards, gone });
  }
  return event;
}

export function px(v: string | undefined, fallback: number): number {
  if (!v) return fallback;
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(v.trim());
  return m ? Number(m[1]) : fallback;
}

export function artboardSize(ab: Artboard): { w: number; h: number } {
  return { w: px(ab.root.style.width, 1440), h: px(ab.root.style.height, 900) };
}

/** Find an artboard or node, with a helpful error. */
export function target(doc: Doc, id: string) {
  const hit = locate(doc, id);
  if (!hit) {
    const page = doc.pages.find((p) => p.id === id);
    if (page)
      throw new ToolError(`${id} is a page. Pass an artboard or node id (get_tree lists them).`);
    throw new ToolError(
      `No artboard or node with id ${id}. Use get_tree or find_nodes to look ids up.`,
    );
  }
  return { ...hit, isArtboard: hit.parent === null };
}

export function artboardOf(doc: Doc, id: string): Artboard {
  const ab = findArtboard(doc, id)?.artboard ?? locate(doc, id)?.artboard;
  if (!ab) throw new ToolError(`No artboard or node with id ${id}.`);
  return ab;
}

/** The ids worth reporting after a write: top-level roots plus named descendants. */
export function reportIds(nodes: PNode[], limit = 24): string {
  const lines: string[] = [];
  for (const n of nodes) {
    if (n.kind !== "el") continue;
    for (const { node, depth } of walk(n)) {
      if (lines.length >= limit) break;
      if (depth === 0 || node.name)
        lines.push(
          `${"  ".repeat(Math.min(depth, 3))}${node.id} ${node.name ? `"${node.name}"` : `<${node.tag}>`}${depth === 0 && !node.name ? ` ${describeNode(node)}` : ""}`.trimEnd(),
        );
    }
  }
  const total = nodes.reduce((sum, n) => (n.kind === "el" ? sum + [...walk(n)].length : sum), 0);
  if (total > lines.length && lines.length >= limit)
    lines.push(`… and more (get_tree for the full outline)`);
  return lines.join("\n");
}

/** The space left between artboards placed side by side. */
export const ARTBOARD_GAP = 80;

/**
 * Where to drop a new artboard so it doesn't overlap: right of the row it
 * joins. `boxes` are the page's artboards at their size on the canvas.
 */
export function autoPlace(
  boxes: { x: number; y: number; w: number; h: number }[],
  y?: number,
): { x: number; y: number } {
  if (!boxes.length) return { x: 0, y: y ?? 0 };
  const rowY = y ?? boxes[0]!.y;
  let right = Number.NEGATIVE_INFINITY;
  for (const b of boxes) {
    if (b.y < rowY + 2000 && b.y + b.h > rowY - 1) right = Math.max(right, b.x + b.w);
  }
  if (right === Number.NEGATIVE_INFINITY) right = Math.max(...boxes.map((b) => b.x + b.w));
  return { x: Math.round(right + ARTBOARD_GAP), y: rowY };
}

export function elementsIn(nodes: PNode[]): PElement[] {
  return nodes.filter((n): n is PElement => n.kind === "el");
}

/** "1 match", "2 matches", "3 nodes". */
export function plural(n: number, word: string): string {
  if (n === 1) return `${n} ${word}`;
  return `${n} ${word}${/(s|x|z|ch|sh)$/.test(word) ? "es" : "s"}`;
}

export function droppedNote(dropped: { what: string }[]): string {
  if (!dropped.length) return "";
  const list = [...new Set(dropped.map((d) => d.what))].slice(0, 6).join(", ");
  return `\nRemoved (designs can't run code): ${list}.`;
}
