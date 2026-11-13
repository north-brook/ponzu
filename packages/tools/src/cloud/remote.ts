import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { type ToolDef, ToolError, tool } from "../define.ts";
import { fileSize } from "../disk.ts";
import { exportInput, exportTo } from "../see.ts";
import { canvasOf } from "../util.ts";
import { writeTools } from "../write.ts";
import { assetType, MAX_ASSET_BYTES, storeAsset } from "./asset.ts";
import { cloudTools, exportTool } from "./tools.ts";

/*
 * The canvas tools for an agent outside the sandbox: a person's own agent driving a canvas
 * through Ponzu's MCP (docs/cloud.md, "Driving a canvas"). They run in the sandbox's runner as
 * the cloud's do, on its replica and its renderer, but the agent's files are on its own
 * computer, which the sandbox can't read. So nothing here takes a path: HTML comes in the call,
 * an asset as its bytes or an https address, and an export comes back as a link.
 */

/** The longest an asset's address may take to answer. */
const FETCH_MS = 20_000;

const remoteAddAsset = tool({
  name: "add_asset",
  title: "Add asset",
  group: "write",
  description: `Add an image, a font or a video to the canvas, from its bytes (base64) or an https address. Returns the reference to use for it, like assets/logo.png: as src in markup, or inside url() in styles and tokens. Up to ${fileSize(MAX_ASSET_BYTES)}. The file has to be what its name says.`,
  input: {
    name: z
      .string()
      .describe(
        "The file name to keep it under, with its extension (png, jpg, gif, webp, avif, svg, woff2, woff, ttf, otf, mp4, webm): letters, numbers, dots, dashes and underscores.",
      ),
    data: z.string().optional().describe("The file's bytes, base64."),
    url: z.string().optional().describe("Instead of data: an https address to fetch it from."),
  },
  async handler(args, ctx) {
    if ((args.data === undefined) === (args.url === undefined))
      throw new ToolError("Pass the file as data (base64) or url, one of the two.");
    const type = assetType(args.name);
    let bytes: Uint8Array;
    let from: string;
    if (args.data !== undefined) {
      bytes = new Uint8Array(Buffer.from(args.data, "base64"));
      from = "The data";
    } else {
      from = args.url!;
      bytes = await fetched(args.url!);
    }
    if (bytes.length > MAX_ASSET_BYTES)
      throw new ToolError(
        `${from} is ${fileSize(bytes.length)}; an asset is at most ${fileSize(MAX_ASSET_BYTES)}. Make it smaller first.`,
      );
    return storeAsset(ctx, { name: args.name, type, bytes, from });
  },
});

/** An https address's bytes, or a refusal that says why not. */
async function fetched(address: string): Promise<Uint8Array> {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new ToolError(`${address} isn't an address.`);
  }
  if (url.protocol !== "https:") throw new ToolError("Only an https address can be fetched.");
  let response: Response;
  try {
    response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(FETCH_MS) });
  } catch (err) {
    throw new ToolError(
      `${address} couldn't be fetched: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!response.ok) throw new ToolError(`${address} answered ${response.status}.`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_ASSET_BYTES)
    throw new ToolError(
      `${address} is ${fileSize(length)}; an asset is at most ${fileSize(MAX_ASSET_BYTES)}.`,
    );
  return new Uint8Array(await response.arrayBuffer());
}

const remoteExport = tool({
  name: "export",
  title: "Export",
  group: "see",
  description:
    "Export an artboard or node as PNG, JPEG or PDF, and get a link to the file, to download it or put it in a pull request description. Work with light-dark() colors exports in the theme the person sees Ponzu in unless you pass colorScheme.",
  input: exportInput,
  async handler(args, ctx) {
    const { ws } = ctx;
    if (!ws.publish) throw new ToolError("Exports can't be published from here.");
    const folder = await mkdtemp(join(tmpdir(), "ponzu-export-"));
    const out = await exportTo(ctx, args, (name) => join(folder, name));
    const { key } = await canvasOf(ctx);
    const name = out.path.slice(folder.length + 1);
    const link = await ws.publish(key, { name, bytes: out.bytes, mime: out.mime });
    return {
      text: `${out.text.replace(out.path, name)}\nLink: ${link}`,
      data: { link },
    };
  },
});

/** In place of the sandbox's own, by name. */
const REPLACED: Record<string, ToolDef<any>> = {
  ...Object.fromEntries(
    writeTools
      .filter((def) => def.name === "write_html" || def.name === "create_artboard")
      .map((def) => [def.name, def]),
  ),
  add_asset: remoteAddAsset,
  [exportTool.name]: remoteExport,
};

/**
 * Every canvas tool a person's own agent has when it drives a canvas, in the cloud's order: the
 * cloud's own, with the ones that take a path in the sandbox swapped for ones that don't.
 */
export const remoteTools: ToolDef<any>[] = cloudTools.map((def) => REPLACED[def.name] ?? def);

export function getRemoteTool(name: string): ToolDef<any> | undefined {
  return remoteTools.find((def) => def.name === name);
}

/** A tool as an MCP lists it: what the API offers without loading the tools themselves. */
export interface RemoteToolEntry {
  name: string;
  title: string;
  description: string;
  /** JSON Schema (draft 7) of its input. */
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  destructive: boolean;
}

/** The catalogue of `remoteTools`, which `remote-catalog.json` holds for the API. */
export function remoteCatalog(): RemoteToolEntry[] {
  return remoteTools.map((def) => ({
    name: def.name,
    title: def.title,
    description: def.description,
    inputSchema: z.toJSONSchema(z.object(def.input), { target: "draft-7" }) as Record<
      string,
      unknown
    >,
    readOnly: def.readOnly ?? false,
    destructive: def.destructive ?? false,
  }));
}
