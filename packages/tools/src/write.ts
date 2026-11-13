import {
  type Artboard,
  cloneWithNewIds,
  type Doc,
  elementChildren,
  findArtboard,
  findPage,
  locate,
  mergeStyle,
  newId,
  type Op,
  type PElement,
  parseHtml,
  ROOT_DIRECTION_NOTE,
  rawIndex,
  rootDirectionUnset,
  toKebab,
  walk,
} from "@ponzu/core";
import { z } from "zod";
import type { ToolCanvas } from "./canvas.ts";
import type { ToolContext } from "./context.ts";
import { styleArg, ToolError, type ToolResult, tool } from "./define.ts";
import {
  type Footprint,
  footprints,
  footprintsAround,
  overlapNote,
  overlaps,
  rowNeed,
} from "./overlap.ts";
import {
  ARTBOARD_GAP,
  type ArtboardNote,
  apply,
  artboardSize,
  autoPlace,
  canvasOf,
  droppedNote,
  elementsIn,
  linkNote,
  plural,
  reportIds,
  target,
} from "./util.ts";

const createArtboardInput = {
  name: z.string().describe("Shown above the artboard."),
  page: z.string().optional().describe("Page id or name. Defaults to the first page."),
  width: z.union([z.number(), z.string()]).optional().describe("Default 1440."),
  height: z
    .union([z.number(), z.string()])
    .optional()
    .describe("Default 900. 'fit-content' grows with content."),
  style: styleArg.optional(),
  html: z.string().optional().describe("Initial content."),
  x: z.number().optional(),
  y: z.number().optional(),
};

/** Every element's id in the canvas, for the ids new HTML is given to keep clear of. */
function idsIn(doc: Doc): Set<string> {
  const ids = new Set<string>();
  for (const page of doc.pages)
    for (const artboard of page.artboards)
      for (const { node } of walk(artboard.root)) ids.add(node.id);
  return ids;
}

/** create_artboard. `kept` adds where the host keeps the new artboard. */
export async function createArtboard(
  args: z.infer<z.ZodObject<typeof createArtboardInput>>,
  ctx: ToolContext,
  kept?: ArtboardNote,
): Promise<ToolResult> {
  const open = await canvasOf(ctx, [args.page]);
  const { key, canvas } = open;
  /** The page it goes on. Nothing when none is named and the canvas has none: one is made. */
  const pageNow = () => {
    const doc = canvas.doc;
    if (!args.page) return doc.pages[0];
    const page = findPage(doc, args.page);
    if (!page)
      throw new ToolError(
        doc.pages.length
          ? `No page ${args.page}. Pages: ${doc.pages.map((p) => `${p.id} "${p.name}"`).join(", ")}`
          : `No page ${args.page}: this canvas has no pages yet. Leave page out and the first one is made, or add it with create_page.`,
      );
    return page;
  };
  const style = mergeStyle(
    {},
    { width: args.width ?? 1440, height: args.height ?? 900, ...args.style },
  );
  const width = style.width ?? "auto";
  const height = style.height ?? "auto";
  const { nodes, dropped } = args.html
    ? parseHtml(args.html, { taken: idsIn(canvas.doc) })
    : { nodes: [], dropped: [] };
  const around = pageNow()?.artboards ?? [];
  const pos =
    args.x !== undefined && args.y !== undefined
      ? { x: args.x, y: args.y }
      : autoPlace(
          await footprints(ctx.ws, key, canvas.doc, around, { need: rowNeed(around, args.y) }),
          args.y,
        );
  // Read after the measure, which waits on the renderer: the page may have changed meanwhile.
  const existing = pageNow();
  // A canvas can be without a page: a new one in the cloud, or one whose last page a person
  // deleted. Its first artboard brings the page with it.
  const page = existing ?? { id: newId("pg"), name: "Home", artboards: [] };
  const id = newId("ab");
  const artboard: Artboard = {
    id,
    name: args.name,
    x: args.x ?? pos.x,
    y: args.y ?? pos.y,
    root: {
      kind: "el",
      id,
      tag: "section",
      name: args.name,
      attrs: {},
      style,
      children: nodes,
    },
  };
  const create: Op = {
    op: "artboard.create",
    page: page.id,
    index: page.artboards.length,
    artboard,
  };
  // One op, so nobody is ever shown the page without its artboard, or refused one of the two.
  const newPage: Op = { op: "page.create", index: 0, page: { id: page.id, name: page.name } };
  apply(canvas, existing ? create : { op: "batch", ops: [newPage, create] }, ctx);
  const made = existing ? "" : ` (${page.id}, made now: the canvas had no page)`;
  ctx.ws.focus?.(key, id);
  const where = (await kept?.(open, id)) ?? "";
  const kids = elementsIn(nodes);
  const overlap = await pageOverlaps(ctx, key, canvas, [id]);
  const link = ctx.ws.linkTo?.(key, { artboard: id });
  return {
    text: `Created artboard ${id} "${args.name}" ${width}×${height} at (${artboard.x}, ${artboard.y}) on "${page.name}"${made}${where}.${link ? `\nLink: ${link}` : ""}${kids.length ? `\n${reportIds(nodes)}` : ""}${droppedNote(dropped)}${directionNote([id], () => style)}${overlap}`,
    data: { id },
  };
}

export const writeTools = [
  tool({
    name: "create_artboard",
    title: "Create artboard",
    group: "write",
    description:
      "Add an artboard (a top-level frame). It's placed in a free spot unless you give x/y. Defaults to a flex column, even when its style sets display: flex; give flex-direction: row for side-by-side panes. Typical sizes: desktop 1440×900, tablet 768×1024, phone 390×844. Use height 'fit-content' for long pages. Optionally pass `html` to fill it in the same call.",
    input: createArtboardInput,
    handler: (args, ctx) => createArtboard(args, ctx),
  }),

  tool({
    name: "write_html",
    title: "Write HTML",
    group: "write",
    description:
      "Insert HTML into a node, or replace a node with HTML. Use inline styles, flexbox/grid, and var(--token) values. Write in small visual pieces (a header, then a row, then a card) and screenshot as you go. Name important layers with data-name. Returns the new ids. To set a whole artboard's content in one call, target the artboard with mode replace-children.",
    input: {
      target: z.string().describe("Artboard or node id."),
      html: z.string(),
      mode: z
        .enum(["append", "prepend", "before", "after", "replace", "replace-children"])
        .optional()
        .describe(
          "append (default) and prepend add inside target; before/after add as siblings; replace swaps the target; replace-children empties target first.",
        ),
    },
    async handler(args, ctx) {
      const { canvas } = await canvasOf(ctx, [args.target]);
      const doc = canvas.doc;
      const t = target(doc, args.target);
      const mode = args.mode ?? "append";
      // Parse in the context of the element the HTML lands in, so SVG children
      // written into an <svg> or <g> close themselves like they do in a browser.
      const sibling = mode === "before" || mode === "after" || mode === "replace";
      const parent = sibling ? t.parent : t.node;
      const { nodes, dropped } = parseHtml(args.html, {
        ...(parent ? { parent } : {}),
        taken: idsIn(doc),
      });
      if (!nodes.some((n) => n.kind === "el" || n.value.trim()))
        throw new ToolError("The HTML is empty after cleanup." + droppedNote(dropped));
      let op: Op;
      switch (mode) {
        case "append":
          op = { op: "insert", parent: t.node.id, index: t.node.children.length, nodes };
          break;
        case "prepend":
          op = { op: "insert", parent: t.node.id, index: 0, nodes };
          break;
        case "replace-children":
          op = { op: "children", id: t.node.id, children: nodes };
          break;
        case "before":
        case "after":
        case "replace": {
          if (!t.parent) {
            if (mode === "replace")
              throw new ToolError(
                "To replace an artboard's content use mode 'replace-children'. To restyle the artboard itself use update_styles.",
              );
            throw new ToolError(
              "Artboards don't have siblings. Use create_artboard for a new one.",
            );
          }
          const index = mode === "after" ? t.index + 1 : t.index;
          const insert: Op = { op: "insert", parent: t.parent.id, index, nodes };
          op =
            mode === "replace"
              ? { op: "batch", ops: [{ op: "remove", id: t.node.id }, insert] }
              : insert;
          break;
        }
      }
      apply(canvas, op, ctx);
      const els = elementsIn(nodes);
      return {
        text: `${mode === "replace" ? "Replaced" : "Wrote"} ${plural(els.length, "element")} in ${t.artboard.id} "${t.artboard.name}".\n${reportIds(nodes)}${droppedNote(dropped)}`,
        data: { ids: els.map((e) => e.id) },
      };
    },
  }),

  tool({
    name: "update_styles",
    title: "Update styles",
    group: "write",
    description:
      'Change CSS on one or more nodes or artboards. Merges into existing inline styles; null removes a property. Batch many edits: [{"ids": ["n_a","n_b"], "style": {"color": "var(--color-ink)"}}]. Setting width/height on an artboard resizes it.',
    input: {
      updates: z.array(z.object({ ids: z.array(z.string()).min(1), style: styleArg })).min(1),
    },
    async handler(args, ctx) {
      const { canvas } = await canvasOf(
        ctx,
        args.updates.flatMap((u) => u.ids),
      );
      const doc = canvas.doc;
      const ops: Op[] = [];
      const pending = new Map<string, Record<string, string>>();
      for (const u of args.updates) {
        for (const id of u.ids) {
          const t = target(doc, id);
          const base = pending.get(id) ?? t.node.style;
          pending.set(id, mergeStyle(base, u.style));
        }
      }
      for (const [id, style] of pending) ops.push({ op: "style", id, style });
      apply(canvas, ops.length === 1 ? ops[0]! : { op: "batch", ops }, ctx);
      const warnings = styleWarnings(args.updates.flatMap((u) => Object.keys(u.style)));
      return {
        text: `Updated ${plural(pending.size, "node")}.${warnings}${directionNote([...pending.keys()], (id) => findArtboard(doc, id) && pending.get(id))}`,
      };
    },
  }),

  tool({
    name: "set_text",
    title: "Set text",
    group: "write",
    description:
      "Replace the text inside nodes, keeping their styles. Removes any child elements of those nodes.",
    input: {
      updates: z.array(z.object({ id: z.string(), text: z.string() })).min(1),
    },
    async handler(args, ctx) {
      const { canvas } = await canvasOf(
        ctx,
        args.updates.map((u) => u.id),
      );
      const ops: Op[] = args.updates.map((u) => {
        const t = target(canvas.doc, u.id);
        if (t.isArtboard)
          throw new ToolError(`${u.id} is an artboard. Set text on a node inside it.`);
        return { op: "children", id: u.id, children: [{ kind: "text", value: u.text }] };
      });
      apply(canvas, ops.length === 1 ? ops[0]! : { op: "batch", ops }, ctx);
      return { text: `Set text on ${plural(ops.length, "node")}.` };
    },
  }),

  tool({
    name: "set_attributes",
    title: "Set attributes",
    group: "write",
    description:
      "Set or remove HTML attributes (src, href, alt, viewBox, fill…). null removes. Event handlers are not allowed.",
    input: {
      id: z.string(),
      attrs: z.record(z.string(), z.union([z.string(), z.null()])),
    },
    async handler(args, ctx) {
      const { canvas } = await canvasOf(ctx, [args.id]);
      const t = target(canvas.doc, args.id);
      const next = { ...t.node.attrs };
      for (const [k, v] of Object.entries(args.attrs)) {
        const lower = k.toLowerCase();
        if (lower.startsWith("on"))
          throw new ToolError("Canvases can't run code; event handlers are not allowed.");
        if (lower === "style") throw new ToolError("Use update_styles for CSS.");
        if (lower === "data-id") throw new ToolError("Ids are managed by Ponzu.");
        if (lower === "data-name" || lower === "layer-name")
          throw new ToolError("A layer's name isn't an attribute. Set it with rename.");
        if (lower === "srcdoc")
          throw new ToolError(
            "Canvases can't hold a document inside an attribute; srcdoc is not allowed.",
          );
        if (v !== null && /^\s*javascript:/i.test(v))
          throw new ToolError("javascript: URLs are not allowed.");
        if (v === null) delete next[k];
        else next[k] = v;
      }
      apply(canvas, { op: "attrs", id: args.id, attrs: next }, ctx);
      return { text: `Updated attributes on ${args.id}.` };
    },
  }),

  tool({
    name: "duplicate",
    title: "Duplicate",
    group: "write",
    description:
      "Deep-copy nodes or artboards. Copies of nodes go right after the original (or into `parent`); artboard copies are placed in a free spot to the right of the original, which makes variations easy, unless you give x/y. Returns each copy's new id; get_tree on a copy lists its descendants.",
    input: {
      ids: z.array(z.string()).min(1),
      parent: z.string().optional().describe("Put node copies inside this node instead."),
      names: z.array(z.string()).optional().describe("New names for the copies, in order."),
      x: z
        .number()
        .optional()
        .describe(
          "Where the first artboard copy goes. Further artboard copies line up to its right.",
        ),
      y: z.number().optional().describe("Row for artboard copies. Default: the original's row."),
    },
    async handler(args, ctx) {
      const { key, canvas } = await canvasOf(ctx, [...args.ids, args.parent]);
      // Each page that holds an original, measured: the originals for their copies' size, and
      // when x is left to autoPlace, what's in the rows the copies join. Measuring waits on
      // the renderer, so it comes before the document is read for the ops.
      const pageBoxes = new Map<string, Footprint[]>();
      for (const page of canvas.doc.pages) {
        const originals = page.artboards.filter((ab) => args.ids.includes(ab.id));
        if (!originals.length) continue;
        const inRow =
          args.x === undefined
            ? rowNeed(
                page.artboards,
                ...(args.y !== undefined ? [args.y] : originals.map((ab) => ab.y)),
              )
            : () => false;
        const need = (ab: Artboard) => args.ids.includes(ab.id) || inRow(ab);
        pageBoxes.set(page.id, await footprints(ctx.ws, key, canvas.doc, page.artboards, { need }));
      }
      const doc = canvas.doc;
      const ops: Op[] = [];
      const map: Record<string, string> = {};
      // Artboard copies so far, at their originals' size on the canvas.
      const placed: Footprint[] = [];
      // Reported in the order asked for; names[i] goes with ids[i].
      const lines: string[] = new Array(args.ids.length);
      const ids: string[] = new Array(args.ids.length);
      const intoParent = args.parent ? target(doc, args.parent).node : null;
      const parentCopies: PElement[] = [];
      const siblingCopies: { parent: string; index: number; copy: PElement }[] = [];
      const copiesOnPage = new Map<string, number>();
      // Copies follow their sources' document order, whatever order the ids came in.
      const position = nodeOrder(doc);
      const order = args.ids
        .map((id, i) => ({ id, i }))
        .sort(
          (a, b) =>
            (position.get(a.id) ?? Number.POSITIVE_INFINITY) -
            (position.get(b.id) ?? Number.POSITIVE_INFINITY),
        );
      for (const { id, i } of order) {
        const ab = findArtboard(doc, id);
        if (ab) {
          const copyRoot = cloneWithNewIds(ab.artboard.root, map, "ab");
          const name = args.names?.[i] ?? `${ab.artboard.name} copy`;
          copyRoot.name = name;
          const boxes = pageBoxes.get(ab.page.id) ?? [];
          const pos = placeCopy(boxes, placed, ab.artboard.y, args.x, args.y);
          const artboard: Artboard = {
            id: copyRoot.id,
            name,
            x: pos.x,
            y: pos.y,
            root: copyRoot,
          };
          // An original that reached this page while it was measured goes by its declared size.
          const { w, h } = boxes.find((b) => b.id === id) ?? artboardSize(ab.artboard);
          placed.push({ id: artboard.id, name, x: pos.x, y: pos.y, w, h });
          const onPage = (copiesOnPage.get(ab.page.id) ?? 0) + 1;
          copiesOnPage.set(ab.page.id, onPage);
          ops.push({
            op: "artboard.create",
            page: ab.page.id,
            // After the page's artboards and the copies already made for it, in the order asked.
            index: ab.page.artboards.length + onPage - 1,
            artboard,
          });
          ids[i] = artboard.id;
          lines[i] =
            `${id} → ${artboard.id} "${name}" at (${artboard.x}, ${artboard.y})` +
            linkNote(ctx, key, { artboard: artboard.id });
          continue;
        }
        const t = target(doc, id);
        const copy = cloneWithNewIds(t.node, map);
        if (args.names?.[i]) copy.name = args.names[i];
        if (intoParent) parentCopies.push(copy);
        else siblingCopies.push({ parent: t.parent!.id, index: t.index + 1, copy });
        ids[i] = copy.id;
        lines[i] = `${id} → ${copy.id}`;
      }
      if (intoParent && parentCopies.length)
        ops.push({
          op: "insert",
          parent: intoParent.id,
          index: intoParent.children.length,
          nodes: parentCopies,
        });
      // Indices are from before any insert, so go last to first: inserting
      // further down never shifts a spot above it.
      for (const s of siblingCopies.reverse())
        ops.push({ op: "insert", parent: s.parent, index: s.index, nodes: [s.copy] });
      apply(canvas, ops.length === 1 ? ops[0]! : { op: "batch", ops }, ctx);
      if (placed[0]) ctx.ws.focus?.(key, placed[0].id);
      const copied = Object.keys(map).length;
      const total =
        copied > args.ids.length
          ? `\n${plural(copied, "node")} copied in all; get_tree on a copy lists their ids.`
          : "";
      const overlap = placed.length
        ? await pageOverlaps(
            ctx,
            key,
            canvas,
            placed.map((p) => p.id),
            // A copy renders at its original's size, measured above.
            Object.fromEntries(placed.map((p) => [p.id, { w: p.w, h: p.h }])),
          )
        : "";
      return {
        text: `${lines.join("\n")}${total}${overlap}`,
        // Agents get the top-level ids; the full old→new map is for hosts calling runTool.
        data: { ids, map },
      };
    },
  }),

  tool({
    name: "move_nodes",
    title: "Move nodes",
    group: "write",
    description:
      "Reparent or reorder nodes without changing their ids. Give `before` or `after` a sibling id, or `parent` (plus optional `index`). To move artboards on the canvas, use update_artboard.",
    input: {
      moves: z
        .array(
          z.object({
            id: z.string(),
            before: z.string().optional(),
            after: z.string().optional(),
            parent: z.string().optional(),
            index: z
              .number()
              .int()
              .min(0)
              .optional()
              .describe("Position among the parent's element children."),
          }),
        )
        .min(1),
    },
    async handler(args, ctx) {
      const { canvas } = await canvasOf(
        ctx,
        args.moves.flatMap((m) => [m.id, m.before, m.after, m.parent]),
      );
      const ops: Op[] = [];
      // Nodes moved so far to each `after` sibling or parent index. Moves that
      // share a spot line up after one another, in the order given, rather than
      // each landing in front of the last.
      const runs = new Map<string, Run>();
      // When each node was last moved in this batch.
      const movedAt = new Map<string, number>();
      // Apply one by one so later moves see earlier ones.
      for (const [step, move] of args.moves.entries()) {
        // Read again each time: a canvas on a replica is a new document after each op.
        const doc = canvas.doc;
        const spot = move.after
          ? `after ${move.after}`
          : !move.before && move.parent && move.index !== undefined
            ? `index ${move.parent} ${move.index}`
            : null;
        const run = spot ? runs.get(spot) : undefined;
        const tail = run ? runTail(doc, move, run, movedAt) : null;
        const m = tail ? { id: move.id, after: tail } : move;
        // A node belongs to the run of the spot it was last sent to.
        for (const r of runs.values()) r.members.delete(move.id);
        if (spot) {
          const r = run ?? { start: step, members: new Set<string>() };
          r.members.add(move.id);
          runs.set(spot, r);
        }
        movedAt.set(move.id, step);
        const sibling = m.before ?? m.after;
        let parent: string;
        let index: number;
        if (sibling) {
          const s = target(doc, sibling);
          if (!s.parent)
            throw new ToolError(`${sibling} is an artboard; nodes can't be its siblings.`);
          parent = s.parent.id;
          const node = target(doc, m.id);
          const sameParent = node.parent?.id === parent && node.index < s.index;
          index = s.index + (m.after ? 1 : 0) - (sameParent ? 1 : 0);
        } else if (m.parent) {
          const p = target(doc, m.parent).node;
          parent = p.id;
          index = m.index === undefined ? p.children.length : rawIndex(p, m.index);
          const node = target(doc, m.id);
          if (node.parent?.id === parent && node.index < index) index--;
        } else {
          throw new ToolError(`Move for ${m.id} needs before, after or parent.`);
        }
        const op: Op = { op: "move", id: m.id, parent, index };
        apply(canvas, op, ctx);
        ops.push(op);
      }
      return { text: `Moved ${plural(ops.length, "node")}.` };
    },
  }),

  tool({
    name: "delete",
    title: "Delete",
    group: "write",
    destructive: true,
    description: "Delete nodes or whole artboards. Undoable from the app.",
    input: { ids: z.array(z.string()).min(1) },
    async handler(args, ctx) {
      const { canvas } = await canvasOf(ctx, args.ids);
      const doc = canvas.doc;
      const ops: Op[] = [];
      for (const id of args.ids) {
        if (findArtboard(doc, id)) ops.push({ op: "artboard.delete", id });
        else if (locate(doc, id)) ops.push({ op: "remove", id });
        else throw new ToolError(`No artboard or node ${id}.`);
      }
      apply(canvas, ops.length === 1 ? ops[0]! : { op: "batch", ops }, ctx);
      return { text: `Deleted ${plural(ops.length, "item")}.` };
    },
  }),

  tool({
    name: "rename",
    title: "Rename",
    group: "write",
    description: "Set layer names (data-name) on nodes or artboards.",
    input: {
      updates: z.array(z.object({ id: z.string(), name: z.string() })).min(1),
    },
    async handler(args, ctx) {
      const { canvas } = await canvasOf(
        ctx,
        args.updates.map((u) => u.id),
      );
      const ops: Op[] = args.updates.map((u) =>
        findArtboard(canvas.doc, u.id)
          ? { op: "artboard.update", id: u.id, name: u.name }
          : { op: "name", id: target(canvas.doc, u.id).node.id, name: u.name },
      );
      apply(canvas, ops.length === 1 ? ops[0]! : { op: "batch", ops }, ctx);
      return { text: `Renamed ${plural(ops.length, "layer")}.` };
    },
  }),

  tool({
    name: "update_artboard",
    title: "Update artboard",
    group: "write",
    description:
      "Move an artboard on the canvas, resize it, rename it, or move it to another page.",
    input: {
      id: z.string(),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.union([z.number(), z.string()]).optional(),
      height: z.union([z.number(), z.string()]).optional(),
      name: z.string().optional(),
      page: z.string().optional().describe("Move to this page (id or name)."),
    },
    async handler(args, ctx) {
      const { key, canvas } = await canvasOf(ctx, [args.id, args.page]);
      // Where it lands on another page takes a measure, which waits on the renderer, so it
      // comes before the document is read for the ops.
      const free =
        args.page && args.x === undefined
          ? await freeSpot(ctx, key, canvas, args.id, args.page)
          : undefined;
      const doc = canvas.doc;
      const hit = findArtboard(doc, args.id);
      if (!hit) throw new ToolError(`No artboard ${args.id}.`);
      const ops: Op[] = [];
      if (args.page) {
        const page = findPage(doc, args.page);
        if (!page) throw new ToolError(`No page ${args.page}.`);
        if (page.id !== hit.page.id) {
          ops.push({
            op: "artboard.move",
            id: args.id,
            page: page.id,
            index: page.artboards.length,
          });
          if (free) ops.push({ op: "artboard.update", id: args.id, x: free.x, y: free.y });
        }
      }
      if (args.x !== undefined || args.y !== undefined || args.name !== undefined) {
        ops.push({ op: "artboard.update", id: args.id, x: args.x, y: args.y, name: args.name });
      }
      if (args.width !== undefined || args.height !== undefined) {
        const size: Record<string, string | number> = {};
        if (args.width !== undefined) size.width = args.width;
        if (args.height !== undefined) size.height = args.height;
        ops.push({ op: "style", id: args.id, style: mergeStyle(hit.artboard.root.style, size) });
      }
      if (!ops.length) return { text: "Nothing to change." };
      apply(canvas, { op: "batch", ops }, ctx);
      const a = findArtboard(canvas.doc, args.id)!.artboard;
      const overlap = await pageOverlaps(ctx, key, canvas, [a.id]);
      return {
        text: `${a.id} "${a.name}" ${a.root.style.width}×${a.root.style.height} at (${a.x}, ${a.y}).${overlap}`,
      };
    },
  }),
];

function styleWarnings(keys: string[]): string {
  const k = new Set(keys.map(toKebab));
  const notes: string[] = [];
  if (k.has("position") || k.has("top") || k.has("left")) {
    // fine, just a reminder to keep layout in flow when possible
  }
  if ([...k].some((x) => x === "margin" || x.startsWith("margin-")))
    notes.push("margin works, but gap and padding keep layouts easier to edit");
  return notes.length ? `\nNote: ${notes.join("; ")}.` : "";
}

/**
 * A note naming the artboards among ids whose own style sets display: flex
 * with no direction. rootStyle gives an artboard's style as written, and
 * nothing for ids that aren't artboards.
 */
function directionNote(
  ids: string[],
  rootStyle: (id: string) => Record<string, string> | null | undefined,
): string {
  const roots = ids.filter((id) => {
    const style = rootStyle(id);
    return style && rootDirectionUnset(style);
  });
  return roots.length ? `\nNote: ${roots.join(", ")} ${ROOT_DIRECTION_NOTE}.` : "";
}

/** Nodes a move_nodes batch sent to one spot, and the step its first move was. */
interface Run {
  start: number;
  members: Set<string>;
}

/**
 * The last node of an earlier run still sitting at a move's spot (right after
 * its `after` sibling, or from its parent index on), read from the doc as it
 * is now. Nodes moved in after the run began don't break it; anything that
 * was there before does. Null when no member is there, so the move goes to
 * the spot itself.
 */
function runTail(
  doc: Doc,
  move: { id: string; after?: string; parent?: string; index?: number },
  run: Run,
  movedAt: Map<string, number>,
): string | null {
  let siblings: PElement[];
  let start: number;
  if (move.after) {
    const anchor = locate(doc, move.after);
    if (!anchor?.parent) return null;
    siblings = elementChildren(anchor.parent);
    start = siblings.findIndex((c) => c.id === move.after) + 1;
  } else {
    const parent = move.parent ? locate(doc, move.parent) : null;
    if (!parent || move.index === undefined) return null;
    siblings = elementChildren(parent.node);
    start = move.index;
  }
  let tail: string | null = null;
  for (const c of siblings.slice(start)) {
    if (c.id === move.id) continue;
    if (run.members.has(c.id)) tail = c.id;
    else if ((movedAt.get(c.id) ?? -1) <= run.start) break;
  }
  return tail;
}

/** Every artboard's and node's position in document order (pages, artboards, then depth-first). */
function nodeOrder(doc: Doc): Map<string, number> {
  const order = new Map<string, number>();
  for (const page of doc.pages)
    for (const ab of page.artboards)
      for (const { node } of walk(ab.root)) order.set(node.id, order.size);
  return order;
}

/**
 * Where an artboard copy goes. Without x/y it takes the next free spot in the
 * original's row. With them the first copy goes there (a missing x autoplaces
 * in row y, like create_artboard) and later copies line up to its right.
 */
function placeCopy(
  boxes: Footprint[],
  placed: Footprint[],
  rowY: number,
  x?: number,
  y?: number,
): { x: number; y: number } {
  if (x === undefined && y === undefined) {
    return { x: autoPlace([...boxes, ...placed], rowY).x, y: rowY };
  }
  const prev = placed.at(-1);
  if (prev) return { x: prev.x + prev.w + ARTBOARD_GAP, y: prev.y };
  const row = y ?? rowY;
  return { x: x ?? autoPlace(boxes, row).x, y: row };
}

/** A free spot on `page` for an artboard that is on another page now, or nothing if it isn't. */
async function freeSpot(
  ctx: ToolContext,
  key: string,
  canvas: ToolCanvas,
  id: string,
  page: string,
): Promise<{ x: number; y: number } | undefined> {
  const doc = canvas.doc;
  const to = findPage(doc, page);
  if (!to || findArtboard(doc, id)?.page.id === to.id) return undefined;
  return autoPlace(
    await footprints(ctx.ws, key, doc, to.artboards, { need: rowNeed(to.artboards) }),
  );
}

/**
 * A note naming the artboards that now overlap any of `ids` on its page, as
 * the canvas draws them. Measures fit-content artboards when it can.
 */
async function pageOverlaps(
  ctx: ToolContext,
  key: string,
  canvas: ToolCanvas,
  ids: string[],
  known: Record<string, { w: number; h: number }> = {},
): Promise<string> {
  const doc = canvas.doc;
  const pages = doc.pages.filter((p) => p.artboards.some((ab) => ids.includes(ab.id)));
  const found = [];
  for (const page of pages)
    found.push(
      ...overlaps(await footprintsAround(ctx.ws, key, doc, page.artboards, ids, known), ids),
    );
  return overlapNote(found);
}
