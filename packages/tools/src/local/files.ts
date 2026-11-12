import { type Doc, emptyDoc, locate, newId, type Op, parseTokens } from "@ponzu/core";
import { z } from "zod";
import type { OpenCanvas, ToolCanvas } from "../canvas.ts";
import { type FileSource, SESSION_FILES, type ToolContext } from "../context.ts";
import { type ToolDef, ToolError, tool } from "../define.ts";
import { ICON_HINT, icon } from "../organize.ts";
import { apply, plural } from "../util.ts";

/*
 * What only the local server needs: a design is a .design folder, several can be open at once,
 * and a call says which it means with a `file` argument. Deleted with the local server.
 */

export const fileArg = z
  .string()
  .optional()
  .describe(
    "Which .design, by path or name. Omit to use the file that holds the ids you pass, else the one you last created, named or edited in this session.",
  );

/** What a design kept as files can say about them. Store's `Design` has all of it. */
export interface DesignFiles {
  /** Write pending changes now. */
  flush(): Promise<void>;
  /** Where an artboard is stored, relative to the design's folder. */
  pathOf(artboardId: string): string | undefined;
  /** Page id → the folder its artboard files live in. */
  pageFolders(): Map<string, string>;
  /** What couldn't be used in the files as last read. */
  readonly problems: readonly { path: string; what: string }[];
  /** Artboard files caught half-written. */
  readonly heldFiles: readonly string[];
  readonly storage: { readonly root?: string };
}

/** The local server only opens designs kept as files, so its tools can ask about them. */
export function filesOf(design: ToolCanvas): DesignFiles {
  return design as ToolCanvas & DesignFiles;
}

/**
 * A tool as the local server offers it: with the `file` argument, which the call's design is
 * found from.
 */
export function onFile(def: ToolDef<any>): ToolDef<any> {
  return {
    ...def,
    input: { file: fileArg, ...def.input },
    handler({ file, ...args }, ctx) {
      ctx.pick = (ids) => resolveFile(ctx, file as string | undefined, ids);
      return def.handler(args, ctx);
    },
  };
}

/**
 * The design a call works on. A `file` argument wins; then the open design
 * that holds the ids the call passes; then the session's file; then the only
 * open design. Whichever it is becomes the session's file.
 */
export async function resolveFile(
  ctx: ToolContext,
  file: string | undefined,
  ids: (string | undefined)[] = [],
): Promise<OpenCanvas> {
  const { ws, session } = ctx;
  const all = ws.canvases();
  const current = all.find((d) => d.key === session?.file);
  let picked: OpenCanvas;
  let from: FileSource;
  const wanted = ids.filter((id): id is string => Boolean(id));
  if (file) {
    picked = await ws.resolve(file);
    from = "arg";
  } else {
    // The files that hold the most of these ids: an id only one copy has outweighs ids they
    // share, and a page name passed in place of an id counts for none.
    const counts = all.map((d) => wanted.filter((id) => holds(d.canvas.doc, id)).length);
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
  const doc = picked.canvas.doc;
  for (const id of wanted) {
    if (holds(doc, id)) continue;
    const other = all.find((d) => d.key !== picked.key && holds(d.canvas.doc, id));
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
  if (session) {
    session.file = picked.key;
    session.files = [picked.key, ...(session.files ?? []).filter((k) => k !== picked.key)].slice(
      0,
      SESSION_FILES,
    );
  }
  ws.presence.saw(ctx.caller, picked.key);
  return picked;
}

/** A design's name, with its path when another open file shares the name. */
export function label(picked: OpenCanvas, all: OpenCanvas[]): string {
  const name = picked.canvas.doc.name;
  return all.some((d) => d.key !== picked.key && d.canvas.doc.name === name)
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
export function fileList(files: OpenCanvas[], limit = 5): string {
  const shown = files.slice(0, limit).map((f) => `${f.canvas.doc.name} (${f.key})`);
  return files.length > limit
    ? `${shown.join(", ")} and ${files.length - limit} more`
    : shown.join(", ");
}

/** The tools that manage .design folders themselves. */
export const fileTools = [
  tool({
    name: "list_files",
    title: "List files",
    group: "organize",
    readOnly: true,
    description:
      "The .design files open in this Ponzu session. The one marked (current) is what calls without file use.",
    input: {
      query: z
        .string()
        .optional()
        .describe("Only files whose name or path contains this, case-insensitive."),
    },
    handler(args, { ws, session }) {
      const all = ws.canvases();
      if (!all.length) return { text: "No files open. Use create_file." };
      const q = args.query?.toLowerCase();
      const files = q
        ? all.filter(
            ({ key, canvas: design }) =>
              key.toLowerCase().includes(q) || design.doc.name.toLowerCase().includes(q),
          )
        : all;
      if (!files.length)
        return {
          text: `No open file matches "${args.query}" (${plural(all.length, "file")} open).`,
        };
      return {
        text: files
          .map(({ key, canvas: design }) => {
            const ab = design.doc.pages.reduce((n, p) => n + p.artboards.length, 0);
            return `${design.doc.name} — ${key} (${plural(design.doc.pages.length, "page")}, ${plural(ab, "artboard")})${key === session?.file ? " (current)" : ""}`;
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
      "Create a new .design folder with its pages and tokens in one call, then open it; later calls without file use it. Put it next to the code it designs (e.g. ./design/app.design) unless the user says otherwise. To import or generate a whole design by writing its files instead, see get_guide('format').",
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
      icon: icon.optional().describe(`Shown on the file's tab. ${ICON_HINT}`),
      scratch: z
        .boolean()
        .optional()
        .describe(
          "For a file you make for your own use (an experiment, a test fixture), not for the person: Ponzu keeps it archived, out of their Recent designs.",
        ),
      pages: z
        .array(z.object({ name: z.string(), icon: icon.optional().describe(ICON_HINT) }))
        .optional()
        .describe("Default: one page called Home."),
      tokens: z
        .string()
        .optional()
        .describe(
          "CSS with custom properties, e.g. ':root { --color-ink: #111; --font-sans: \"Inter\", sans-serif; }'",
        ),
    },
    async handler(args, { ws, session, caller }) {
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
      if (args.icon) doc.icon = args.icon;
      if (args.scratch) doc.scratch = true;
      for (const p of args.pages?.length ? args.pages : [{ name: "Home" }]) {
        doc.pages.push({
          id: newId("pg"),
          name: p.name,
          ...(p.icon ? { icon: p.icon } : {}),
          artboards: [],
        });
      }
      if (args.tokens) doc.tokens = args.tokens.endsWith("\n") ? args.tokens : `${args.tokens}\n`;
      const { key, canvas: design } = await ws.create(args.path, doc);
      if (session) session.file = key;
      const link = ws.link?.(key, { origin: caller.reachedAt });
      return {
        text: `Created ${key}${link ? `\nLink: ${link}` : ""}\nPages: ${design.doc.pages.map((p) => `${p.id} "${p.name}"`).join(", ")}\nTokens: ${parseTokens(design.doc.tokens).length}`,
      };
    },
  }),

  tool({
    name: "update_file",
    title: "Update file",
    group: "organize",
    description:
      "Rename a file (its tab title), change the icon on its tab, or mark it as scratch.",
    input: {
      file: fileArg,
      name: z.string().min(1).optional(),
      icon: icon.nullable().optional().describe(`${ICON_HINT} null removes it.`),
      scratch: z
        .boolean()
        .optional()
        .describe("true archives it, out of the person's Recent designs; false brings it back."),
    },
    async handler(args, ctx) {
      const { key, canvas: design } = await resolveFile(ctx, args.file);
      const ops: Op[] = [];
      if (args.name !== undefined) ops.push({ op: "file.rename", name: args.name });
      if (args.icon !== undefined) ops.push({ op: "file.icon", icon: args.icon });
      if (args.scratch !== undefined) ops.push({ op: "file.scratch", scratch: args.scratch });
      if (!ops.length) return { text: "Nothing to change." };
      apply(design, ops.length === 1 ? ops[0]! : { op: "batch", ops }, ctx);
      return { text: `Updated ${key}.` };
    },
  }),
];
