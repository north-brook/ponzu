import { basename, isAbsolute, relative } from "node:path";
import { type Doc, findArtboard, locate } from "@ponzu/core";

/*
 * What the agent is doing, said from the tool call it is making: the thread's working state
 * ("Drawing "4 · About you"", "Reading src/app/page.tsx", "Running tests") and, in the past
 * tense, the turn's record of what it did ("Drew "4 · About you""). Plain words in sentence
 * case, naming boards by their names and files by a short path. Never a command line, a tool's
 * input or output, a file's contents, or anything that looks like a secret: an object that
 * fails `shown` is left out and the phrase falls back to its plain form ("Committing",
 * "Searching the repo"), and a phrase holding one of the sandbox's secret values is never said.
 */

/** One tool call, said. */
export interface Step {
  /** The working state while it runs: "Drawing "Hero"". Null when the call says nothing new. */
  doing: string | null;
  /** What it did, for the turn's record: "Drew "Hero"". Null for a call that isn't a step. */
  done: string | null;
  /** The board it made or changed, by name. */
  board?: string;
  /** The file it changed, by its short path. */
  file?: string;
  /**
   * What the agent says it is about (set_status, its plan's step in progress): the working
   * state between its tool calls until it next speaks.
   */
  intent?: string;
  /** How much it says about the turn: a commit (3), what it made (2), ran (1), read (0). */
  weight: number;
}

export interface StepContext {
  /** The design as the runner holds it, to name boards. */
  doc: Doc;
  /** The checkout, which paths are said relative to. */
  cwd?: string;
  /** Values never to be said: the repo's secrets, the Claude credential. */
  secrets?: readonly string[];
}

const CANVAS = "mcp__ponzu__";
/** The longest a board's name, a quoted word or a path is said. */
const NAME = 40;
const PATH = 36;

const step = (
  doing: string | null,
  done: string | null,
  weight = 0,
  extra: Partial<Step> = {},
) => ({
  doing,
  done,
  weight,
  ...extra,
});

/**
 * A tool call as a step. `input` may be empty (the call is still being written): the plain
 * phrase for the tool then, which its full input makes specific once it is known.
 */
export function describeStep(name: string, input: Record<string, unknown>, ctx: StepContext): Step {
  const said = name.startsWith(CANVAS)
    ? canvasStep(name.slice(CANVAS.length), input, ctx)
    : name.startsWith("mcp__")
      ? serverStep(name)
      : codeStep(name, input, ctx);
  return guarded(said, name, ctx);
}

/** A phrase holding a secret value is said in the tool's plain words instead. */
function guarded(said: Step, name: string, ctx: StepContext): Step {
  const secret = (text: string | null | undefined) =>
    !!text && (ctx.secrets ?? []).some((value) => value.length >= 6 && text.includes(value));
  if (![said.doing, said.done, said.board, said.file, said.intent].some(secret)) return said;
  const plain = name.startsWith(CANVAS)
    ? canvasStep(name.slice(CANVAS.length), {}, { doc: emptyish })
    : name.startsWith("mcp__")
      ? serverStep(name)
      : codeStep(name, {}, {});
  return { doing: plain.doing, done: plain.done, weight: said.weight };
}

const emptyish = { pages: [] } as unknown as Doc;

/* ------------------------------------------------------------------ */
/* The canvas                                                          */
/* ------------------------------------------------------------------ */

function canvasStep(tool: string, input: Record<string, unknown>, ctx: StepContext): Step {
  const doc = ctx.doc;
  const on = () => boardIn(input, doc);
  const q = (name: string | null) => (name ? `"${name}"` : null);
  switch (tool) {
    case "get_basic_info":
    case "get_tokens":
    case "find_nodes":
      return step("Reading the canvas", "Read the canvas");
    case "get_tree":
    case "get_node":
    case "get_html": {
      const b = q(on());
      return b ? step(`Reading ${b}`, `Read ${b}`) : step("Reading the canvas", "Read the canvas");
    }
    case "read_notes":
      return step("Reading the notes", "Read the notes");
    case "get_guide": {
      const topic = typeof input.topic === "string" && /^[a-z][a-z -]{1,20}$/.test(input.topic);
      return topic
        ? step(`Reading the ${input.topic} guide`, `Read the ${input.topic} guide`)
        : step("Reading Ponzu's guide", "Read Ponzu's guide");
    }
    case "create_artboard": {
      const name = shown(input.name, NAME);
      return name
        ? step(`Drawing "${name}"`, `Drew "${name}"`, 2, { board: name })
        : step("Drawing a new board", "Drew a new board", 2);
    }
    case "write_html":
      return made(on(), "Drawing", "Drew", "on the canvas");
    case "update_styles":
      return made(on(), "Restyling", "Restyled", "the canvas");
    case "set_text": {
      const b = on();
      return b
        ? step(`Writing the copy for "${b}"`, `Wrote the copy for "${b}"`, 2, { board: b })
        : step("Writing copy", "Wrote copy", 2);
    }
    case "set_attributes":
      return made(on(), "Editing", "Edited", "the canvas");
    case "duplicate":
      return made(on(), "Copying", "Copied", "part of the canvas");
    case "move_nodes":
      return made(on(), "Rearranging", "Rearranged", "the canvas");
    case "rename":
      return made(on(), "Naming layers in", "Named layers in", "the canvas");
    case "update_artboard": {
      const b = on();
      const to = shown(input.name, NAME);
      if (b && to && to !== b)
        return step(`Renaming "${b}" to "${to}"`, `Renamed "${b}" to "${to}"`, 2, { board: to });
      const resize = input.width !== undefined || input.height !== undefined;
      const [doing, done] = resize ? ["Resizing", "Resized"] : ["Moving", "Moved"];
      return b
        ? step(`${doing} "${b}"`, `${done} "${b}"`, 2, { board: b })
        : step(`${doing} a board`, `${done} a board`, 2);
    }
    case "delete": {
      // A board deleted whole is said by its name; a piece of one, as taken out of it.
      const whole = [...ids(input)]
        .map((id) => findArtboard(doc, id)?.artboard.name)
        .find((n) => n && shown(n, NAME));
      if (whole) return step(`Deleting "${whole}"`, `Deleted "${whole}"`, 2);
      const b = on();
      if (b)
        return step(`Removing a layer from "${b}"`, `Removed a layer from "${b}"`, 2, { board: b });
      // Already gone from the copy the runner holds: an artboard's id still says what it was.
      return [...ids(input)].some((id) => id.startsWith("ab_"))
        ? step("Deleting a board", "Deleted a board", 2)
        : step("Removing a layer", "Removed a layer", 2);
    }
    case "archive": {
      const b = on();
      const more = Math.max(0, [...ids(input)].length - 1);
      return b
        ? step(
            `Archiving "${b}"${more ? ` and ${more} more` : ""}`,
            `Archived "${b}"${more ? ` and ${more} more` : ""}`,
            2,
          )
        : step("Archiving boards", "Archived boards", 2);
    }
    case "screenshot": {
      const b = q(on());
      return b
        ? step(`Taking a screenshot of ${b}`, `Took a screenshot of ${b}`)
        : step("Taking a screenshot", "Took a screenshot");
    }
    case "record": {
      const b = q(on());
      return b
        ? step(`Watching ${b} move`, `Watched ${b} move`)
        : step("Watching an animation", "Watched an animation");
    }
    case "export": {
      const b = q(on());
      return b ? step(`Exporting ${b}`, `Exported ${b}`, 1) : step("Exporting", "Exported", 1);
    }
    case "add_asset": {
      const file = typeof input.path === "string" ? shown(basename(input.path), NAME) : null;
      return file
        ? step(`Adding ${file} to the design`, `Added ${file} to the design`, 2)
        : step("Adding a file to the design", "Added a file to the design", 2);
    }
    case "update_design": {
      const name = shown(input.name, NAME);
      if (name) return step(`Naming the design "${name}"`, `Named the design "${name}"`, 1);
      if (input.icon !== undefined)
        return step("Choosing the design's icon", "Chose the design's icon", 1);
      // Its input still to come, or a name that may not be said.
      return step("Naming the design", "Named the design", 1);
    }
    case "create_page": {
      const name = shown(input.name, NAME);
      return name
        ? step(`Adding the page "${name}"`, `Added the page "${name}"`, 2)
        : step("Adding a page", "Added a page", 2);
    }
    case "update_page":
      return input.delete === true
        ? step("Deleting a page", "Deleted a page", 2)
        : step("Arranging pages", "Arranged pages", 2);
    case "set_tokens":
      return step("Setting the design's tokens", "Set the design's tokens", 2);
    case "write_note": {
      const name = shown(input.name, NAME);
      return name
        ? step(`Writing the note "${name}"`, `Wrote the note "${name}"`, 2)
        : step("Writing a note", "Wrote a note", 2);
    }
    case "list_comments":
    case "get_comment":
      return step("Reading comments", "Read comments");
    case "create_comment": {
      const b = q(on());
      return b
        ? step(`Leaving a comment on ${b}`, `Left a comment on ${b}`, 1)
        : step("Leaving a comment", "Left a comment", 1);
    }
    case "reply":
      return step("Replying to a comment", "Replied to a comment", 1);
    case "set_comment_status":
      return input.status === "open"
        ? step("Reopening a comment", "Reopened a comment", 1)
        : step("Resolving a comment", "Resolved a comment", 1);
    case "send_feedback":
      return step("Sending Ponzu feedback", "Sent Ponzu feedback", 1);
    case "describe_pull_request":
      return step("Describing the pull request", "Described the pull request", 1);
    case "wait_for_activity":
      return step("Waiting for comments", "Waited for comments");
    // The local server's tools for a folder of designs: the cloud has one design a sandbox,
    // but the same server can be the agent's elsewhere.
    case "list_files":
      return step("Looking through the designs", "Looked through the designs");
    case "create_file": {
      const name = shown(input.name, NAME);
      return name
        ? step(`Starting the design "${name}"`, `Started the design "${name}"`, 2)
        : step("Starting a new design", "Started a new design", 2);
    }
    case "update_file":
      return canvasStep("update_design", input, ctx);
    case "set_status": {
      // The agent saying what it is about: not a step, but the state until it next speaks.
      const intent = shown(input.status, 60);
      return step(null, null, 0, intent ? { intent: sentence(intent) } : {});
    }
    default:
      return step("Working on the canvas", "Worked on the canvas", 1);
  }
}

/** A change to a board, said by the board's name. */
function made(board: string | null, doing: string, done: string, nowhere: string): Step {
  return board
    ? step(`${doing} "${board}"`, `${done} "${board}"`, 2, { board })
    : step(`${doing} ${nowhere}`, `${done} ${nowhere}`, 2);
}

/** The name of the first artboard a call's ids are in, when it may be said. */
function boardIn(input: unknown, doc: Doc): string | null {
  for (const id of ids(input)) {
    const board = findArtboard(doc, id)?.artboard ?? locate(doc, id)?.artboard;
    if (board) return shown(board.name, NAME);
  }
  return null;
}

/** Every string under a key that names a node, artboard or page, however deep. */
function* ids(value: unknown, key = ""): Generator<string> {
  if (typeof value === "string") {
    if (/^(id|ids|target|parent|on|within)$/.test(key)) yield value;
  } else if (Array.isArray(value)) {
    for (const item of value) yield* ids(item, key);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) yield* ids(v, k);
  }
}

/* ------------------------------------------------------------------ */
/* Claude Code's own tools                                             */
/* ------------------------------------------------------------------ */

function codeStep(name: string, input: Record<string, unknown>, ctx: Partial<StepContext>): Step {
  const path = (key: string) =>
    typeof input[key] === "string" ? shortPath(input[key] as string, ctx.cwd) : null;
  switch (name) {
    case "Read":
    case "NotebookRead": {
      const p = path("file_path") ?? path("notebook_path");
      return p ? step(`Reading ${p}`, `Read ${p}`) : step("Reading a file", "Read a file");
    }
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit": {
      const p = path("file_path") ?? path("notebook_path");
      return p
        ? step(`Editing ${p}`, `Edited ${p}`, 2, { file: p })
        : step("Editing a file", "Edited a file", 2);
    }
    case "Write": {
      const p = path("file_path");
      return p
        ? step(`Writing ${p}`, `Wrote ${p}`, 2, { file: p })
        : step("Writing a file", "Wrote a file", 2);
    }
    case "Glob":
    case "LS":
      return step("Looking through the repo", "Looked through the repo");
    case "Grep": {
      const pattern = shown(input.pattern, 30, true);
      return pattern
        ? step(`Searching the repo for "${pattern}"`, `Searched the repo for "${pattern}"`)
        : step("Searching the repo", "Searched the repo");
    }
    case "Bash":
      return commandStep(typeof input.command === "string" ? input.command : "");
    case "BashOutput":
      return step("Checking on a command", null, 1);
    case "KillShell":
    case "KillBash":
      return step("Stopping a command", "Stopped a command", 1);
    case "WebFetch":
      return fetchStep(input.url);
    case "WebSearch": {
      const query = shown(input.query, 40, true);
      return query
        ? step(`Searching the web for "${query}"`, `Searched the web for "${query}"`)
        : step("Searching the web", "Searched the web");
    }
    case "TodoWrite": {
      // The plan's step in progress, in the agent's own words, is what it is about now.
      const todos = Array.isArray(input.todos) ? input.todos : [];
      const now = todos.find(
        (t): t is { activeForm?: unknown; content?: unknown } =>
          !!t && typeof t === "object" && (t as { status?: unknown }).status === "in_progress",
      );
      const intent = now ? shown(now.activeForm ?? now.content, 60) : null;
      return step(
        "Planning the work",
        "Planned the work",
        0,
        intent ? { intent: sentence(intent) } : {},
      );
    }
    case "Task":
    case "Agent": {
      const kind = typeof input.subagent_type === "string" ? input.subagent_type : "";
      if (/^explore$/i.test(kind)) return step("Exploring the repo", "Explored the repo");
      if (/^plan$/i.test(kind)) return step("Planning the work", "Planned the work");
      const what = shown(input.description, 40);
      return what
        ? step(`Handing off "${what}"`, `Handed off "${what}"`, 1)
        : step("Handing off a task", "Handed off a task", 1);
    }
    case "Skill": {
      const skill = typeof input.skill === "string" && /^[\w:-]{1,30}$/.test(input.skill);
      return skill
        ? step(`Using the ${input.skill} skill`, `Used the ${input.skill} skill`, 1)
        : step("Using a skill", "Used a skill", 1);
    }
    case "AskUserQuestion":
    case "ExitPlanMode":
      // The question is in the thread itself.
      return step("Asking you", null);
    case "ToolSearch":
    case "ListMcpResourcesTool":
    case "ReadMcpResourceTool":
      return step(null, null);
    default:
      return step("Working", "Worked", 1);
  }
}

/** A tool on one of the repo's own MCP servers, by its server's name. */
function serverStep(name: string): Step {
  const server = name.slice("mcp__".length).split("__")[0] ?? "";
  const pretty = /^[a-zA-Z][\w-]{0,24}$/.test(server)
    ? titled(server.replace(/[-_]+/g, " "))
    : null;
  return pretty
    ? step(`Using ${pretty}`, `Used ${pretty}`, 1)
    : step("Using a tool", "Used a tool", 1);
}

/** Docs the agent often reads, by host: "Looking up the Tailwind docs". */
const DOCS: Record<string, string> = {
  "tailwindcss.com": "the Tailwind docs",
  "react.dev": "the React docs",
  "nextjs.org": "the Next.js docs",
  "developer.mozilla.org": "MDN",
  "ui.shadcn.com": "the shadcn/ui docs",
  "vitejs.dev": "the Vite docs",
  "vite.dev": "the Vite docs",
  "docs.expo.dev": "the Expo docs",
  "reactnative.dev": "the React Native docs",
  "svelte.dev": "the Svelte docs",
  "vuejs.org": "the Vue docs",
  "www.radix-ui.com": "the Radix docs",
  "radix-ui.com": "the Radix docs",
  "motion.dev": "the Motion docs",
  "fonts.google.com": "Google Fonts",
  "github.com": "GitHub",
  "www.npmjs.com": "npm",
  "npmjs.com": "npm",
};

function fetchStep(url: unknown): Step {
  let host: string | null = null;
  try {
    host = typeof url === "string" ? new URL(url).hostname.toLowerCase() : null;
  } catch {
    host = null;
  }
  if (!host || !/^[a-z0-9.-]{1,60}$/.test(host))
    return step("Reading a web page", "Read a web page");
  const docs = DOCS[host] ?? DOCS[host.replace(/^www\./, "")];
  if (docs) return step(`Looking up ${docs}`, `Looked up ${docs}`);
  const site = host.replace(/^www\./, "");
  return step(`Reading ${site}`, `Read ${site}`);
}

/* ------------------------------------------------------------------ */
/* Shell commands                                                      */
/* ------------------------------------------------------------------ */

const PMS = new Set([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "deno",
  "pip",
  "pip3",
  "uv",
  "poetry",
  "cargo",
  "go",
  "gem",
  "bundle",
  "composer",
]);
const RUNNERS = new Set(["npx", "bunx", "pnpx"]);

/**
 * What a shell command is for, by its shape: git, package managers, tests, dev servers,
 * builds. Only a commit's own message is ever quoted, and only when it is plainly words;
 * anything else is "Running a command", never the command line.
 */
export function commandStep(command: string): Step {
  const words = commandWords(command);
  // The part that says most: the first that is not just moving around or setting up.
  let best: Step | null = null;
  for (const argv of words) {
    const said = commandOf(argv, command);
    if (!said) continue;
    if (!best || said.weight > best.weight || (best.done === null && said.done !== null))
      best = said;
    if (said.weight >= 3) break;
  }
  return best ?? step("Running a command", "Ran a command", 1);
}

/** Each simple command's words, with `cd`, `sudo`, variables and wrappers taken off. */
function commandWords(command: string): string[][] {
  return command
    .split(/&&|\|\||[;|&\n]/)
    .map((part) => part.trim().split(/\s+/).filter(Boolean))
    .map((argv) => {
      let i = 0;
      while (i < argv.length) {
        const w = argv[i]!;
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) i++;
        else if (["sudo", "exec", "time", "nohup", "env", "command"].includes(w)) i++;
        else if (w === "timeout" && argv[i + 1]) i += 2;
        else break;
      }
      return argv.slice(i).map((w) => w.replace(/^["'(]+|["')]+$/g, ""));
    })
    .filter(
      (argv) => argv.length > 0 && argv[0] !== "cd" && argv[0] !== "echo" && argv[0] !== "true",
    );
}

function commandOf(argv: string[], full: string): Step | null {
  const [cmd = "", ...rest] = argv;
  const bin = basename(cmd);
  if (bin === "git") return gitStep(rest, full);
  // `npx vitest`, `bunx playwright test`: what it runs.
  if (RUNNERS.has(bin)) return rest[0] ? toolStep(positional(rest)) : null;
  if (bin === "bun" && rest[0] === "x") return toolStep(positional(rest.slice(1)));
  if (bin === "gh") return ghStep(rest);
  if (PMS.has(bin)) return packageStep(bin, rest);
  if (bin === "make" || bin === "just")
    return scriptStep(rest[0] ?? "") ?? step("Running a task", "Ran a task", 1);
  return toolStep(argv);
}

/** A package manager's flags that take the word after them: `pnpm --filter web dev`. */
const VALUED = new Set([
  "--filter",
  "-F",
  "-w",
  "--workspace",
  "-C",
  "--cwd",
  "--dir",
  "--prefix",
  "-p",
  "--package",
  "--manifest-path",
]);

/** The words that aren't flags, nor the values of flags that take one. */
function positional(words: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (VALUED.has(w)) i++;
    else if (!w.startsWith("-")) out.push(w);
  }
  return out;
}

function packageStep(pm: string, rest: string[]): Step {
  const args = positional(rest);
  const [sub = "", next = ""] = args;
  if (
    ["i", "install", "add", "ci", "sync", "get", "fetch"].includes(sub) ||
    (pm === "bundle" && !sub) ||
    (pm === "yarn" && !sub)
  )
    return step("Installing packages", "Installed packages", 1);
  if (["remove", "rm", "uninstall"].includes(sub))
    return step("Removing a package", "Removed a package", 1);
  if (sub === "test" || (pm === "go" && sub === "test"))
    return step("Running tests", "Ran tests", 1);
  if (sub === "build" && (pm === "cargo" || pm === "go"))
    return step("Building the app", "Built the app", 1);
  if (sub === "run" || sub === "exec" || sub === "x" || sub === "dlx")
    return (
      scriptStep(next) ?? toolStep(args.slice(1)) ?? step("Running a script", "Ran a script", 1)
    );
  // `bun dev`, `yarn build`: the script's own name.
  return (
    scriptStep(sub) ??
    (pm === "bun" && /\.(m?[jt]sx?)$/.test(sub)
      ? step("Running a script", "Ran a script", 1)
      : step("Running a command", "Ran a command", 1))
  );
}

/** A package script by its name: "dev", "test:unit", "build", "lint". */
function scriptStep(name: string): Step | null {
  const n = name.toLowerCase();
  if (/^(dev|start|serve|preview|watch)(\b|:|$)/.test(n))
    return step("Running the dev server", "Ran the dev server", 1);
  if (/^(test|e2e|spec)(\b|:|$)/.test(n) || /:test$/.test(n))
    return step("Running tests", "Ran tests", 1);
  if (/^(build|compile|bundle)(\b|:|$)/.test(n))
    return step("Building the app", "Built the app", 1);
  if (/^(typecheck|type-check|tsc|check-types|types)(\b|:|$)/.test(n))
    return step("Checking types", "Checked types", 1);
  if (/^(lint|check)(\b|:|$)/.test(n)) return step("Checking the code", "Checked the code", 1);
  if (/^(format|fmt|prettier)(\b|:|$)/.test(n))
    return step("Formatting the code", "Formatted the code", 1);
  if (/^(storybook)(\b|:|$)/.test(n)) return step("Running Storybook", "Ran Storybook", 1);
  if (/^(db|migrate|prisma|drizzle)(\b|:|$)/.test(n))
    return step("Updating the database", "Updated the database", 1);
  return null;
}

/** GitHub's CLI, by what it does. */
function ghStep(rest: string[]): Step {
  const [what = "", verb = ""] = positional(rest);
  if (what === "pr" && verb === "create")
    return step("Opening the pull request", "Opened the pull request", 2);
  if (what === "pr" && verb === "merge")
    return step("Merging the pull request", "Merged the pull request", 2);
  if (what === "pr" && ["view", "diff", "checks", "list", "status"].includes(verb))
    return step("Checking the pull request", "Checked the pull request");
  if (what === "pr" && verb === "edit")
    return step("Updating the pull request", "Updated the pull request", 1);
  if (what === "run" || what === "workflow") return step("Checking CI", "Checked CI");
  if (what === "issue") return step("Reading issues", "Read issues");
  return step("Using GitHub", "Used GitHub", 1);
}

/** A command by the program it runs. */
function toolStep(argv: string[]): Step | null {
  const [cmd = "", ...rest] = argv;
  const bin = basename(cmd)
    .toLowerCase()
    .replace(/(?<=.)@[^/]*$/, "");
  // `npx shadcn@latest add button`, `bunx create-next-app`.
  if (bin === "shadcn" || bin === "shadcn-ui") {
    const sub = positional(rest)[0];
    return sub === "init"
      ? step("Setting up shadcn/ui", "Set up shadcn/ui", 1)
      : step("Adding a component", "Added a component", 1);
  }
  if (/^create-[a-z0-9-]+$/.test(bin)) return step("Setting up a new app", "Set up a new app", 1);
  // `python -m http.server`, `python -m pytest`.
  if (/^python3?$/.test(bin) && rest[0] === "-m") {
    const mod = rest[1] ?? "";
    if (mod === "http.server") return step("Running the dev server", "Ran the dev server", 1);
    if (mod === "pytest" || mod === "unittest") return step("Running tests", "Ran tests", 1);
    if (mod === "pip") return step("Installing packages", "Installed packages", 1);
  }
  if (
    ["vitest", "jest", "pytest", "mocha", "ava", "rspec"].includes(bin) ||
    (bin === "playwright" && rest[0] === "test")
  )
    return step("Running tests", "Ran tests", 1);
  if (
    [
      "next",
      "vite",
      "astro",
      "nuxt",
      "remix",
      "expo",
      "webpack-dev-server",
      "http-server",
      "serve",
    ].includes(bin)
  ) {
    const sub = rest.find((w) => !w.startsWith("-")) ?? "";
    if (sub === "build") return step("Building the app", "Built the app", 1);
    if (sub === "lint") return step("Checking the code", "Checked the code", 1);
    return step("Running the dev server", "Ran the dev server", 1);
  }
  if (bin === "tsc" || bin === "vue-tsc") return step("Checking types", "Checked types", 1);
  if (["eslint", "biome", "stylelint", "oxlint", "ruff"].includes(bin))
    return step("Checking the code", "Checked the code", 1);
  if (bin === "prettier" || bin === "black")
    return step("Formatting the code", "Formatted the code", 1);
  if (["tsup", "esbuild", "rollup", "turbo"].includes(bin))
    return step("Building the app", "Built the app", 1);
  if (
    [
      "ls",
      "cat",
      "head",
      "tail",
      "find",
      "tree",
      "wc",
      "grep",
      "rg",
      "fd",
      "sed",
      "awk",
      "less",
      "file",
      "stat",
      "du",
      "pwd",
      "which",
      "lsof",
    ].includes(bin)
  )
    return step("Looking through the repo", "Looked through the repo");
  if (["mkdir", "cp", "mv", "touch", "ln"].includes(bin))
    return step("Arranging files", "Arranged files", 1);
  if (bin === "rm") return step("Removing files", "Removed files", 1);
  if (["curl", "wget", "http"].includes(bin)) return step("Fetching a page", "Fetched a page", 1);
  if (["kill", "pkill", "killall", "fuser"].includes(bin))
    return step("Stopping a process", "Stopped a process", 1);
  if (bin === "sleep") return step("Waiting", "Waited");
  if (["node", "python", "python3", "tsx", "ts-node"].includes(bin))
    return step("Running a script", "Ran a script", 1);
  if (bin === "prisma" || bin === "drizzle-kit")
    return step("Updating the database", "Updated the database", 1);
  if (["convert", "magick", "ffmpeg", "sips", "cwebp", "svgo"].includes(bin))
    return step("Processing images", "Processed images", 1);
  return null;
}

function gitStep(rest: string[], full: string): Step {
  // Options before the subcommand (`git -C dir status`).
  let i = 0;
  while (i < rest.length && rest[i]!.startsWith("-"))
    i += rest[i] === "-C" || rest[i] === "-c" ? 2 : 1;
  const sub = rest[i] ?? "";
  switch (sub) {
    case "commit": {
      const message = commitMessage(full);
      return message
        ? step(`Committing "${message}"`, `Committed "${message}"`, 3)
        : step("Committing the work", "Committed the work", 3);
    }
    case "push":
      return step("Pushing the branch", "Pushed the branch", 1);
    case "pull":
    case "fetch":
      return step("Fetching the latest", "Fetched the latest", 1);
    case "add":
      return step("Staging changes", "Staged changes", 1);
    case "status":
    case "diff":
      return step("Looking at the changes", "Looked at the changes");
    case "log":
    case "show":
    case "blame":
      return step("Reading the history", "Read the history");
    case "checkout":
    case "switch":
    case "branch":
      return step("Switching branches", "Switched branches", 1);
    case "merge":
    case "rebase":
      return step("Bringing in changes", "Brought in changes", 1);
    case "stash":
      return step("Setting changes aside", "Set changes aside", 1);
    case "restore":
    case "reset":
      return step("Undoing changes", "Undid changes", 1);
    default:
      return step("Running git", "Ran git", 1);
  }
}

/**
 * A commit's message, when it is plain words: its first line. From `-m "…"`, `-am '…'` or
 * `--message=…`, or the heredoc Claude Code commits with (`-m "$(cat <<'EOF' … EOF)"`).
 */
function commitMessage(command: string): string | null {
  const flag = /(?:^|\s)(?:-[a-zA-Z]*m|--message)(?:=|\s+)/.exec(command);
  if (!flag) return null;
  const rest = command.slice(flag.index + flag[0].length);
  let text: string | undefined;
  const heredoc = /^"?\$\(\s*cat\s+<<-?\s*['"]?(\w+)['"]?[^\n]*\n([\s\S]*)/.exec(rest);
  if (heredoc) {
    const [, end, body = ""] = heredoc;
    const lines = body.split("\n");
    const stop = lines.findIndex((l) => l.trim() === end);
    text = (stop < 0 ? lines : lines.slice(0, stop)).find((l) => l.trim())?.trim();
  } else {
    const quoted = /^(?:"([^"]*)"|'([^']*)')/.exec(rest);
    text = quoted?.[1] ?? quoted?.[2];
  }
  if (!text) return null;
  const first = text.split(/\\n|\n/)[0]!.trim();
  return /^[\p{L}\p{N}][\p{L}\p{N} ,.:'’()&/#+-]*$/u.test(first) ? shown(first, 50) : null;
}

/* ------------------------------------------------------------------ */
/* What may be said                                                    */
/* ------------------------------------------------------------------ */

const TOKENS = [
  /\b(sk|pk|rk)[-_](live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{8,}/,
  /\bgh[pousr]_[A-Za-z0-9]{8,}/,
  /\bgithub_pat_/,
  /\bxox[abprs]-/,
  /\bAKIA[0-9A-Z]{8,}/,
  /\beyJ[A-Za-z0-9_-]{8,}/,
  /-----BEGIN/,
  /\b(npm|pypi|glpat|shpat|dop_v1|hf)_[A-Za-z0-9]{8,}/,
];

/**
 * Whether text reads as a secret: a known token's shape, a long unbroken run of letters and
 * digits (a key, a hash), a `NAME=value` assignment, credentials in an address, or the words
 * password, token or secret with a value beside them.
 */
export function looksSecret(text: string): boolean {
  if (TOKENS.some((re) => re.test(text))) return true;
  if (/[A-Za-z0-9+_=-]{28,}/.test(text) && /\d/.test(text) && /[A-Za-z]/.test(text)) return true;
  if (/\b[A-Za-z_][A-Za-z0-9_]*=\S/.test(text)) return true;
  if (/:\/\/[^\s/@]+@/.test(text)) return true;
  if (/\b(pass(word)?|passwd|token|secret|api[-_]?key|bearer|auth)\b\s*[:=]?\s*\S{6,}/i.test(text))
    return true;
  return false;
}

/**
 * `value` as it may be said in a phrase: a string, on one line, not too long and not secret.
 * `term` asks for a search term: a few plain words or an identifier, nothing like a pattern.
 */
export function shown(value: unknown, max: number, term = false): string | null {
  if (typeof value !== "string") return null;
  const t = value.replace(/\s+/g, " ").trim();
  if (!t || looksSecret(t)) return null;
  if (term && (t.length > max || !/^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u.test(t))) return null;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/**
 * A file's path, short: relative to the checkout, and cut from the left at whole folders, so the
 * file's own name is always there ("…/components/Hero.tsx").
 */
export function shortPath(path: string, cwd?: string): string | null {
  let p = path.trim();
  if (!p || /[\n\0]/.test(p)) return null;
  if (cwd && isAbsolute(p)) {
    const rel = relative(cwd, p);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) p = rel;
  }
  let parts = p.split("/").filter((part) => part && part !== ".");
  const file = parts.pop();
  if (!file || file === "..") return null;
  // Outside the checkout (a home folder, a temporary one): only the file and its folder, so
  // where the machine keeps things is never said.
  const outside = isAbsolute(p) || parts.includes("..") || p.startsWith("~");
  if (outside) parts = parts.slice(-1).filter((part) => part !== ".." && part !== "~");
  let out = file;
  let cut = outside;
  for (let i = parts.length - 1; i >= 0; i--) {
    const next = `${parts[i]}/${out}`;
    if (next.length > PATH) {
      cut = true;
      break;
    }
    out = next;
  }
  const said = cut ? `…/${out}` : out;
  // Only what is said is judged: the folders cut away never show.
  return looksSecret(said) ? null : said;
}

function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function titled(text: string): string {
  return text.replace(/\b\w/g, (c) => c.toUpperCase());
}
