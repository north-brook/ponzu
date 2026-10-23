import { type Artboard, findArtboard, findNode, isThemed, locate } from "@ponzu/core";
import type { Interaction, MotionAnimation, MotionInfo } from "@ponzu/render";
import { z } from "zod";
import { fileArg, ToolError, type ToolImage, tool } from "./define.ts";
import { footprintsAround, overlapIssues, overlaps } from "./overlap.ts";
import { resolveFile } from "./util.ts";

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

const colorSchemeArg = z
  .enum(["light", "dark"])
  .optional()
  .describe(
    "Theme for light-dark() colors. Default: the theme the person's canvas is in, else light.",
  );

/**
 * The theme to render in, and a line saying so when the design has one. The
 * person's canvas shows a themed design in its own theme, so renders default to it.
 */
function scheme(
  ws: { theme?: "light" | "dark" },
  tokens: string,
  ab: Artboard,
  asked?: "light" | "dark",
): { colorScheme?: "light" | "dark"; line?: string } {
  if (!isThemed(tokens, ab.root)) return { colorScheme: asked };
  // Always one or the other, so media queries don't follow wherever the renderer runs.
  const colorScheme = asked ?? ws.theme ?? "light";
  const other = colorScheme === "dark" ? "light" : "dark";
  const whose = asked ? "" : ws.theme ? ", the theme the person's canvas is in" : "";
  return {
    colorScheme,
    line: `Shown in ${colorScheme}${whose}. Lint checks colors in ${other} too; pass colorScheme: "${other}" to see it.`,
  };
}

const interactionArgs = {
  hover: z.string().optional().describe("Node id to hover first. Its :hover rules apply."),
  focus: z.string().optional().describe("Node id to focus first. :focus and :focus-visible apply."),
  press: z
    .string()
    .optional()
    .describe("Node id to press (pointer down) first. :active and :hover apply."),
};

export const seeTools = [
  tool({
    name: "screenshot",
    title: "Screenshot",
    group: "see",
    readOnly: true,
    description:
      "Render an artboard or node and look at it. Shows the settled state: every finite animation has finished, the way a person sees the page after it loads. Pass `at` for a moment mid-animation, and hover, focus or press to see a state. Comes with a lint pass that reports clipped text, overflow (with the height the artboard needs), charts and images spilling over their neighbors, short labels wrapping in a row, zero-size and off-artboard elements, artboards overlapping each other on the canvas, broken images, tiny text, missing @keyframes, elements left invisible after an animation, more animating at once than the canvas can keep smooth, and states with no styles. Lists what animates. Use scale 1 for layout checks and 2 only to read small text. Check your work after every few edits; use record to watch motion. A render that stalls stops within a minute and says which step it stalled on; if only the image fails, lint still comes back.",
    input: {
      file: fileArg,
      id: z.string().describe("Artboard or node id."),
      scale: z.number().min(0.25).max(3).optional(),
      colorScheme: colorSchemeArg,
      at: z
        .number()
        .min(0)
        .optional()
        .describe(
          "Milliseconds into the animation timeline. Default: settled. 0 is the first frame. With hover, focus or press, counts from that moment.",
        ),
      ...interactionArgs,
    },
    async handler(args, ctx) {
      const { ws } = ctx;
      if (!ws.renderer)
        throw new ToolError(
          "No renderer is available here, so screenshots are off. Ask the user to install Chrome.",
        );
      const { key, design } = await resolveFile(ctx, args.file, [args.id]);
      const doc = design.doc;
      const ab = findArtboard(doc, args.id)?.artboard ?? locate(doc, args.id)?.artboard;
      if (!ab) throw new ToolError(`No artboard or node ${args.id}.`);
      checkTargets(ab, args);
      const nodeId = ab.id === args.id ? undefined : args.id;
      // Keep the image within a sensible budget: ~1600px on the long side.
      const { w, h } = {
        w: Number.parseFloat(ab.root.style.width ?? "1440") || 1440,
        h: Number.parseFloat(ab.root.style.height ?? "900") || 900,
      };
      const fit = Math.min(1, 1600 / Math.max(w, h));
      const scale = args.scale ?? (nodeId ? 1 : Math.max(0.5, Number(fit.toFixed(2))));
      const theme = scheme(ws, doc.tokens, ab, args.colorScheme);
      const out = await ws.renderer.render({
        artboard: ab,
        tokens: doc.tokens,
        nodeId,
        scale,
        lint: true,
        colorScheme: theme.colorScheme,
        at: args.at,
        interact: interaction(args),
        assetBase: ws.assetBase?.(key),
      });
      // Lint sees one artboard; whether it lands on its neighbors takes the page.
      if (!nodeId) {
        const page = doc.pages.find((p) => p.artboards.includes(ab));
        const known = { [ab.id]: { w: Math.round(out.width), h: Math.round(out.height) } };
        if (page)
          out.issues.push(
            ...overlapIssues(
              ab.id,
              overlaps(await footprintsAround(ws, key, doc, page.artboards, [ab.id], known), [
                ab.id,
              ]),
            ),
          );
      }
      const lint = out.issues.length
        ? `Lint:\n${out.issues.map((i) => `  ${i.id}: ${i.message}`).join("\n")}`
        : "Lint: clean.";
      if (out.captureError)
        return {
          text: `Couldn't capture the image of ${nodeId ?? ab.id}: ${out.captureError}\nThe page rendered, and lint ran on it.\n${lint}`,
          isError: true,
          data: { issues: out.issues, motion: out.motion },
          failure: "capture_failed",
          stage: "capture",
        };
      const image: ToolImage = { data: toBase64(out.bytes), mime: out.mime };
      const lines = [
        `${nodeId ?? ab.id} rendered ${Math.round(out.width)}×${Math.round(out.height)} at ${shownScale(scale, out.scale)}${out.motion ? `, ${moment(out.motion, args.at)}` : ""}.`,
      ];
      if (theme.line) lines.push(theme.line);
      if (out.assetsTimedOut) lines.push(ASSETS_LATE);
      if (!nodeId && ab.root.style.height === "fit-content")
        lines.push(`Content height: ${out.contentHeight}px.`);
      lines.push(lint);
      if (out.motion?.animations.length) lines.push(motionText(out.motion));
      return {
        text: lines.join("\n"),
        images: [image],
        data: { issues: out.issues, motion: out.motion },
      };
    },
  }),

  tool({
    name: "record",
    title: "Record",
    group: "see",
    readOnly: true,
    description:
      "Watch an animation. Steps through the timeline frame by frame (paused and seeked, so frames are exact and repeatable) and returns one contact sheet with every frame labeled by its time, plus what animates: node, keyframes, duration, delay, easing, iterations. By default it covers the whole page load once, or one cycle of anything that loops. Use hover, focus or press to watch a transition into that state, and scroll to step through a scroll container for scroll-driven animation. Lint runs on the last frame. Use it after writing @keyframes, transitions or hover styles, and check easing, overlap and the end state. The person's canvas plays the load once when the artboard appears and then holds the end; hovering doesn't replay it.",
    input: {
      file: fileArg,
      id: z.string().describe("Artboard or node id. Frames show this area."),
      frames: z
        .number()
        .int()
        .min(2)
        .max(24)
        .optional()
        .describe("How many frames, evenly spaced. Default 9; 12–16 for fast or detailed motion."),
      from: z.number().min(0).optional().describe("Start, in ms. Default 0."),
      to: z
        .number()
        .min(0)
        .max(60000)
        .optional()
        .describe(
          "End, in ms. Default: when everything has settled, plus one cycle of any loop (capped at 10s).",
        ),
      scroll: z
        .string()
        .optional()
        .describe(
          "Id of a scroll container (fixed height, overflow: auto). Steps through its scroll range instead of time, for animation-timeline: scroll() or view().",
        ),
      ...interactionArgs,
      colorScheme: colorSchemeArg,
    },
    async handler(args, ctx) {
      const { ws } = ctx;
      if (!ws.renderer)
        throw new ToolError(
          "No renderer is available here, so recording is off. Ask the user to install Chrome.",
        );
      if (!ws.renderer.record)
        throw new ToolError("This renderer can't record. Use screenshot with `at` instead.");
      if (args.scroll && (args.from !== undefined || args.to !== undefined))
        throw new ToolError("scroll steps through a scroll range, so from and to don't apply.");
      if (args.from !== undefined && args.to !== undefined && args.to <= args.from)
        throw new ToolError("to has to be after from.");
      const { key, design } = await resolveFile(ctx, args.file, [args.id]);
      const doc = design.doc;
      const ab = findArtboard(doc, args.id)?.artboard ?? locate(doc, args.id)?.artboard;
      if (!ab) throw new ToolError(`No artboard or node ${args.id}.`);
      checkTargets(ab, args);
      if (args.scroll && !findNode(ab.root, args.scroll))
        throw new ToolError(`No node ${args.scroll} to scroll in this artboard.`);
      const theme = scheme(ws, doc.tokens, ab, args.colorScheme);
      const out = await ws.renderer.record({
        artboard: ab,
        tokens: doc.tokens,
        nodeId: ab.id === args.id ? undefined : args.id,
        colorScheme: theme.colorScheme,
        interact: interaction(args),
        frames: args.frames,
        from: args.from,
        to: args.to,
        scroll: args.scroll,
        lint: true,
        assetBase: ws.assetBase?.(key),
      });
      const m = out.motion;
      const first = out.steps[0]?.label ?? "";
      const last = out.steps[out.steps.length - 1]?.label ?? "";
      const after = m.trigger === "load" ? "" : ` after ${m.trigger}`;
      const lines = [
        out.steps.length === 1
          ? `${args.id}: 1 frame at ${first}${after}.`
          : `${args.id}: ${out.steps.length} frames from ${first} to ${last}${after}, left to right, top to bottom.`,
      ];
      if (theme.line) lines.push(theme.line);
      if (out.assetsTimedOut) lines.push(ASSETS_LATE);
      if (!args.scroll && !m.animations.some((a) => a.timeline === "time" && !a.paused))
        lines.push(
          m.trigger === "load"
            ? "Nothing animates over time on load, so every frame is the same."
            : `Nothing animates on ${m.trigger}: it has no transition or animation. A state change without one snaps.`,
        );
      if (args.scroll && !m.animations.some((a) => a.timeline !== "time"))
        lines.push(
          "No scroll-driven animations: frames only show the content scrolling. Use animation-timeline: scroll() or view() to tie motion to it.",
        );
      if (m.animations.length) lines.push(motionText(m));
      const at = `Lint at the end${m.trigger === "load" ? "" : ` (${m.trigger})`}`;
      if (out.issues.length)
        lines.push(`${at}:\n${out.issues.map((i) => `  ${i.id}: ${i.message}`).join("\n")}`);
      else lines.push(`${at}: clean.`);
      return {
        text: lines.join("\n"),
        images: [{ data: toBase64(out.bytes), mime: out.mime }],
        data: { steps: out.steps, motion: m, issues: out.issues },
      };
    },
  }),

  tool({
    name: "export",
    title: "Export",
    group: "see",
    readOnly: true,
    description:
      "Export an artboard or node as PNG, JPEG or PDF to a file path on disk (default: the design's exports/ folder). A design with light-dark() colors exports in the theme the person's canvas is in unless you pass colorScheme; the file name says which.",
    input: {
      file: fileArg,
      id: z.string(),
      format: z.enum(["png", "jpeg", "pdf"]).optional(),
      scale: z.number().min(0.25).max(4).optional().describe("Default 2."),
      path: z.string().optional().describe("Absolute output path."),
      colorScheme: colorSchemeArg,
    },
    async handler(args, ctx) {
      const { ws } = ctx;
      if (!ws.renderer) throw new ToolError("No renderer available.");
      const { key, design } = await resolveFile(ctx, args.file, [args.id]);
      const doc = design.doc;
      const ab = findArtboard(doc, args.id)?.artboard ?? locate(doc, args.id)?.artboard;
      if (!ab) throw new ToolError(`No artboard or node ${args.id}.`);
      const format = args.format ?? "png";
      const theme = scheme(ws, doc.tokens, ab, args.colorScheme);
      const out = await ws.renderer.render({
        artboard: ab,
        tokens: doc.tokens,
        nodeId: ab.id === args.id ? undefined : args.id,
        scale: args.scale ?? 2,
        format,
        colorScheme: theme.colorScheme,
        assetBase: ws.assetBase?.(key),
      });
      const root = design.storage.root;
      const ext = format === "jpeg" ? "jpg" : format;
      const path =
        args.path ??
        (root
          ? `${root}/exports/${slug(ab.name)}${ab.id === args.id ? "" : `-${args.id}`}${theme.line ? `-${theme.colorScheme}` : ""}.${ext}`
          : null);
      if (!path) throw new ToolError("This design isn't on disk; pass an absolute path.");
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, out.bytes);
      return {
        text: `Wrote ${path} (${Math.round(out.width)}×${Math.round(out.height)} at ${shownScale(args.scale ?? 2, out.scale)}${theme.line ? `, ${theme.colorScheme}` : ""}, ${Math.round(out.bytes.length / 1024)} KB).`,
      };
    },
  }),

  tool({
    name: "timelapse",
    title: "Timelapse",
    group: "see",
    readOnly: true,
    description:
      "Make a timelapse film of the work in a file: a 16:9 MP4 of the design being made, from the person's request to every screen assembled piece by piece, the comments they left and the changes that answered them, ending on Ponzu's mark. It's as long as the work takes at its pace (usually 15 to 25 seconds). Writes it to the design's exports/ folder (timelapse-YYYY-MM-DD.mp4) and returns the path. Covers the last session (since the last hour-long break) unless you pass from and to. Takes about twice as long as the film to make. Only when the person asks for one.",
    input: {
      file: fileArg,
      from: z
        .number()
        .optional()
        .describe("Start of the range, ms since the epoch. Default: the last session's start."),
      to: z.number().optional().describe("End of the range, ms since the epoch. Default: now."),
      colorScheme: colorSchemeArg,
    },
    async handler(args, ctx) {
      const { ws } = ctx;
      if (!ws.timelapse)
        throw new ToolError(
          "Timelapses need the Ponzu app or `ponzu serve` with Chrome installed; this host can't make them.",
        );
      const { key } = await resolveFile(ctx, args.file);
      if (args.from !== undefined && args.to !== undefined && args.to <= args.from)
        throw new ToolError("to has to be after from.");
      const range =
        args.from !== undefined || args.to !== undefined
          ? { from: args.from ?? 0, to: args.to ?? Date.now() }
          : undefined;
      const out = await ws.timelapse(key, {
        shape: "16:9",
        range,
        theme: args.colorScheme ?? ws.theme ?? "light",
      });
      return {
        text: `Wrote ${out.path} (${Math.round(out.duration)}s, ${out.codec.startsWith("avc") ? "H.264" : "VP9"}, ${(out.bytes / 1_048_576).toFixed(1)} MB).`,
        data: out,
      };
    },
  }),
];

const ASSETS_LATE =
  "Fonts or images were still loading when time ran out, so the image may show fallbacks. Lint says which.";

/** The scale an image came out at, and why when it's less than the one asked for. */
function shownScale(asked: number, got: number | undefined): string {
  if (got === undefined || got >= asked) return `${asked}x`;
  return `${got}x (${asked}x would be too big for one image; screenshot a node to see it closer)`;
}

/** Hover, focus and press ids have to be in the artboard being rendered. */
function checkTargets(ab: Artboard, args: Interaction) {
  for (const [what, id] of [
    ["hover", args.hover],
    ["focus", args.focus],
    ["press", args.press],
  ] as const) {
    if (id && !findNode(ab.root, id))
      throw new ToolError(`No node ${id} to ${what} in ${ab.id}. Ids come from get_tree.`);
  }
}

function interaction(args: Interaction): Interaction | undefined {
  const { hover, focus, press } = args;
  return hover || focus || press ? { hover, focus, press } : undefined;
}

/** Where on the timeline a screenshot sits, in words. */
function moment(m: MotionInfo, at: number | undefined): string {
  const after = m.trigger === "load" ? "" : ` after ${m.trigger}`;
  if (at === undefined) {
    if (!m.animations.length) return m.trigger === "load" ? "static" : `${m.trigger}, no motion`;
    return `settled at ${ms(m.settled)}${after}`;
  }
  const where = at < m.settled ? `of ${ms(m.settled)} to settle` : "settled";
  return `at ${ms(at)}${after} (${where})`;
}

function motionText(m: MotionInfo): string {
  const loops = m.loops ? `; loops, one cycle is ${ms(m.cycle)}` : "";
  const head = `Motion (${m.trigger}): settles at ${ms(m.settled)}${loops}.`;
  const rows = m.animations.slice(0, 20).map((a) => `  ${animationLine(a)}`);
  if (m.animations.length > 20) rows.push(`  …and ${m.animations.length - 20} more`);
  return [head, ...rows].join("\n");
}

function animationLine(a: MotionAnimation): string {
  const who = `${a.id || "?"}${a.pseudo ?? ""}`;
  if (a.kind === "video")
    return `${who}: video ${a.name}, ${ms(a.duration)}${a.iterations === null ? ", loops" : ""}`;
  const what =
    a.kind === "transition"
      ? `transition ${a.name}`
      : a.kind === "smil"
        ? `SVG <animate> ${a.name}`
        : `${a.name}${a.properties.length ? ` (${a.properties.slice(0, 4).join(", ")})` : ""}`;
  if (a.timeline !== "time") return `${who}: ${what} on a ${a.timeline} timeline, ${a.easing}`;
  const parts = [
    ms(a.duration),
    a.delay ? `delay ${ms(a.delay)}` : "",
    a.easing,
    a.iterations === null ? "infinite" : a.iterations !== 1 ? `×${a.iterations}` : "",
    a.direction !== "normal" ? a.direction : "",
    a.end !== null ? `ends ${ms(a.end)}` : "",
    a.paused ? "paused in CSS, never plays" : "",
  ].filter(Boolean);
  return `${who}: ${what} ${parts.join(", ")}`;
}

function ms(n: number): string {
  return n >= 1000 && n % 100 === 0 ? `${n / 1000}s` : `${Math.round(n)}ms`;
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "artboard"
  );
}
