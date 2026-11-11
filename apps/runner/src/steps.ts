import { basename } from "node:path";
import { type Doc, findArtboard, locate } from "@ponzu/core";

/*
 * The working line: a tool call said as what the agent is doing, in a few words a person
 * understands without knowing the tools. "Reading the repo", `Drawing "Pricing · B"`, "Running
 * the dev server". Never the command or its output.
 */

const CANVAS = "mcp__ponzu__";

const CANVAS_READS = new Set([
  "get_basic_info",
  "get_tree",
  "get_node",
  "get_html",
  "find_nodes",
  "get_tokens",
  "read_notes",
]);
const CANVAS_DRAWS = new Set([
  "write_html",
  "update_styles",
  "set_text",
  "set_attributes",
  "duplicate",
  "move_nodes",
  "rename",
  "update_artboard",
  "delete",
]);
const CANVAS_LOOKS = new Set(["screenshot", "record", "export"]);
const CANVAS_OTHER: Record<string, string> = {
  get_guide: "Reading Ponzu's guide",
  set_tokens: "Setting the design's tokens",
  write_note: "Writing notes",
  create_page: "Arranging pages",
  update_page: "Arranging pages",
  archive: "Arranging pages",
  update_design: "Naming the design",
  add_asset: "Adding an asset",
  list_comments: "Reading comments",
  get_comment: "Reading comments",
  create_comment: "Commenting",
  reply: "Replying to a comment",
  set_comment_status: "Resolving comments",
  send_feedback: "Telling Ponzu",
  describe_pull_request: "Describing the pull request",
};

const CANVAS_MAKES = new Set([
  ...CANVAS_DRAWS,
  "create_artboard",
  "set_tokens",
  "write_note",
  "create_page",
  "update_page",
  "archive",
  "update_design",
  "add_asset",
]);
const CANVAS_TAKES_IN = new Set([
  ...CANVAS_READS,
  ...CANVAS_LOOKS,
  "get_guide",
  "list_comments",
  "get_comment",
  "set_status",
]);
const MAKES = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const TAKES_IN = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "AskUserQuestion",
  "ExitPlanMode",
]);

/**
 * How much one step says about a stretch of work, which a finished stretch is named by: what
 * the agent made (2) over what it ran (1) over what it read or looked at (0).
 */
export function stepWeight(name: string): number {
  if (name.startsWith(CANVAS)) {
    const tool = name.slice(CANVAS.length);
    return CANVAS_MAKES.has(tool) ? 2 : CANVAS_TAKES_IN.has(tool) ? 0 : 1;
  }
  return MAKES.has(name) ? 2 : TAKES_IN.has(name) ? 0 : 1;
}

/** A few words for one tool call, read against the design as it is. */
export function stepLabel(name: string, input: Record<string, unknown>, doc: Doc): string {
  if (name.startsWith(CANVAS)) return canvasLabel(name.slice(CANVAS.length), input, doc);
  switch (name) {
    case "Read":
    case "Glob":
    case "Grep":
    case "LS":
      return "Reading the repo";
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit": {
      const path = input.file_path ?? input.notebook_path;
      return typeof path === "string" ? `Editing ${basename(path)}` : "Editing the code";
    }
    case "Bash":
      return commandLabel(String(input.command ?? ""), input.description);
    case "WebFetch":
      return `Reading ${host(input.url) ?? "a web page"}`;
    case "WebSearch":
      return "Searching the web";
    case "Agent":
    case "Task":
      return clip(typeof input.description === "string" ? input.description : "") || "Delegating";
    case "TodoWrite":
      return "Planning the work";
    case "AskUserQuestion":
    case "ExitPlanMode":
      return "Asking you";
    case "Skill":
      return "Using a skill";
    default:
      return "Working";
  }
}

function canvasLabel(tool: string, input: Record<string, unknown>, doc: Doc): string {
  if (tool === "set_status" && typeof input.status === "string") return sentence(input.status);
  if (tool === "create_artboard")
    return typeof input.name === "string" ? `Drawing "${input.name}"` : "Drawing a new artboard";
  if (CANVAS_DRAWS.has(tool)) {
    const board = artboardIn(input, doc);
    return board ? `Drawing "${board}"` : "Drawing on the canvas";
  }
  if (CANVAS_LOOKS.has(tool)) {
    const board = artboardIn(input, doc);
    return board ? `Looking at "${board}"` : "Looking at the canvas";
  }
  if (CANVAS_READS.has(tool)) return "Reading the canvas";
  return CANVAS_OTHER[tool] ?? "Working on the canvas";
}

/** What a shell command is for, by its shape. Its own description when it is none of these. */
function commandLabel(command: string, description: unknown): string {
  const c = command.trim();
  const runner = String.raw`\b(npm|pnpm|yarn|bun|bunx|npx|deno)\b`;
  if (new RegExp(`${runner}\\s+(i|install|add|ci)\\b`).test(c)) return "Installing dependencies";
  if (
    new RegExp(`${runner}.*\\b(dev|start|serve|preview)\\b`).test(c) ||
    /\b(next|vite) dev\b/.test(c)
  )
    return "Running the dev server";
  if (new RegExp(`${runner}.*\\btest\\b`).test(c) || /\b(jest|vitest|pytest)\b/.test(c))
    return "Running the tests";
  if (new RegExp(`${runner}.*\\bbuild\\b`).test(c)) return "Building";
  if (/\bgit\s+commit\b/.test(c)) return "Committing";
  if (/\bgit\s+push\b/.test(c)) return "Pushing the branch";
  if (
    /^\s*(ls|cat|head|tail|find|grep|rg|tree|wc)\b/.test(c) ||
    /\bgit\s+(status|log|diff|show)\b/.test(c)
  )
    return "Reading the repo";
  return (typeof description === "string" && clip(description)) || "Running a command";
}

/** The name of the first artboard a call's ids are in. */
function artboardIn(input: unknown, doc: Doc): string | null {
  for (const id of ids(input)) {
    const board = findArtboard(doc, id)?.artboard ?? locate(doc, id)?.artboard;
    if (board) return board.name;
  }
  return null;
}

/** Every string under a key that names a node or artboard, however deep. */
function* ids(value: unknown, key = ""): Generator<string> {
  if (typeof value === "string") {
    if (/^(id|ids|target|parent)$/.test(key)) yield value;
  } else if (Array.isArray(value)) {
    for (const item of value) yield* ids(item, key);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) yield* ids(v, k);
  }
}

function host(url: unknown): string | null {
  try {
    return typeof url === "string" ? new URL(url).hostname : null;
  } catch {
    return null;
  }
}

function sentence(text: string): string {
  const t = clip(text);
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function clip(text: string, max = 60): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
