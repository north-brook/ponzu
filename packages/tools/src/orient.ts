import {
  artboardSummary,
  describeNode,
  docSummary,
  findPage,
  isThemed,
  locate,
  outline,
  parseTokens,
  serializeNode,
  visibleText,
  walk,
} from "@ponzu/core";
import type { MeasureRequest, MeasureResult, Renderer } from "@ponzu/render";
import { z } from "zod";
import { fileArg, ToolError, tool } from "./define.ts";
import { overlapLine, pageOverlapList } from "./overlap.ts";
import { plural, resolveFile } from "./util.ts";

export const orientTools = [
  tool({
    name: "get_basic_info",
    title: "Get basic info",
    group: "orient",
    readOnly: true,
    description:
      "Start here. Summarizes the open .design: pages with their folders, artboards with sizes and positions, token names, open comments, artboards that overlap each other, who else is working, and anything in the files Ponzu couldn't use. Call get_guide('basics') once per session for the house rules.",
    input: { file: fileArg },
    async handler({ file }, ctx) {
      const { ws } = ctx;
      const { key, design } = await resolveFile(ctx, file);
      const doc = design.doc;
      const lines = [docSummary(doc, { folderOf: (id) => design.folderOf(id) }), `Path: ${key}`];
      const tokens = parseTokens(doc.tokens);
      if (tokens.length) {
        const limit = 40;
        const shown = tokens.slice(0, limit).map((t) => `${t.name}: ${t.value}`);
        const more = tokens.length - shown.length;
        lines.push(
          `Tokens (${tokens.length}, use as var(--name)):\n  ${shown.join("\n  ")}${more ? `\n  … ${more} more (get_tokens lists them all)` : ""}`,
        );
      } else {
        lines.push(
          "Tokens: none yet. Define colors, type and spacing with set_tokens before building.",
        );
      }
      const problems = design.problems;
      if (problems.length) {
        const limit = 10;
        const shown = problems.slice(0, limit).map((p) => `${p.path}: ${p.what}`);
        const more = problems.length - shown.length;
        lines.push(
          `Not used as written (fix the files; get_guide('format') has the format):\n  ${shown.join("\n  ")}${more ? `\n  … ${more} more` : ""}`,
        );
      }
      const overlaps = [];
      for (const page of doc.pages)
        overlaps.push(...(await pageOverlapList(ws, key, doc, page.artboards)));
      if (overlaps.length) {
        const limit = 10;
        const shown = overlaps.slice(0, limit).map(overlapLine);
        const more = overlaps.length - shown.length;
        lines.push(
          `Overlapping artboards (the canvas draws one over the other):\n  ${shown.join("\n  ")}${more ? `\n  … ${more} more; move these and call get_basic_info again for the rest` : ""}`,
        );
      }
      if (ws.theme)
        lines.push(
          isThemed(doc.tokens) ||
            doc.pages.some((p) => p.artboards.some((ab) => isThemed("", ab.root)))
            ? `The person's canvas is in ${ws.theme} mode, so they see this design's light-dark() colors in ${ws.theme}. Screenshots default to it.`
            : `The person's canvas is in ${ws.theme} mode. These tokens don't change with the theme, so artboards show as they are in both.`,
        );
      const others = ws.presence.list().filter((p) => p.working.length);
      if (others.length)
        lines.push(
          `Working now: ${others.map((p) => `${p.name} on ${p.working.join(", ")}`).join("; ")}`,
        );
      const rest = ws.designs().filter((f) => f.key !== key);
      if (rest.length) {
        const sticks = ctx.session ? " Calls without file use this one." : "";
        lines.push(
          rest.length > 5
            ? `Other open files: ${rest.length} (list_files).${sticks}`
            : `Other open files: ${rest.map((f) => f.design.doc.name).join(", ")}.${sticks}`,
        );
      }
      return { text: lines.join("\n") };
    },
  }),

  tool({
    name: "get_tree",
    title: "Get tree",
    group: "orient",
    readOnly: true,
    description:
      "Indented outline of an artboard, node or page: tag, id, layer name, short text and layout hints. Cheap; use it to find ids before editing. Omit id for the whole file.",
    input: {
      file: fileArg,
      id: z.string().optional().describe("Artboard, node or page id. Omit for the whole file."),
      depth: z.number().int().min(1).max(12).optional().describe("Levels to show. Default 4."),
    },
    async handler({ file, id, depth }, ctx) {
      const { design } = await resolveFile(ctx, file, [id]);
      const doc = design.doc;
      if (!id) return { text: docSummary(doc) };
      const page = findPage(doc, id);
      if (page) {
        if (!page.artboards.length)
          return { text: `Page ${page.id} "${page.name}" has no artboards.` };
        return {
          text: page.artboards
            .map((ab) => outline(ab.root, Math.min(depth ?? 2, 3), { artboard: true }))
            .join("\n\n"),
        };
      }
      const hit = locate(doc, id);
      if (!hit) throw new ToolError(`No artboard, node or page with id ${id}.`);
      const head = hit.parent
        ? `In ${hit.artboard.id} "${hit.artboard.name}"\n`
        : `${artboardSummary(hit.artboard)} · page "${hit.page.name}"\n`;
      return { text: head + outline(hit.node, depth ?? 4, { artboard: !hit.parent }) };
    },
  }),

  tool({
    name: "get_node",
    title: "Get node",
    group: "orient",
    readOnly: true,
    description:
      "Full detail for one node: its rendered box (x, y, width, height in px from the artboard's top left), styles, attributes, parent, children and text. For an artboard, also the height its content needs, so you can set its height in one step.",
    input: { file: fileArg, id: z.string() },
    async handler({ file, id }, ctx) {
      const { ws } = ctx;
      const { key, design } = await resolveFile(ctx, file, [id]);
      const doc = design.doc;
      const hit = locate(doc, id);
      if (!hit) throw new ToolError(`No node with id ${id}.`);
      const n = hit.node;
      const lines = [
        `${n.id} <${n.tag}>${n.name ? ` "${n.name}"` : ""}`,
        `Artboard: ${hit.artboard.id} "${hit.artboard.name}" · file ${design.pathOf(hit.artboard.id) ?? "?"}`,
        hit.parent
          ? `Parent: ${hit.parent.id} ${describeNode(hit.parent)} (child ${hit.index})`
          : `Artboard at (${hit.artboard.x}, ${hit.artboard.y})`,
      ];
      const layout = await measured(
        ws.renderer,
        { artboard: hit.artboard, tokens: doc.tokens, assetBase: ws.assetBase?.(key) },
        n.id,
        !hit.parent,
      );
      if (layout) lines.push(layout);
      const style = Object.entries(n.style);
      if (style.length) lines.push(`Style:\n  ${style.map(([k, v]) => `${k}: ${v}`).join("\n  ")}`);
      const attrs = Object.entries(n.attrs);
      if (attrs.length)
        lines.push(
          `Attributes: ${attrs.map(([k, v]) => `${k}="${v.length > 80 ? `${v.slice(0, 80)}…` : v}"`).join(" ")}`,
        );
      const kids = n.children.filter((c) => c.kind === "el");
      if (kids.length)
        lines.push(
          `Children: ${kids.map((c) => (c.kind === "el" ? `${c.id} ${describeNode(c)}` : "")).join(", ")}`,
        );
      const text = visibleText(n);
      if (text) lines.push(`Text: ${text.length > 400 ? `${text.slice(0, 400)}…` : text}`);
      return { text: lines.join("\n") };
    },
  }),

  tool({
    name: "get_html",
    title: "Get HTML",
    group: "orient",
    readOnly: true,
    description:
      "The HTML of an artboard or node, exactly as stored. Use it to study or reuse existing work. For implementing a design in code, read the .design files directly instead.",
    input: {
      file: fileArg,
      id: z.string(),
      ids: z.boolean().optional().describe("Include data-id attributes. Default true."),
    },
    async handler({ file, id, ids }, ctx) {
      const { design } = await resolveFile(ctx, file, [id]);
      const hit = locate(design.doc, id);
      if (!hit) throw new ToolError(`No artboard or node with id ${id}.`);
      const html = serializeNode(hit.node, { omitIds: ids === false });
      const limit = 60_000;
      return {
        text:
          html.length > limit
            ? `${html.slice(0, limit)}\n… truncated (${html.length} chars). Ask for a child id.`
            : html,
      };
    },
  }),

  tool({
    name: "find_nodes",
    title: "Find nodes",
    group: "orient",
    readOnly: true,
    description:
      "Search nodes by text, layer name, tag, or declared style (property and/or value, including var(--token) references). Filters combine with AND. Searches the whole file unless `within` is given.",
    input: {
      file: fileArg,
      text: z.string().optional().describe("Case-insensitive substring of the node's own text."),
      name: z.string().optional().describe("Case-insensitive substring of the layer name."),
      tag: z.string().optional().describe("Tag name, e.g. h1, img, svg, button."),
      style: z
        .object({ property: z.string().optional(), value: z.string().optional() })
        .optional()
        .describe(
          'Match a declared style, e.g. {"value": "--color-link"} or {"property": "font-size", "value": "64px"}.',
        ),
      attr: z.string().optional().describe("Has this attribute, e.g. src or href."),
      within: z.string().optional().describe("Page, artboard or node id to search inside."),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async handler(args, ctx) {
      const { design } = await resolveFile(ctx, args.file, [args.within]);
      const doc = design.doc;
      const roots = scopeRoots(doc, args.within);
      const results: string[] = [];
      const limit = args.limit ?? 50;
      const prop = args.style?.property
        ?.toLowerCase()
        .replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      const value = args.style?.value?.toLowerCase();
      let total = 0;
      for (const { artboard, root } of roots) {
        for (const { node } of walk(root)) {
          if (args.tag && node.tag.toLowerCase() !== args.tag.toLowerCase()) continue;
          if (args.name && !(node.name ?? "").toLowerCase().includes(args.name.toLowerCase()))
            continue;
          if (args.attr && !(args.attr in node.attrs)) continue;
          if (args.text) {
            const own = node.children
              .filter((c) => c.kind === "text")
              .map((c) => (c.kind === "text" ? c.value : ""))
              .join("");
            if (!own.toLowerCase().includes(args.text.toLowerCase())) continue;
          }
          if (prop || value) {
            const decls = [
              ...Object.entries(node.style),
              ...Object.entries(node.attrs).filter(([k]) =>
                ["fill", "stroke", "stop-color"].includes(k),
              ),
            ];
            const hit = decls.some(
              ([k, v]) => (!prop || k === prop) && (!value || v.toLowerCase().includes(value)),
            );
            if (!hit) continue;
          }
          total++;
          if (results.length < limit)
            results.push(
              `${node.id} ${describeNode(node)} <${node.tag}> in ${artboard.id} "${artboard.name}"`,
            );
        }
      }
      if (!total) return { text: "No matches." };
      return {
        text: `${plural(total, "match")}${total > limit ? ` (showing ${limit})` : ""}:\n${results.join("\n")}`,
      };
    },
  }),
];

/** The node's rendered box as one line, or nothing when there's no renderer to ask. */
async function measured(
  renderer: Renderer | undefined,
  page: Omit<MeasureRequest, "ids">,
  id: string,
  isArtboard: boolean,
): Promise<string | null> {
  if (!renderer?.measure) return null;
  const { artboard } = page;
  let out: MeasureResult;
  try {
    out = await renderer.measure({ ...page, ids: [id] });
  } catch (err) {
    return `Box: couldn't measure (${err instanceof Error ? err.message : String(err)}).`;
  }
  const b = out.boxes[id];
  if (!b) return null;
  const size = `${px(b.width)}×${px(b.height)}`;
  if (isArtboard) {
    const fixed = artboard.root.style.height !== "fit-content";
    const need =
      out.contentHeight === null
        ? "content outgrows any fixed height (a child is sized in % of it); use height: fit-content"
        : !fixed
          ? `content height ${out.contentHeight}px`
          : out.contentHeight > Math.round(b.height)
            ? `content needs ${out.contentHeight}px, ${out.contentHeight - Math.round(b.height)}px more`
            : `content needs ${out.contentHeight}px`;
    return `Rendered: ${size}, ${need}.`;
  }
  return `Box: x ${px(b.x)}, y ${px(b.y)}, ${size}${b.hidden ? " (hidden)" : ""}.`;
}

function px(n: number): string {
  return String(Math.round(n * 10) / 10);
}

function scopeRoots(doc: import("@ponzu/core").Doc, within?: string) {
  const all = doc.pages.flatMap((p) =>
    p.artboards.map((artboard) => ({ artboard, root: artboard.root })),
  );
  if (!within) return all;
  const page = findPage(doc, within);
  if (page) return page.artboards.map((artboard) => ({ artboard, root: artboard.root }));
  const hit = locate(doc, within);
  if (!hit) throw new ToolError(`No page, artboard or node ${within}.`);
  return [{ artboard: hit.artboard, root: hit.node }];
}
