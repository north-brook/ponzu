import { basename, extname } from "node:path";
import type { Op } from "@ponzu/core";
import { z } from "zod";
import { converseTools } from "../converse.ts";
import { type ToolDef, ToolError, tool } from "../define.ts";
import { absolute, fileSize, readGiven } from "../disk.ts";
import { guideTool, listenTools } from "../listen.ts";
import { ICON_HINT, icon, organizeTools } from "../organize.ts";
import { orientTools } from "../orient.ts";
import { exportInput, exportTo, seeTools } from "../see.ts";
import { apply, designOf } from "../util.ts";
import { writeTools } from "../write.ts";
import { cloudGuides } from "./guides.ts";

/** The largest file add_asset takes. */
export const MAX_ASSET_BYTES = 20 * 1024 * 1024;

/** What a design can hold as an asset, by file extension. */
const ASSET_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
  mp4: "video/mp4",
  webm: "video/webm",
};

/** An asset's name: what follows `assets/` in markup, so one plain file name. */
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const addAsset = tool({
  name: "add_asset",
  title: "Add asset",
  group: "write",
  description: `Add an image, a font or a video to the design from a file in the sandbox: one in the repo, or one you made or downloaded with your own tools. Returns the reference to use for it, like assets/logo.png: as src in markup, or inside url() in styles and tokens. Up to ${fileSize(MAX_ASSET_BYTES)}. Types: ${Object.keys(ASSET_TYPES).join(", ")}.`,
  input: {
    path: z.string().describe("Absolute path of the file."),
    name: z
      .string()
      .optional()
      .describe(
        "The file name to keep it under, with its extension: letters, numbers, dots, dashes and underscores. Default: the file's own name.",
      ),
  },
  async handler(args, ctx) {
    const { ws } = ctx;
    if (!ws.storeAsset) throw new ToolError("Assets can't be added here.");
    const { key } = await designOf(ctx);
    // A file's own name may have spaces and the like; a name the agent chose has to be right.
    const name = args.name ?? basename(args.path).replace(/[^A-Za-z0-9._-]+/g, "-");
    if (!ASSET_NAME.test(name))
      throw new ToolError(
        `"${name}" can't be an asset's name. Use letters, numbers, dots, dashes and underscores, starting with a letter or number, like hero-photo.jpg.`,
      );
    const mime = ASSET_TYPES[extname(name).slice(1).toLowerCase()];
    if (!mime)
      throw new ToolError(
        `${name} isn't a kind of file a design can hold. Assets are images, fonts and video: ${Object.keys(ASSET_TYPES).join(", ")}.`,
      );
    const bytes = await readGiven(
      args.path,
      MAX_ASSET_BYTES,
      "Make it smaller first: resize or compress an image, shorten or re-encode a video.",
    );
    if (!bytes.length) throw new ToolError(`${args.path} is empty.`);
    const ref = await ws.storeAsset(key, { name, bytes, mime });
    return {
      text: `Added ${ref} (${fileSize(bytes.length)}). Use it as src="${ref}" in markup, or url(${ref}) in styles and tokens.`,
      data: { ref },
    };
  },
});

/** The format a path's extension asks for. */
const EXPORT_FORMATS: Record<string, "png" | "jpeg" | "pdf"> = {
  ".png": "png",
  ".jpg": "jpeg",
  ".jpeg": "jpeg",
  ".pdf": "pdf",
};

const exportTool = tool({
  name: "export",
  title: "Export",
  group: "see",
  description:
    "Export an artboard or node as PNG, JPEG or PDF to a file in the sandbox, at the path you choose: inside the repo when it should be committed. The format follows the path's extension unless you pass format. When Ponzu can host the file too, the result also has a link to it, for a pull request description, say. A design with light-dark() colors exports in the theme the person's canvas is in unless you pass colorScheme.",
  input: {
    ...exportInput,
    path: z.string().describe("Absolute path of the file to write. Its folders are made."),
  },
  async handler({ path, ...args }, ctx) {
    const { ws } = ctx;
    const format = args.format ?? EXPORT_FORMATS[extname(path).toLowerCase()];
    const out = await exportTo(ctx, { ...args, format }, () => absolute(path));
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
  ...writeTools,
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
