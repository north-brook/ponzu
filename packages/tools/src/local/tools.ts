import { docSummary } from "@ponzu/core";
import { z } from "zod";
import { converseTools } from "../converse.ts";
import { type ToolDef, ToolError, tool } from "../define.ts";
import { GUIDES } from "../guides.ts";
import { guideTool, listenTools } from "../listen.ts";
import { organizeTools } from "../organize.ts";
import { getNode, orientTools, overview } from "../orient.ts";
import { exportInput, exportTo, seeTools } from "../see.ts";
import { type ArtboardNote, canvasOf } from "../util.ts";
import { createArtboard, writeTools } from "../write.ts";
import { filesOf, fileTools, onFile } from "./files.ts";
import { reminding, waitForActivity } from "./watch.ts";

/*
 * The tools as the local server offers them: the shared ones with a `file` argument and what a
 * folder of files adds (paths, the watch loop), plus the tools that manage folders. The cloud's
 * list is `cloudTools`. Deleted with the local server.
 */

/** An artboard's file, which is on disk by the time this says so. */
const written: ArtboardNote = async ({ canvas: design }, id) => {
  const files = filesOf(design);
  // On disk before this returns: an agent may write the file next, and a save still
  // waiting would put the empty artboard back over it.
  await files.flush();
  const file = files.pathOf(id);
  return file ? ` · file ${file}` : "";
};

const getBasicInfo = tool({
  name: "get_basic_info",
  title: "Get basic info",
  group: "orient",
  readOnly: true,
  description:
    "Start here. Summarizes the open .design: pages with their folders, artboards with sizes and positions, token names, open comments, artboards that overlap each other, who else is working, and anything in the files Ponzu couldn't use. Call get_guide('basics') once per session for the house rules.",
  input: {},
  async handler(_args, ctx) {
    const open = await canvasOf(ctx);
    const { key, canvas: design } = open;
    const files = filesOf(design);
    const folders = files.pageFolders();
    const lines = await overview(
      ctx,
      open,
      docSummary(design.doc, { folderOf: (id) => folders.get(id) }),
      "give the person this, not the path, to open it in Ponzu; add &page=<id> to open on a page, &artboard=<id> on one artboard",
    );
    lines.splice(1, 0, `Path: ${key}`);
    const problems = files.problems;
    if (problems.length) {
      const limit = 10;
      const shown = problems.slice(0, limit).map((p) => `${p.path}: ${p.what}`);
      const more = problems.length - shown.length;
      lines.push(
        `Not used as written (fix the files; get_guide('format') has the format):\n  ${shown.join("\n  ")}${more ? `\n  … ${more} more` : ""}`,
      );
    }
    const held = files.heldFiles;
    if (held.length)
      lines.push(
        `Still being written, shown as last read whole (write files whole: a temp file, then rename it into place):\n  ${held.join("\n  ")}`,
      );
    const rest = ctx.ws.canvases().filter((f) => f.key !== key);
    if (rest.length) {
      const sticks = ctx.session ? " Calls without file use this one." : "";
      lines.push(
        rest.length > 5
          ? `Other open files: ${rest.length} (list_files).${sticks}`
          : `Other open files: ${rest.map((f) => f.canvas.doc.name).join(", ")}.${sticks}`,
      );
    }
    return { text: lines.join("\n"), metrics: { held_files: held.length } };
  },
});

const exportTool = tool({
  name: "export",
  title: "Export",
  group: "see",
  readOnly: true,
  description:
    "Export an artboard or node as PNG, JPEG or PDF to a file path on disk (default: the design's exports/ folder). A design with light-dark() colors exports in the theme the person's canvas is in unless you pass colorScheme; the file name says which.",
  input: { ...exportInput, path: z.string().optional().describe("Absolute output path.") },
  async handler({ path, ...args }, ctx) {
    const { text } = await exportTo(ctx, args, (name, { canvas: design }) => {
      if (path) return path;
      const root = filesOf(design).storage.root;
      if (!root) throw new ToolError("This design isn't on disk; pass an absolute path.");
      return `${root}/exports/${name}`;
    });
    return { text };
  },
});

/** What the local server says or does differently, by tool. */
const LOCAL: Record<string, { description?: string; handler?: ToolDef<any>["handler"] }> = {
  get_basic_info: getBasicInfo,
  get_node: {
    handler: (args: any, ctx) =>
      getNode(
        args,
        ctx,
        ({ canvas: design }, id) => ` · file ${filesOf(design).pathOf(id) ?? "?"}`,
      ),
  },
  get_html: {
    description:
      "The HTML of an artboard or node, exactly as stored. Use it to study or reuse existing work. For implementing a design in code, read the .design files directly instead.",
  },
  create_artboard: {
    description:
      "Add an artboard (a top-level frame, stored as its own HTML file). It's placed in a free spot unless you give x/y. Defaults to a flex column, even when its style sets display: flex; give flex-direction: row for side-by-side panes. Typical sizes: desktop 1440×900, tablet 768×1024, phone 390×844. Use height 'fit-content' for long pages. Optionally pass `html` to fill it in the same call.",
    handler: (args: any, ctx) => createArtboard(args, ctx, written),
  },
  write_html: {
    description:
      "Insert HTML into a node, or replace a node with HTML. Use inline styles, flexbox/grid, and var(--token) values. Write in small visual pieces (a header, then a row, then a card) and screenshot as you go. Name important layers with data-name. Returns the new ids. To set a whole artboard's content in one call, target the artboard with mode replace-children. For content too big for a call (a long table, a diagram from a script), write the artboard's HTML file directly instead, at the path create_artboard or get_node gives; Ponzu picks the change up live.",
  },
  set_status: {
    description:
      "Optional. Say in a few words what you're doing, e.g. 'tightening the hero'; the person reads it on hover over the yuzu rain in the header of each artboard you're working on. Artboards you change already show as worked on (a yuzu ring breathes round them, their page and file tabs shimmer) until you go two minutes without a tool call or call wait_for_activity. Pass artboards to claim them before your first edit.",
  },
};

const local = (def: ToolDef<any>): ToolDef<any> => onFile({ ...def, ...LOCAL[def.name] });

/** Every Ponzu tool the local server offers, in the order agents should discover them. */
export const tools: ToolDef<any>[] = [
  ...orientTools.map(local),
  ...writeTools.map(local),
  ...seeTools.map((def) => onFile(reminding(def))),
  onFile(exportTool),
  ...fileTools,
  ...organizeTools.map(local),
  ...converseTools.map((def) => (def.name === "send_feedback" ? def : local(def))),
  waitForActivity,
  ...listenTools.map(local),
  guideTool(
    GUIDES,
    "basics, layout, typography, watch (the comment loop), variations, implement, format (writing the files directly), motion, product (product shots: faux UI heroes, feature cards, bento grids, demos), act (scene scripts: a cursor that clicks and types, things that appear, totals that roll), kit (windows, phones and rows at real geometry), mobile",
  ),
];

export function getTool(name: string): ToolDef<any> | undefined {
  return tools.find((t) => t.name === name);
}
