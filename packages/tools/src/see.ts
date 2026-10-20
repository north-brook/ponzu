import { findArtboard, locate } from "@ponzu/core";
import { z } from "zod";
import { fileArg, ToolError, type ToolImage, tool } from "./define.ts";

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export const seeTools = [
  tool({
    name: "screenshot",
    title: "Screenshot",
    group: "see",
    readOnly: true,
    description:
      "Render an artboard or node and look at it. Comes with a lint pass that reports clipped text, overflow, zero-size and off-artboard elements, broken images and tiny text. Use scale 1 for layout checks and 2 only to read small text. Check your work after every few edits.",
    input: {
      file: fileArg,
      id: z.string().describe("Artboard or node id."),
      scale: z.number().min(0.25).max(3).optional(),
      colorScheme: z
        .enum(["light", "dark"])
        .optional()
        .describe("For tokens that use light-dark()."),
    },
    async handler(args, { ws }) {
      if (!ws.renderer)
        throw new ToolError(
          "No renderer is available here, so screenshots are off. Ask the user to install Chrome.",
        );
      const { design } = await ws.resolve(args.file);
      const doc = design.doc;
      const ab = findArtboard(doc, args.id)?.artboard ?? locate(doc, args.id)?.artboard;
      if (!ab) throw new ToolError(`No artboard or node ${args.id}.`);
      const nodeId = ab.id === args.id ? undefined : args.id;
      // Keep the image within a sensible budget: ~1600px on the long side.
      const { w, h } = {
        w: Number.parseFloat(ab.root.style.width ?? "1440") || 1440,
        h: Number.parseFloat(ab.root.style.height ?? "900") || 900,
      };
      const fit = Math.min(1, 1600 / Math.max(w, h));
      const scale = args.scale ?? (nodeId ? 1 : Math.max(0.5, Number(fit.toFixed(2))));
      const out = await ws.renderer.render({
        artboard: ab,
        tokens: doc.tokens,
        nodeId,
        scale,
        lint: true,
        colorScheme: args.colorScheme,
      });
      const image: ToolImage = { data: toBase64(out.bytes), mime: out.mime };
      const lines = [
        `${nodeId ?? ab.id} rendered ${Math.round(out.width)}×${Math.round(out.height)} at ${scale}x.`,
      ];
      if (!nodeId && ab.root.style.height === "fit-content")
        lines.push(`Content height: ${out.contentHeight}px.`);
      if (out.issues.length)
        lines.push(`Lint:\n${out.issues.map((i) => `  ${i.id}: ${i.message}`).join("\n")}`);
      else lines.push("Lint: clean.");
      return { text: lines.join("\n"), images: [image], data: { issues: out.issues } };
    },
  }),

  tool({
    name: "export",
    title: "Export",
    group: "see",
    readOnly: true,
    description:
      "Export an artboard or node as PNG, JPEG or PDF to a file path on disk (default: the design's exports/ folder).",
    input: {
      file: fileArg,
      id: z.string(),
      format: z.enum(["png", "jpeg", "pdf"]).optional(),
      scale: z.number().min(0.25).max(4).optional().describe("Default 2."),
      path: z.string().optional().describe("Absolute output path."),
    },
    async handler(args, { ws }) {
      if (!ws.renderer) throw new ToolError("No renderer available.");
      const { design } = await ws.resolve(args.file);
      const doc = design.doc;
      const ab = findArtboard(doc, args.id)?.artboard ?? locate(doc, args.id)?.artboard;
      if (!ab) throw new ToolError(`No artboard or node ${args.id}.`);
      const format = args.format ?? "png";
      const out = await ws.renderer.render({
        artboard: ab,
        tokens: doc.tokens,
        nodeId: ab.id === args.id ? undefined : args.id,
        scale: args.scale ?? 2,
        format,
      });
      const root = design.storage.root;
      const ext = format === "jpeg" ? "jpg" : format;
      const path =
        args.path ??
        (root
          ? `${root}/exports/${slug(ab.name)}${ab.id === args.id ? "" : `-${args.id}`}.${ext}`
          : null);
      if (!path) throw new ToolError("This design isn't on disk; pass an absolute path.");
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, out.bytes);
      return {
        text: `Wrote ${path} (${Math.round(out.width)}×${Math.round(out.height)} @${args.scale ?? 2}x, ${Math.round(out.bytes.length / 1024)} KB).`,
      };
    },
  }),
];

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "artboard"
  );
}
