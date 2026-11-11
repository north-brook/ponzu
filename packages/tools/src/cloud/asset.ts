import { basename, extname } from "node:path";
import { z } from "zod";
import { ToolError, tool } from "../define.ts";
import { fileSize, localFiles, readGiven } from "../disk.ts";
import { designOf } from "../util.ts";

/** The largest file add_asset takes. */
export const MAX_ASSET_BYTES = 20 * 1024 * 1024;

/** A kind of file a design can hold as an asset. */
interface AssetType {
  mime: string;
  /** In a sentence: "a PNG image". */
  called: string;
  /** Whether a file that starts with these bytes is one. */
  is(head: Uint8Array): boolean;
}

/** Whether `bytes` holds these ASCII characters at `at`. */
function ascii(bytes: Uint8Array, at: number, text: string): boolean {
  return [...text].every((char, i) => bytes[at + i] === char.charCodeAt(0));
}

function startsWith(bytes: Uint8Array, ...values: number[]): boolean {
  return values.every((value, i) => bytes[i] === value);
}

/** An ISO media file (MP4, AVIF) whose `ftyp` box names one of these brands, or any when none is given. */
function isoMedia(head: Uint8Array, ...brands: string[]): boolean {
  if (!ascii(head, 4, "ftyp")) return false;
  if (!brands.length) return true;
  // The box is its length, "ftyp", the major brand, a version, then the compatible brands.
  const end = Math.min(head.length, new DataView(head.buffer, head.byteOffset).getUint32(0));
  for (let at = 8; at + 4 <= end; at += at === 8 ? 8 : 4)
    if (brands.some((brand) => ascii(head, at, brand))) return true;
  return false;
}

/** Fonts are an sfnt table whichever of the two extensions they carry. */
const isSfnt = (head: Uint8Array) =>
  startsWith(head, 0x00, 0x01, 0x00, 0x00) || ascii(head, 0, "OTTO") || ascii(head, 0, "true");

const JPEG: AssetType = {
  mime: "image/jpeg",
  called: "a JPEG image",
  is: (head) => startsWith(head, 0xff, 0xd8, 0xff),
};

/** What a design can hold as an asset, by file extension. */
const ASSET_TYPES: Record<string, AssetType> = {
  png: {
    mime: "image/png",
    called: "a PNG image",
    is: (head) => startsWith(head, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
  },
  jpg: JPEG,
  jpeg: JPEG,
  gif: {
    mime: "image/gif",
    called: "a GIF image",
    is: (head) => ascii(head, 0, "GIF87a") || ascii(head, 0, "GIF89a"),
  },
  webp: {
    mime: "image/webp",
    called: "a WebP image",
    is: (head) => ascii(head, 0, "RIFF") && ascii(head, 8, "WEBP"),
  },
  avif: {
    mime: "image/avif",
    called: "an AVIF image",
    is: (head) => isoMedia(head, "avif", "avis"),
  },
  svg: {
    mime: "image/svg+xml",
    called: "an SVG image",
    // Text, so no signature: an XML declaration, a doctype or comments may come first.
    is: (head) => /<svg[\s>]/i.test(new TextDecoder().decode(head)),
  },
  woff2: { mime: "font/woff2", called: "a WOFF2 font", is: (head) => ascii(head, 0, "wOF2") },
  woff: { mime: "font/woff", called: "a WOFF font", is: (head) => ascii(head, 0, "wOFF") },
  ttf: { mime: "font/ttf", called: "a TrueType font", is: isSfnt },
  otf: { mime: "font/otf", called: "an OpenType font", is: isSfnt },
  mp4: { mime: "video/mp4", called: "an MP4 video", is: (head) => isoMedia(head) },
  webm: {
    mime: "video/webm",
    called: "a WebM video",
    is: (head) => startsWith(head, 0x1a, 0x45, 0xdf, 0xa3),
  },
};

/** How much of a file says what it is. An SVG's root element can follow a long preamble. */
const HEAD_BYTES = 4096;

/** An asset's name: what follows `assets/` in markup, so one plain file name. */
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const addAsset = tool({
  name: "add_asset",
  title: "Add asset",
  group: "write",
  description: `Add an image, a font or a video to the design from a file in the sandbox: one in the repo, or one you made or downloaded with your own tools. Returns the reference to use for it, like assets/logo.png: as src in markup, or inside url() in styles and tokens. Up to ${fileSize(MAX_ASSET_BYTES)}. Types: ${Object.keys(ASSET_TYPES).join(", ")}. The file has to be what its name says.`,
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
    const type = ASSET_TYPES[extname(name).slice(1).toLowerCase()];
    if (!type)
      throw new ToolError(
        `${name} isn't a kind of file a design can hold. Assets are images, fonts and video: ${Object.keys(ASSET_TYPES).join(", ")}.`,
      );
    const bytes = await readGiven(
      ws.files ?? localFiles,
      args.path,
      MAX_ASSET_BYTES,
      "Make it smaller first: resize or compress an image, shorten or re-encode a video.",
    );
    if (!bytes.length) throw new ToolError(`${args.path} is empty.`);
    // The name alone would let any file in the sandbox out under an image's name, and would
    // keep the error page a failed download saved as hero.jpg.
    if (!type.is(bytes.subarray(0, HEAD_BYTES)))
      throw new ToolError(
        `${args.path} isn't ${type.called}, whatever its name: it doesn't start the way one does. If you downloaded it, look at what came back. If it is another kind of image, font or video, name it with that kind's extension.`,
      );
    const ref = await ws.storeAsset(key, { name, bytes, mime: type.mime });
    return {
      text: `Added ${ref} (${fileSize(bytes.length)}). Use it as src="${ref}" in markup, or url(${ref}) in styles and tokens.`,
      data: { ref },
    };
  },
});
