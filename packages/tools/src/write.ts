import {
  type Artboard,
  cloneWithNewIds,
  findArtboard,
  findPage,
  locate,
  mergeStyle,
  newId,
  type Op,
  type PElement,
  parseHtml,
  parseStyle,
  rawIndex,
  toKebab,
} from "@ponzu/core";
import { z } from "zod";
import { fileArg, styleArg, ToolError, tool } from "./define.ts";
import { apply, autoPlace, droppedNote, elementsIn, plural, reportIds, target } from "./util.ts";

export const writeTools = [
  tool({
    name: "create_artboard",
    title: "Create artboard",
    group: "write",
    description:
      "Add an artboard (a top-level frame, stored as its own HTML file). It's placed in a free spot unless you give x/y. Defaults to a flex column. Typical sizes: desktop 1440×900, tablet 768×1024, phone 390×844. Use height 'fit-content' for long pages. Optionally pass `html` to fill it in the same call.",
    input: {
      file: fileArg,
      name: z.string().describe("Shown above the artboard and used as its file name."),
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
    },
    async handler(args, ctx) {
      const { key, design } = await ctx.ws.resolve(args.file);
      const doc = design.doc;
      const page = args.page ? findPage(doc, args.page) : doc.pages[0];
      if (!page)
        throw new ToolError(
          `No page ${args.page}. Pages: ${doc.pages.map((p) => `${p.id} "${p.name}"`).join(", ")}`,
        );
      const width = typeof args.width === "number" ? `${args.width}px` : (args.width ?? "1440px");
      const height =
        typeof args.height === "number" ? `${args.height}px` : (args.height ?? "900px");
      const style = mergeStyle({ width, height }, args.style ?? {});
      const { nodes, dropped } = args.html ? parseHtml(args.html) : { nodes: [], dropped: [] };
      const pos =
        args.x !== undefined && args.y !== undefined
          ? { x: args.x, y: args.y }
          : autoPlace(page.artboards, Number.parseFloat(width) || 1440, args.y);
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
      apply(
        design,
        { op: "artboard.create", page: page.id, index: page.artboards.length, artboard },
        ctx,
      );
      ctx.ws.focus?.(key, id);
      const kids = elementsIn(nodes);
      return {
        text: `Created artboard ${id} "${args.name}" ${width}×${height} at (${artboard.x}, ${artboard.y}) on "${page.name}".${kids.length ? `\n${reportIds(nodes)}` : ""}${droppedNote(dropped)}`,
        data: { id },
      };
    },
  }),

  tool({
    name: "write_html",
    title: "Write HTML",
    group: "write",
    description:
      "Insert HTML into a node, or replace a node with HTML. Use inline styles, flexbox/grid, and var(--token) values. Write in small visual pieces (a header, then a row, then a card) and screenshot as you go. Name important layers with data-name. Returns the new ids.",
    input: {
      file: fileArg,
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
      const { design } = await ctx.ws.resolve(args.file);
      const doc = design.doc;
      const t = target(doc, args.target);
      const { nodes, dropped } = parseHtml(args.html);
      if (!nodes.some((n) => n.kind === "el" || n.value.trim()))
        throw new ToolError("The HTML is empty after cleanup." + droppedNote(dropped));
      const mode = args.mode ?? "append";
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
      apply(design, op, ctx);
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
      file: fileArg,
      updates: z.array(z.object({ ids: z.array(z.string()).min(1), style: styleArg })).min(1),
    },
    async handler(args, ctx) {
      const { design } = await ctx.ws.resolve(args.file);
      const doc = design.doc;
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
      apply(design, ops.length === 1 ? ops[0]! : { op: "batch", ops }, ctx);
      const warnings = styleWarnings(args.updates.flatMap((u) => Object.keys(u.style)));
      return { text: `Updated ${plural(pending.size, "node")}.${warnings}` };
    },
  }),

  tool({
    name: "set_text",
    title: "Set text",
    group: "write",
    description:
      "Replace the text inside nodes, keeping their styles. Removes any child elements of those nodes.",
    input: {
      file: fileArg,
      updates: z.array(z.object({ id: z.string(), text: z.string() })).min(1),
    },
    async handler(args, ctx) {
      const { design } = await ctx.ws.resolve(args.file);
      const ops: Op[] = args.updates.map((u) => {
        const t = target(design.doc, u.id);
        if (t.isArtboard)
          throw new ToolError(`${u.id} is an artboard. Set text on a node inside it.`);
        return { op: "children", id: u.id, children: [{ kind: "text", value: u.text }] };
      });
      apply(design, ops.length === 1 ? ops[0]! : { op: "batch", ops }, ctx);
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
      file: fileArg,
      id: z.string(),
      attrs: z.record(z.string(), z.union([z.string(), z.null()])),
    },
    async handler(args, ctx) {
      const { design } = await ctx.ws.resolve(args.file);
      const t = target(design.doc, args.id);
      const next = { ...t.node.attrs };
      for (const [k, v] of Object.entries(args.attrs)) {
        const lower = k.toLowerCase();
        if (lower.startsWith("on"))
          throw new ToolError("Designs can't run code; event handlers are not allowed.");
        if (lower === "style") throw new ToolError("Use update_styles for CSS.");
        if (lower === "data-id") throw new ToolError("Ids are managed by Ponzu.");
        if (v !== null && /^\s*javascript:/i.test(v))
          throw new ToolError("javascript: URLs are not allowed.");
        if (v === null) delete next[k];
        else next[k] = v;
      }
      apply(design, { op: "attrs", id: args.id, attrs: next }, ctx);
      return { text: `Updated attributes on ${args.id}.` };
    },
  }),

  tool({
    name: "duplicate",
    title: "Duplicate",
    group: "write",
    description:
      "Deep-copy nodes or artboards. Copies of nodes go right after the original (or into `parent`); artboard copies are placed in a free spot, which makes variations easy. Returns an old→new id map for every descendant.",
    input: {
      file: fileArg,
      ids: z.array(z.string()).min(1),
      parent: z.string().optional().describe("Put node copies inside this node instead."),
      names: z.array(z.string()).optional().describe("New names for the copies, in order."),
    },
    async handler(args, ctx) {
      const { key, design } = await ctx.ws.resolve(args.file);
      const doc = design.doc;
      const ops: Op[] = [];
      const lines: string[] = [];
      const map: Record<string, string> = {};
      const placed: Artboard[] = [];
      args.ids.forEach((id, i) => {
        const ab = findArtboard(doc, id);
        if (ab) {
          const copyRoot = cloneWithNewIds(ab.artboard.root, map, "ab");
          const name = args.names?.[i] ?? `${ab.artboard.name} copy`;
          copyRoot.name = name;
          const pos = autoPlace([...ab.page.artboards, ...placed], 0, ab.artboard.y);
          const artboard: Artboard = {
            id: copyRoot.id,
            name,
            x: pos.x,
            y: ab.artboard.y,
            root: copyRoot,
          };
          placed.push(artboard);
          ops.push({
            op: "artboard.create",
            page: ab.page.id,
            index: ab.page.artboards.length + placed.length,
            artboard,
          });
          lines.push(`${id} → ${artboard.id} "${name}" at (${artboard.x}, ${artboard.y})`);
          return;
        }
        const t = target(doc, id);
        const copy = cloneWithNewIds(t.node, map);
        if (args.names?.[i]) copy.name = args.names[i];
        if (args.parent) {
          const p = target(doc, args.parent).node;
          ops.push({ op: "insert", parent: p.id, index: p.children.length, nodes: [copy] });
        } else {
          ops.push({ op: "insert", parent: t.parent!.id, index: t.index + 1, nodes: [copy] });
        }
        lines.push(`${id} → ${copy.id}`);
      });
      apply(design, ops.length === 1 ? ops[0]! : { op: "batch", ops }, ctx);
      if (placed[0]) ctx.ws.focus?.(key, placed[0].id);
      const mapLines = Object.entries(map)
        .filter(([from]) => !args.ids.includes(from))
        .slice(0, 60)
        .map(([a, b]) => `${a}→${b}`);
      return {
        text: `${lines.join("\n")}${mapLines.length ? `\nDescendants: ${mapLines.join(" ")}${Object.keys(map).length > 60 ? " …" : ""}` : ""}`,
        data: { map },
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
      file: fileArg,
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
      const { design } = await ctx.ws.resolve(args.file);
      const doc = design.doc;
      const ops: Op[] = [];
      // Apply one by one so later moves see earlier ones.
      for (const m of args.moves) {
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
        apply(design, op, ctx);
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
    description: "Delete nodes or whole artboards (and their files). Undoable from the app.",
    input: { file: fileArg, ids: z.array(z.string()).min(1) },
    async handler(args, ctx) {
      const { design } = await ctx.ws.resolve(args.file);
      const doc = design.doc;
      const ops: Op[] = [];
      for (const id of args.ids) {
        if (findArtboard(doc, id)) ops.push({ op: "artboard.delete", id });
        else if (locate(doc, id)) ops.push({ op: "remove", id });
        else throw new ToolError(`No artboard or node ${id}.`);
      }
      apply(design, ops.length === 1 ? ops[0]! : { op: "batch", ops }, ctx);
      return { text: `Deleted ${plural(ops.length, "item")}.` };
    },
  }),

  tool({
    name: "rename",
    title: "Rename",
    group: "write",
    description:
      "Set layer names (data-name) on nodes or artboards. Artboard renames also rename the file.",
    input: {
      file: fileArg,
      updates: z.array(z.object({ id: z.string(), name: z.string() })).min(1),
    },
    async handler(args, ctx) {
      const { design } = await ctx.ws.resolve(args.file);
      const ops: Op[] = args.updates.map((u) =>
        findArtboard(design.doc, u.id)
          ? { op: "artboard.update", id: u.id, name: u.name }
          : { op: "name", id: target(design.doc, u.id).node.id, name: u.name },
      );
      apply(design, ops.length === 1 ? ops[0]! : { op: "batch", ops }, ctx);
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
      file: fileArg,
      id: z.string(),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.union([z.number(), z.string()]).optional(),
      height: z.union([z.number(), z.string()]).optional(),
      name: z.string().optional(),
      page: z.string().optional().describe("Move to this page (id or name)."),
    },
    async handler(args, ctx) {
      const { design } = await ctx.ws.resolve(args.file);
      const doc = design.doc;
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
          if (args.x === undefined) {
            const pos = autoPlace(page.artboards, 0);
            ops.push({ op: "artboard.update", id: args.id, x: pos.x, y: pos.y });
          }
        }
      }
      if (args.x !== undefined || args.y !== undefined || args.name !== undefined) {
        ops.push({ op: "artboard.update", id: args.id, x: args.x, y: args.y, name: args.name });
      }
      if (args.width !== undefined || args.height !== undefined) {
        ops.push({
          op: "style",
          id: args.id,
          style: mergeStyle(hit.artboard.root.style, {
            width: args.width ?? null,
            height: args.height ?? null,
          }),
        });
        if (args.width === undefined)
          ops[ops.length - 1] = {
            op: "style",
            id: args.id,
            style: mergeStyle(hit.artboard.root.style, { height: args.height! }),
          };
        if (args.height === undefined)
          ops[ops.length - 1] = {
            op: "style",
            id: args.id,
            style: mergeStyle(hit.artboard.root.style, { width: args.width! }),
          };
      }
      if (!ops.length) return { text: "Nothing to change." };
      apply(design, { op: "batch", ops }, ctx);
      const a = findArtboard(design.doc, args.id)!.artboard;
      return {
        text: `${a.id} "${a.name}" ${a.root.style.width}×${a.root.style.height} at (${a.x}, ${a.y}).`,
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

export { type PElement, parseStyle };
