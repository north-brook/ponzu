import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { findApp, ponzuHome, writeShim } from "./host.ts";

/** How an agent reaches Ponzu: a command it launches, or a URL. */
type Entry = { command: string; args: string[] } | { url: string };

interface Agent {
  id: string;
  label: string;
  /** The agent's CLI, or a folder that shows it's installed. */
  detect(): boolean;
  current(): Entry | null;
  register(entry: Entry): boolean | Promise<boolean>;
}

const AGENTS: Agent[] = [
  {
    id: "claude",
    label: "Claude Code",
    detect: () => Boolean(which("claude")),
    current: () => {
      const config = readJson(join(homedir(), ".claude.json")) as {
        mcpServers?: Record<string, { command?: string; args?: string[]; url?: string }>;
      } | null;
      return toEntry(config?.mcpServers?.ponzu);
    },
    register(entry) {
      run(["claude", "mcp", "remove", "--scope", "user", "ponzu"], true);
      return "url" in entry
        ? run([
            "claude",
            "mcp",
            "add",
            "--transport",
            "http",
            "--scope",
            "user",
            "ponzu",
            entry.url,
          ])
        : run([
            "claude",
            "mcp",
            "add",
            "--scope",
            "user",
            "ponzu",
            "--",
            entry.command,
            ...entry.args,
          ]);
    },
  },
  {
    id: "codex",
    label: "Codex",
    detect: () => Boolean(which("codex")),
    current: () => {
      const out = capture(["codex", "mcp", "get", "ponzu", "--json"]);
      if (!out) return null;
      try {
        return toEntry((JSON.parse(out) as { transport?: Record<string, never> }).transport);
      } catch {
        return null;
      }
    },
    register(entry) {
      run(["codex", "mcp", "remove", "ponzu"], true);
      return "url" in entry
        ? run(["codex", "mcp", "add", "ponzu", "--url", entry.url])
        : run(["codex", "mcp", "add", "ponzu", "--", entry.command, ...entry.args]);
    },
  },
  {
    id: "cursor",
    label: "Cursor",
    detect: () => existsSync(join(homedir(), ".cursor")),
    current: () => {
      const config = readJson(cursorConfig()) as { mcpServers?: Record<string, never> } | null;
      return toEntry(config?.mcpServers?.ponzu);
    },
    async register(entry) {
      const path = cursorConfig();
      let config: { mcpServers?: Record<string, unknown> } = {};
      if (existsSync(path)) {
        const parsed = readJson(path);
        if (!parsed) {
          console.error(
            `${path} isn't valid JSON; add Ponzu to it yourself:\n  "ponzu": ${JSON.stringify(entry)}`,
          );
          return false;
        }
        config = parsed as typeof config;
      }
      config.mcpServers = { ...config.mcpServers, ponzu: entry };
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
      return true;
    },
  },
];

const ALIASES: Record<string, string> = { "claude-code": "claude" };

/**
 * Register Ponzu's MCP server with agents. Uses an agent's own CLI when it
 * has one, so we never hand-edit its config format.
 *
 * Agents get a command, not a URL: it runs inside the installed Ponzu.app
 * (and updates with it), joins the app when it's open, starts it in the
 * background when it isn't, and works on its own without the app at all.
 * Pass --url to register a URL instead, e.g. a Ponzu on another machine.
 *
 * `auto` is the desktop app's launch check: it quietly sets up agents it
 * hasn't set up before and moves old URL registrations to the command.
 */
export async function installAgent(
  agent: string | undefined,
  opts: { url?: string; auto?: boolean },
) {
  const id = agent ? (ALIASES[agent] ?? agent) : undefined;
  if (id && !AGENTS.some((a) => a.id === id)) {
    console.log(`Add Ponzu to an agent:

  ponzu install            Every agent found on this Mac
  ponzu install claude     Claude Code
  ponzu install codex      Codex
  ponzu install cursor     Cursor

Or launch \`ponzu mcp\` over stdio from any MCP client.`);
    process.exit(1);
  }
  const entry = opts.url ? { url: opts.url } : await launchEntry();
  if (!entry) {
    if (!opts.auto) console.error("Move Ponzu to your Applications folder, then try again.");
    return;
  }
  const done = readDone();
  const targets = AGENTS.filter((a) => (id ? a.id === id : a.detect()));
  if (!targets.length && !opts.auto)
    console.log("No agents found. Install Claude Code, Codex or Cursor, then run ponzu install.");
  let failed = false;
  for (const a of targets) {
    if (!a.detect()) {
      console.error(`${a.label} isn't installed, or its CLI isn't on your PATH.`);
      failed = true;
      continue;
    }
    const current = a.current();
    if (same(current, entry)) {
      done.add(a.id);
      if (!opts.auto) console.log(`${a.label} already has Ponzu.`);
      continue;
    }
    if (opts.auto && !shouldAutoRegister(current, done.has(a.id))) continue;
    if (await a.register(entry)) {
      done.add(a.id);
      console.log(`Ponzu added to ${a.label}.`);
    } else failed = true;
  }
  await writeDone(done);
  if (failed && !opts.auto) process.exit(1);
}

/**
 * The agents Ponzu knows on this Mac, for the home screen's first steps:
 * whether each is installed and whether Ponzu is registered with it. Asking an
 * agent's CLI is slow, so this reads their config files instead.
 */
export function agentStatus(): { id: string; label: string; found: boolean; connected: boolean }[] {
  const done = readDone();
  return AGENTS.map((a) => {
    const found = a.id === "codex" ? Boolean(which("codex")) : a.detect();
    const connected =
      a.id === "codex" ? codexConfigured() : Boolean(a.current()) || (found && done.has(a.id));
    return { id: a.id, label: a.label, found, connected: found && connected };
  });
}

/** Codex keeps its servers in ~/.codex/config.toml. */
function codexConfigured(): boolean {
  try {
    return /^\[mcp_servers\.ponzu\]/m.test(
      readFileSync(
        join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml"),
        "utf8",
      ),
    );
  } catch {
    return false;
  }
}

/**
 * The command agents launch. With the desktop app installed, that's a shim
 * into the app, so it updates with it. Null when this binary runs from a
 * place that goes away (the disk image) and no installed app exists.
 */
async function launchEntry(): Promise<Entry | null> {
  const app = findApp();
  if (app?.endsWith(".app")) return { command: await writeShim(app), args: ["mcp"] };
  if (/\.app\/Contents\//.test(process.execPath)) return null;
  // A compiled binary runs as itself, a checkout through bun. bunx unpacks into a temp folder.
  if (Bun.main.startsWith("/$bunfs/")) return { command: process.execPath, args: ["mcp"] };
  if (/\/bunx-[^/]+\//.test(Bun.main))
    return { command: process.execPath, args: ["x", "ponzu", "mcp"] };
  return { command: process.execPath, args: [Bun.main, "mcp"] };
}

function toEntry(raw?: { command?: string; args?: string[]; url?: string } | null): Entry | null {
  if (raw?.command) return { command: raw.command, args: raw.args ?? [] };
  if (raw?.url) return { url: raw.url };
  return null;
}

function same(a: Entry | null, b: Entry): boolean {
  if (!a) return false;
  if ("url" in a || "url" in b) return "url" in a && "url" in b && a.url === b.url;
  return a.command === b.command && a.args.join(" ") === b.args.join(" ");
}

/**
 * The launch check only touches an agent it has never set up, or one still on
 * the old fixed URL. Anything else is the person's choice: a URL to another
 * machine, a checkout, or no Ponzu at all after they removed it.
 */
function shouldAutoRegister(current: Entry | null, setUpBefore: boolean): boolean {
  if (current) return isLegacy(current);
  return !setUpBefore;
}

/** What `ponzu install` registered before agents launched Ponzu themselves. */
function isLegacy(e: Entry): boolean {
  return "url" in e && /^http:\/\/(127\.0\.0\.1|localhost):7777\/mcp\/?$/.test(e.url);
}

const doneFile = () => join(ponzuHome(), "agents.json");

function readDone(): Set<string> {
  const raw = readJson(doneFile()) as { configured?: string[] } | null;
  return new Set(raw?.configured ?? []);
}

async function writeDone(done: Set<string>) {
  await mkdir(dirname(doneFile()), { recursive: true });
  await writeFile(doneFile(), `${JSON.stringify({ configured: [...done].sort() }, null, 2)}\n`);
}

function cursorConfig() {
  return join(homedir(), ".cursor", "mcp.json");
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Apps opened from Finder get a bare PATH, so also look where agent CLIs
 * usually install and on the login shell's PATH.
 */
let searchPath: string | undefined;
function agentPath(): string {
  if (searchPath !== undefined) return searchPath;
  const home = homedir();
  const dirs = [
    ...(process.env.PATH ?? "").split(delimiter),
    join(home, ".local/bin"),
    join(home, ".claude/local"),
    join(home, ".bun/bin"),
    join(home, ".npm-global/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  const shell = process.env.SHELL;
  if (shell) {
    const login = spawnSync(shell, ["-ilc", 'printf %s "$PATH"'], {
      encoding: "utf8",
      timeout: 3000,
    });
    // Interactive shells can print a greeting first; the PATH is the last line.
    if (login.status === 0)
      dirs.push(...(login.stdout.trim().split("\n").pop() ?? "").split(delimiter));
  }
  searchPath = [...new Set(dirs.filter(Boolean))].join(delimiter);
  return searchPath;
}

function which(cmd: string): string | null {
  return Bun.which(cmd, { PATH: agentPath() });
}

function capture(cmd: string[]): string | null {
  const bin = which(cmd[0]!);
  if (!bin) return null;
  const out = spawnSync(bin, cmd.slice(1), {
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, PATH: agentPath() },
  });
  return out.status === 0 ? out.stdout : null;
}

function run(cmd: string[], quiet = false): boolean {
  const bin = which(cmd[0]!);
  if (!bin) return false;
  const out = spawnSync(bin, cmd.slice(1), {
    stdio: quiet ? "ignore" : "inherit",
    timeout: 30_000,
    env: { ...process.env, PATH: agentPath() },
  });
  return out.status === 0;
}
