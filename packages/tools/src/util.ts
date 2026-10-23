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
import type { Design } from "@ponzu/store";
import type { FileSource, ToolContext } from "./context.ts";
import { ToolError } from "./define.ts";

/**
 * The design a call works on. A `file` argument wins; then the open design
 * that holds the ids the call passes; then the session's file; then the only
 * open design. Whichever it is becomes the session's file.
 */
export async function resolveFile(
  ctx: ToolContext,
  file: string | undefined,
  ids: (string | undefined)[] = [],
): Promise<{ key: string; design: Design }> {
  const { ws, session } = ctx;
  const all = ws.designs();
  const current = all.find((d) => d.key === session?.file);
  let picked: { key: string; design: Design };
  let from: FileSource;
  const wanted = ids.filter((id): id is string => Boolean(id));
  if (file) {
    picked = await ws.resolve(file);
    from = "arg";
  } else {
    // The files that hold the most of these ids: an id only one copy has outweighs ids they
    // share, and a page name passed in place of an id counts for none.
    const counts = all.map((d) => wanted.filter((id) => holds(d.design.doc, id)).length);
    const best = all.length > 1 ? Math.max(0, ...counts) : 0;
    const holders = best ? all.filter((_, i) => counts[i] === best) : [];
    if (holders.length === 1) {
      picked = holders[0]!;
      from = "ids";
    } else if (holders.length > 1) {
      // Copies of one design share ids; only the session's file can say which.
      const mine = holders.find((d) => d.key === current?.key);
      if (!mine)
        throw new ToolError(
          `${wanted.length === 1 ? wanted[0] : "Those ids"} ${wanted.length === 1 ? "is" : "are"} in ${holders.length} open files: ${fileList(holders)}. Pass file.`,
          "file_ids_ambiguous",
        );
      picked = mine;
      from = "session";
    } else if (current) {
      picked = current;
      from = "session";
    } else {
      picked = await ws.resolve();
      from = "only";
    }
  }
  // Ids from two files in one call: refuse before any of it lands in the wrong one.
  const doc = picked.design.doc;
  for (const id of wanted) {
    if (holds(doc, id)) continue;
    const other = all.find((d) => d.key !== picked.key && holds(d.design.doc, id));
    if (other)
      throw new ToolError(
        `${id} is in ${label(other, all)}, not ${label(picked, all)}. One call works on one file: ${file ? "split the call" : "pass file, or split the call"}.`,
        "file_ids_split",
      );
  }
  // Ids took the session to another file: say so, since later calls without file follow.
  const moved = session && from === "ids" && session.file !== picked.key;
  ctx.resolved = {
    from,
    note: moved ? `\nNow in ${label(picked, all)}; calls without file use it.` : undefined,
  };
  if (session) session.file = picked.key;
  ws.presence.saw(ctx.caller, picked.key);
  return picked;
}

/** A design's name, with its path when another open file shares the name. */
function label(
  picked: { key: string; design: Design },
  all: { key: string; design: Design }[],
): string {
  const name = picked.design.doc.name;
  return all.some((d) => d.key !== picked.key && d.design.doc.name === name)
    ? `"${name}" (${picked.key})`
    : `"${name}"`;
}

/** Whether a page, artboard, node or thread with this exact id is in the doc. */
function holds(doc: Doc, id: string): boolean {
  return (
    doc.pages.some((p) => p.id === id) ||
    doc.threads.some((t) => t.id === id) ||
    locate(doc, id) !== null
  );
}

/** "Name (path), …", at most five. */
export function fileList(files: { key: string; design: Design }[], limit = 5): string {
  const shown = files.slice(0, limit).map((f) => `${f.design.doc.name} (${f.key})`);
  return files.length > limit
    ? `${shown.join(", ")} and ${files.length - limit} more`
    : shown.join(", ");
}

export function origin(ctx: ToolContext): Origin {
  return ctx.caller.author;
}

/** Apply an agent's op. The artboards it changed show as theirs while they keep working. */
export function apply(design: Design, op: Op, ctx: ToolContext) {
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
