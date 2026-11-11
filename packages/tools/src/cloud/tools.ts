import { basename, extname } from "node:path";
import { MAX_OP_BYTES, type Op } from "@ponzu/core";
import { z } from "zod";
import { converseTools } from "../converse.ts";
import { type ToolDef, ToolError, tool } from "../define.ts";
import { type AgentFiles, absolute, localFiles, readGiven } from "../disk.ts";
import { guideTool, listenTools } from "../listen.ts";
import { ICON_HINT, icon, organizeTools } from "../organize.ts";
import { orientTools } from "../orient.ts";
import { exportInput, exportTo, seeTools } from "../see.ts";
import { apply, designOf } from "../util.ts";
import { writeTools } from "../write.ts";
import { addAsset } from "./asset.ts";
import { cloudGuides } from "./guides.ts";

/** What one call takes, however its HTML arrives. The basics guide says the same. */
const ONE_CALL =
  "A file doesn't raise what one call takes: about 10,000 elements and pieces of text, and 1 MB as stored.";

/**
 * A tool that takes HTML, as a sandbox offers it: in the call, or in a file the agent wrote
 * with its own file tools. `about` is added to the tool's description.
 *
 * Only here, and not in the tool itself: in a sandbox the tools run beside the agent, on files
 * it can read anyway. The local server's callers may be on another machine.
 */
function htmlByPath(def: ToolDef<any>, about: string): ToolDef<any> {
  // create_artboard can go without any HTML; write_html can't.
  const needed = !def.input.html.safeParse(undefined).success;
  return {
    ...def,
    description: `${def.description} ${about}`,
    input: {
      ...def.input,
      html: z.string().optional().describe("The HTML."),
      path: z
        .string()
        .optional()
        .describe(
          `Instead of html: the absolute path of a file that holds it, which you wrote with your own file tools. For HTML too long to pass in a call: a long table, a diagram a script generated. ${ONE_CALL}`,
        ),
    },
    async handler({ path, ...args }, ctx) {
      if (path !== undefined && args.html !== undefined)
        throw new ToolError("Pass html or path, not both.");
      const html =
        path === undefined ? args.html : await htmlAt(ctx.ws.files ?? localFiles, path as string);
      if (needed && html === undefined)
        throw new ToolError("Pass html, or the path of a file that holds it.");
      return def.handler({ ...args, html }, ctx);
    },
  };
}

/** The HTML in a file the agent wrote. */
async function htmlAt(files: AgentFiles, path: string): Promise<string> {
  // An op's limit: HTML doesn't get smaller when stored, so a larger file wouldn't fit one.
  const bytes = await readGiven(
    files,
    path,
    MAX_OP_BYTES,
    "Split the HTML into parts and write each with its own write_html call; append is the default mode.",
  );
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ToolError(`${path} isn't text. HTML is read as UTF-8.`);
  }
}

const HTML_BY_PATH: Record<string, string> = {
  create_artboard: "Or pass the `path` of a file that holds the HTML.",
  write_html: `For HTML too long to pass in a call (a long table, a diagram from a script), write it to a file with your own file tools and pass its path instead of html: it is read, cleaned and written the same way. ${ONE_CALL}`,
};

/** The shared write tools, the ones that take HTML taking a file of it too. */
const sandboxWriteTools = writeTools.map((def: ToolDef<any>) => {
  const about = HTML_BY_PATH[def.name];
  return about ? htmlByPath(def, about) : def;
});

type ExportFormat = "png" | "jpeg" | "pdf";

/** The format a path's extension asks for. */
const EXPORT_FORMATS: Record<string, ExportFormat> = {
  ".png": "png",
  ".jpg": "jpeg",
  ".jpeg": "jpeg",
  ".pdf": "pdf",
};

/**
 * The format to export in: the one `path` ends in. A file is what its name says, so a path
 * with another ending, or a `format` that disagrees with it, is refused before anything is
 * rendered or written.
 */
function exportFormat(path: string, asked: ExportFormat | undefined): ExportFormat {
  const ext = extname(path);
  const format = EXPORT_FORMATS[ext.toLowerCase()];
  if (!format)
    throw new ToolError(
      `${path} ${ext ? `ends in ${ext}` : "has no extension"}. An export is a PNG, a JPEG or a PDF: end the path in .png, .jpg or .pdf.`,
    );
  if (asked && asked !== format)
    throw new ToolError(
      `format is ${asked}, but ${path} ends in ${ext}. An export is a PNG, a JPEG or a PDF, and the path's ending says which (.png, .jpg or .pdf): change the path, or leave format out.`,
    );
  return format;
}

const exportTool = tool({
  name: "export",
  title: "Export",
  group: "see",
  description:
    "Export an artboard or node as PNG, JPEG or PDF to a file in the sandbox, at the path you choose: inside the repo when it should be committed. The path's ending says the format: .png, .jpg or .pdf. When Ponzu can host the file too, the result also has a link to it, for a pull request description, say. A design with light-dark() colors exports in the theme the person's canvas is in unless you pass colorScheme.",
  input: {
    ...exportInput,
    path: z
      .string()
      .describe(
        "Absolute path of the file to write, ending in .png, .jpg or .pdf. Its folders are made.",
      ),
  },
  async handler({ path, ...args }, ctx) {
    const { ws } = ctx;
    const format = exportFormat(absolute(path), args.format);
    const out = await exportTo(ctx, { ...args, format }, () => path);
    if (!ws.publish) return { text: out.text };
    const { key } = await designOf(ctx);
    const file = { name: basename(out.path), bytes: out.bytes, mime: out.mime };
    try {
      const link = await ws.publish(key, file);
      return { text: `${out.text}\nLink: ${link}`, data: { link } };
    } catch (err) {
      // The file is written, which is what was asked for: the link is the extra.
      const reason = err instanceof Error ? err.message : String(err);
      return { text: `${out.text}\nNo link: it couldn't be published (${reason}).` };
    }
  },
});

const updateDesign = tool({
  name: "update_design",
  title: "Update design",
  group: "organize",
  description:
    'Name the design, or change its icon. Give a new design a real name once you know what it is: a few words for what is being designed, like "Checkout flow".',
  input: {
    name: z.string().min(1).optional(),
    icon: icon.nullable().optional().describe(`${ICON_HINT} null removes it.`),
  },
  async handler(args, ctx) {
    const { design } = await designOf(ctx);
    const ops: Op[] = [];
    if (args.name !== undefined) ops.push({ op: "file.rename", name: args.name });
    if (args.icon !== undefined) ops.push({ op: "file.icon", icon: args.icon });
    if (!ops.length) return { text: "Nothing to change." };
    apply(design, ops.length === 1 ? ops[0]! : { op: "batch", ops }, ctx);
    const { name, icon } = design.doc;
    return { text: `The design is "${name}"${icon ? `, with the ${icon} icon` : ""}.` };
  },
});

/**
 * Every tool an agent has in a design's sandbox, in the order it should discover them. One
 * design per sandbox, so no tool takes a file; no tool waits for activity, since comments and
 * messages arrive as turns; and nothing here names a place inside a .design folder.
 */
export const cloudTools: ToolDef<any>[] = [
  ...orientTools,
  ...sandboxWriteTools,
  addAsset,
  ...seeTools,
  exportTool,
  updateDesign,
  ...organizeTools,
  ...converseTools,
  ...listenTools,
  guideTool(
    cloudGuides,
    "basics, layout, typography, comments (how comments and messages reach you, and what to do with each), variations, code (rebuilding UI that is already in the repo, and building a design in code), motion, product (product shots: faux UI heroes, feature cards, bento grids, demos), act (scene scripts: a cursor that clicks and types, things that appear, totals that roll), kit (windows, phones and rows at real geometry), mobile",
  ),
];

export function getCloudTool(name: string): ToolDef<any> | undefined {
  return cloudTools.find((t) => t.name === name);
}
