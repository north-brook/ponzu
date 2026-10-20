import { emptyDoc, findPage, newId, type Op, parseTokens, setTokens } from "@ponzu/core";
import { z } from "zod";
import { fileArg, ToolError, tool } from "./define.ts";
import { apply, plural } from "./util.ts";

const PAGE_ICONS = [
  "page",
  "file",
  "home",
  "layout",
  "phone",
  "tablet",
  "desktop",
  "palette",
  "type",
  "image",
  "grid",
  "list",
  "chart",
  "flow",
  "star",
  "archive",
  "note",
  "code",
  "settings",
  "user",
  "cart",
  "mail",
  "map",
  "calendar",
  "book",
] as const;

export const organizeTools = [
  tool({
    name: "list_files",
    title: "List files",
    group: "organize",
    readOnly: true,
    description: "The .design files open in this Ponzu session.",
    input: {},
    handler(_args, { ws }) {
      const files = ws.designs();
      if (!files.length) return { text: "No files open. Use create_file." };
      return {
        text: files
          .map(({ key, design }) => {
            const ab = design.doc.pages.reduce((n, p) => n + p.artboards.length, 0);
            return `${design.doc.name} — ${key} (${plural(design.doc.pages.length, "page")}, ${plural(ab, "artboard")})`;
          })
          .join("\n"),
      };
    },
  }),

  tool({
    name: "create_file",
    title: "Create file",
    group: "organize",
    description:
      "Create a new .design folder with its pages and tokens in one call, then open it. Put it next to the code it designs (e.g. ./design/app.design) unless the user says otherwise.",
    input: {
      path: z
        .string()
        .describe(
          "Folder path ending in .design. Relative paths resolve from your working directory.",
        ),
      name: z
        .string()
        .optional()
        .describe(
          'Shown as the tab title, e.g. "Onboarding" or "Checkout flow". Default: the folder name without .design, case unchanged.',
        ),
      pages: z
        .array(z.object({ name: z.string(), icon: z.enum(PAGE_ICONS).optional() }))
        .optional()
        .describe("Default: one page called Home."),
      tokens: z
        .string()
        .optional()
        .describe(
          "CSS with custom properties, e.g. ':root { --color-ink: #111; --font-sans: \"Inter\", sans-serif; }'",
        ),
    },
    async handler(args, { ws }) {
      if (!ws.create) throw new ToolError("This host doesn't create files.");
      if (!/\.design\/?$/.test(args.path)) throw new ToolError("The path should end in .design");
      const name =
        args.name ??
        args.path
          .replace(/\/$/, "")
          .split("/")
          .pop()!
          .replace(/\.design$/, "");
      const doc = emptyDoc(name);
      for (const p of args.pages?.length ? args.pages : [{ name: "Home" }]) {
        doc.pages.push({
          id: newId("pg"),
          name: p.name,
          ...(p.icon ? { icon: p.icon } : {}),
          artboards: [],
        });
      }
      if (args.tokens) doc.tokens = args.tokens.endsWith("\n") ? args.tokens : `${args.tokens}\n`;
      const { key, design } = await ws.create(args.path, doc);
      return {
        text: `Created ${key}\nPages: ${design.doc.pages.map((p) => `${p.id} "${p.name}"`).join(", ")}\nTokens: ${parseTokens(design.doc.tokens).length}`,
      };
    },
  }),

  tool({
    name: "create_page",
    title: "Create page",
    group: "organize",
    description:
      "Add a page (a folder of artboards). Pages are for big groupings: flows, platforms, explorations, an archive.",
    input: {
      file: fileArg,
      name: z.string(),
      icon: z.enum(PAGE_ICONS).optional(),
      index: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Position in the page list. Default last."),
    },
    async handler(args, ctx) {
      const { design } = await ctx.ws.resolve(args.file);
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
      return { text: `Created page ${id} "${args.name}".` };
    },
  }),

  tool({
    name: "update_page",
    title: "Update page",
    group: "organize",
    description:
      "Rename a page, change its icon, move it in the page list, or delete it (with its artboards).",
    input: {
      file: fileArg,
      page: z.string().describe("Page id or name."),
      name: z.string().optional(),
      icon: z.enum(PAGE_ICONS).nullable().optional(),
      index: z.number().int().min(0).optional(),
      delete: z.boolean().optional(),
    },
    async handler(args, ctx) {
      const { design } = await ctx.ws.resolve(args.file);
      const doc = design.doc;
      const page = findPage(doc, args.page);
      if (!page) throw new ToolError(`No page ${args.page}.`);
      if (args.delete) {
        if (doc.pages.length === 1) throw new ToolError("A file needs at least one page.");
        apply(design, { op: "page.delete", id: page.id }, ctx);
        return {
          text: `Deleted page "${page.name}" and ${plural(page.artboards.length, "artboard")}.`,
        };
      }
      const ops: Op[] = [];
      if (args.name !== undefined || args.icon !== undefined)
        ops.push({ op: "page.update", id: page.id, name: args.name, icon: args.icon });
      if (args.index !== undefined) {
        const ids = doc.pages.map((p) => p.id).filter((id) => id !== page.id);
        ids.splice(Math.min(args.index, ids.length), 0, page.id);
        ops.push({ op: "page.order", ids });
      }
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
    input: { file: fileArg, ids: z.array(z.string()).min(1) },
    async handler(args, ctx) {
      const { design } = await ctx.ws.resolve(args.file);
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
    description: "The design tokens as plain CSS (tokens.css). Use them in styles as var(--name).",
    input: { file: fileArg },
    async handler(args, { ws }) {
      const { design } = await ws.resolve(args.file);
      return { text: design.doc.tokens.trim() || ":root {}" };
    },
  }),

  tool({
    name: "set_tokens",
    title: "Set tokens",
    group: "organize",
    description:
      'Set or remove custom properties in tokens.css; null removes. Values are any CSS, including light-dark(#fff, #111) for themes. Or pass `css` to replace the whole stylesheet (it may hold @font-face and @import too). Example: {"--color-ink": "#0E0E0E", "--radius-md": "10px"}',
    input: {
      file: fileArg,
      tokens: z.record(z.string(), z.union([z.string(), z.null()])).optional(),
      css: z.string().optional(),
    },
    async handler(args, ctx) {
      const { design } = await ctx.ws.resolve(args.file);
      let css = args.css ?? design.doc.tokens;
      if (args.tokens) css = setTokens(css, args.tokens);
      if (!args.css && !args.tokens) throw new ToolError("Pass tokens or css.");
      apply(design, { op: "tokens", css }, ctx);
      return { text: `Tokens: ${parseTokens(css).length} defined.` };
    },
  }),
];
