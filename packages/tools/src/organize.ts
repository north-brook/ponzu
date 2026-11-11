import { findPage, newId, type Op, PAGE_ICONS, parseTokens, setTokens } from "@ponzu/core";
import { z } from "zod";
import { ToolError, tool } from "./define.ts";
import { apply, designOf, plural } from "./util.ts";

/** What an icon is for, on every field that takes one. */
export const ICON_HINT =
  'Name what\'s inside, as specifically as the list allows: phone for a mobile app, palette for tokens, login for sign-in, cart for checkout, layers or compare for variations, idea for explorations, sitemap for information architecture. Pages in one design read best with different icons. star means a favourite, not "interesting".';

export const icon = z.enum(PAGE_ICONS);

export const organizeTools = [
  tool({
    name: "create_page",
    title: "Create page",
    group: "organize",
    description:
      "Add a page: a canvas of its own, holding artboards. Pages are for big groupings: flows, platforms, explorations, an archive.",
    input: {
      name: z.string(),
      icon: icon.optional().describe(ICON_HINT),
      index: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Position in the page list. Default last."),
    },
    async handler(args, ctx) {
      const { key, design } = await designOf(ctx);
      const id = newId("pg");
      apply(
        design,
        {
          op: "page.create",
          index: args.index ?? design.doc.pages.length,
          page: { id, name: args.name, ...(args.icon ? { icon: args.icon } : {}) },
        },
        ctx,
      );
      const link = ctx.ws.linkTo?.(key, { page: id });
      return { text: `Created page ${id} "${args.name}".${link ? `\nLink: ${link}` : ""}` };
    },
  }),

  tool({
    name: "update_page",
    title: "Update page",
    group: "organize",
    description:
      "Rename a page, change its icon, move it in the page list, or delete it (with its artboards).",
    input: {
      page: z.string().describe("Page id or name."),
      name: z.string().optional(),
      icon: icon.nullable().optional().describe(`${ICON_HINT} null removes it.`),
      index: z.number().int().min(0).optional(),
      delete: z.boolean().optional(),
    },
    async handler(args, ctx) {
      const { design } = await designOf(ctx, [args.page]);
      const doc = design.doc;
      const page = findPage(doc, args.page);
      if (!page) throw new ToolError(`No page ${args.page}.`);
      if (args.delete) {
        if (doc.pages.length === 1) throw new ToolError("A design needs at least one page.");
        apply(design, { op: "page.delete", id: page.id }, ctx);
        return {
          text: `Deleted page "${page.name}" and ${plural(page.artboards.length, "artboard")}.`,
        };
      }
      const ops: Op[] = [];
      if (args.name !== undefined || args.icon !== undefined)
        ops.push({ op: "page.update", id: page.id, name: args.name, icon: args.icon });
      if (args.index !== undefined) ops.push({ op: "page.move", id: page.id, index: args.index });
      if (!ops.length) return { text: "Nothing to change." };
      apply(design, { op: "batch", ops }, ctx);
      return { text: `Updated page ${page.id}.` };
    },
  }),

  tool({
    name: "archive",
    title: "Archive",
    group: "organize",
    description:
      "Move superseded artboards to an Archive page (created if needed, kept last) and pack them into a grid. Keeps the working pages clean without losing history.",
    input: { ids: z.array(z.string()).min(1) },
    async handler(args, ctx) {
      const { design } = await designOf(ctx, args.ids);
      const doc = design.doc;
      const ops: Op[] = [];
      const archive = doc.pages.find((p) => p.name.toLowerCase() === "archive");
      const archiveId = archive?.id ?? newId("pg");
      if (!archive)
        ops.push({
          op: "page.create",
          index: doc.pages.length,
          page: { id: archiveId, name: "Archive", icon: "archive" },
        });
      const existing = archive?.artboards ?? [];
      let bottom =
        existing.reduce(
          (m, a) => Math.max(m, a.y + (Number.parseFloat(a.root.style.height ?? "900") || 900)),
          -80,
        ) + 160;
      if (!existing.length) bottom = 0;
      let x = 0;
      let rowH = 0;
      for (const id of args.ids) {
        const hit = doc.pages.flatMap((p) => p.artboards).find((a) => a.id === id);
        if (!hit) throw new ToolError(`No artboard ${id}.`);
        const w = Number.parseFloat(hit.root.style.width ?? "1440") || 1440;
        const h = Number.parseFloat(hit.root.style.height ?? "900") || 900;
        if (x > 0 && x + w > 6000) {
          x = 0;
          bottom += rowH + 160;
          rowH = 0;
        }
        ops.push({ op: "artboard.move", id, page: archiveId, index: 1e9 });
        ops.push({ op: "artboard.update", id, x, y: bottom });
        x += w + 80;
        rowH = Math.max(rowH, h);
      }
      apply(design, { op: "batch", ops }, ctx);
      return { text: `Archived ${plural(args.ids.length, "artboard")} to page ${archiveId}.` };
    },
  }),

  tool({
    name: "get_tokens",
    title: "Get tokens",
    group: "organize",
    readOnly: true,
    description: "The design tokens as plain CSS. Use them in styles as var(--name).",
    input: {},
    async handler(_args, ctx) {
      const { design } = await designOf(ctx);
      return { text: design.doc.tokens.trim() || ":root {}" };
    },
  }),

  tool({
    name: "set_tokens",
    title: "Set tokens",
    group: "organize",
    description:
      'Set or remove custom properties in the design\'s tokens; null removes. Values are any CSS, including light-dark(#fff, #111) for themes. Or pass `css` to replace the whole stylesheet (it may hold @font-face and @import too). Example: {"--color-ink": "#0E0E0E", "--radius-md": "10px"}',
    input: {
      tokens: z.record(z.string(), z.union([z.string(), z.null()])).optional(),
      css: z.string().optional(),
    },
    async handler(args, ctx) {
      const { design } = await designOf(ctx);
      let css = args.css ?? design.doc.tokens;
      if (args.tokens) css = setTokens(css, args.tokens);
      if (!args.css && !args.tokens) throw new ToolError("Pass tokens or css.");
      apply(design, { op: "tokens", css }, ctx);
      return { text: `Tokens: ${parseTokens(css).length} defined.` };
    },
  }),
];
