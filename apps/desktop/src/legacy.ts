import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

/*
 * What Ponzu 1.x left on the computer, removed once by the first cloud launch (docs/cloud.md,
 * "Clients"). 1.x ran a local server from inside the app and wired the computer to it: a wake
 * helper the iPhone knocked on, a `ponzu` command, and an MCP server named `ponzu` in Claude
 * Code, Codex and Cursor. The update took the server away, so each of those now starts nothing.
 *
 * Each is removed only when it is provably 1.x's and provably dead: written in the exact form
 * 1.x wrote (apps/cli/src/install.ts, command.ts, host.ts and wake.ts), and pointing at a server
 * binary that no longer exists. Anything else is the person's and stays, and so does everything
 * when a 1.x Ponzu is still installed somewhere the command can find. Nothing outside these
 * entries is touched: no design, no folder of the person's, nothing else in ~/.ponzu.
 */

export interface LegacyHost {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  /** The user's id, for launchd's `gui/<uid>` domain. */
  uid: number;
  /** Whether a program is there: a server binary, an agent's CLI. */
  exists(path: string): boolean;
  /** Runs a program and says how it exited: `runProgram`. */
  run(
    command: string,
    args: string[],
    path: string,
  ): Promise<{ status: number | null; stdout: string }>;
}

export type Outcome = "removed" | "kept" | "failed";

export interface Step {
  what: string;
  outcome: Outcome;
  why?: string;
}

const WAKE_LABEL = "design.ponzu.app.wake";
/** Where 1.x's server sat inside an installed app. */
const MAC_SERVER = "Contents/Resources/server/ponzu";
const BUNDLED_SERVER = /[\\/]resources[\\/]server[\\/]ponzu(\.exe)?$/i;
const SHIM_MARK = /^(#!\/bin\/sh\n# |@echo off\r?\nrem )Written by Ponzu\./;

export async function removeLegacy(host: LegacyHost): Promise<Step[]> {
  const steps: Step[] = [];
  const ponzuHome = host.env.PONZU_HOME || join(host.home, ".ponzu");
  const shim = join(ponzuHome, host.platform === "win32" ? "bin/ponzu.cmd" : "bin/ponzu");
  const shimText = readText(shim);
  const servers = shimText === null ? null : shimServers(shimText, host);

  if (shimText !== null && servers === null) {
    steps.push({ what: shim, outcome: "kept", why: "not a command Ponzu wrote" });
  }
  const alive = (servers ?? []).find((server) => host.exists(server));
  if (alive) {
    // A 1.x app is still installed beside this one: everything 1.x wired up still works.
    steps.push({ what: shim, outcome: "kept", why: `Ponzu 1.x is still installed at ${alive}` });
    return steps;
  }
  /** The shim is 1.x's and runs nothing, or is gone: what points at its path is dead too. */
  const shimDead = shimText === null || servers !== null;
  /** What 1.x registered with agents: its shim, or (Windows) the server inside the app. */
  const ours = (entry: McpEntry | null): entry is McpEntry =>
    entry !== null &&
    entry.args.length === 1 &&
    entry.args[0] === "mcp" &&
    ((shimDead && entry.command === shim) ||
      (BUNDLED_SERVER.test(entry.command) && !host.exists(entry.command)));
  const cliPath = agentPath(host);

  if (shimDead && host.platform !== "win32") steps.push(...removeLinks(shim, host.home));
  if (servers !== null) {
    steps.push(remove(shim));
    removeIfEmpty(dirname(shim));
  }

  /** One step, whose failure is its own: the rest still run. */
  const attempt = async (what: string, step: () => Step | Step[] | Promise<Step | Step[]>) => {
    try {
      steps.push(...[await step()].flat());
    } catch (error) {
      steps.push({ what, outcome: "failed", why: String(error) });
    }
  };
  await attempt("Claude Code's ponzu MCP server", () => removeClaude(host, cliPath, ours));
  await attempt("Codex's ponzu MCP server", () => removeCodex(host, cliPath, ours));
  await attempt("Cursor's ponzu MCP server", () => removeCursor(host.home, ours));
  if (host.platform === "darwin") await attempt("the wake helper", () => removeLaunchAgent(host));
  if (host.platform === "linux") await attempt("the wake helper", () => removeSystemdWake(host));
  return steps.filter((step) => step.outcome !== "kept" || step.why);
}

/**
 * `removeLegacy` the first time this computer runs a cloud Ponzu, with what it did written to
 * `record`. Null on every later launch, whatever happened the first time.
 */
export async function removeLegacyOnce(
  host: LegacyHost,
  record: string,
  version: string,
): Promise<Step[] | null> {
  if (existsSync(record)) return null;
  // A step that failed is recorded with the rest: each is tried once.
  const steps = await removeLegacy(host);
  const at = new Date().toISOString();
  writeFileSync(record, `${JSON.stringify({ version, at, steps }, null, 2)}\n`);
  return steps;
}

/** The server binaries a 1.x shim runs, in the order it tries them; null if 1.x didn't write it. */
export function shimServers(
  script: string,
  host: Pick<LegacyHost, "home" | "env">,
): string[] | null {
  if (!SHIM_MARK.test(script)) return null;
  if (script.startsWith("@echo off")) {
    return [...script.matchAll(/^\s*set "bin=(.+)"\r?$/gm)].map((m) =>
      m[1]!.replace(/%([^%]+)%/g, (whole, name: string) => host.env[name] ?? whole),
    );
  }
  const loop = /^for (app|bin) in (.+); do$/m.exec(script);
  if (!loop) return null;
  const words = [...loop[2]!.matchAll(/'((?:[^']|'\\'')*)'|"([^"]*)"|(\S+)/g)].map(
    ([, single, double, bare]) =>
      single !== undefined
        ? single.replace(/'\\''/g, "'")
        : (double ?? bare ?? "").replace(/^\$HOME/, host.home),
  );
  return loop[1] === "app" ? words.map((app) => join(app, MAC_SERVER)) : words;
}

/** The `ponzu` links 1.x made on the person's PATH, to its shim: only symlinks to exactly it. */
function removeLinks(shim: string, home: string): Step[] {
  const candidates = [
    join(home, ".local/bin/ponzu"),
    join(home, "bin/ponzu"),
    "/usr/local/bin/ponzu",
  ];
  const steps: Step[] = [];
  for (const link of candidates) {
    let target: string;
    try {
      if (!lstatSync(link).isSymbolicLink()) continue;
      target = resolve(dirname(link), readlinkSync(link));
    } catch {
      continue;
    }
    if (target === shim) steps.push(remove(link));
  }
  return steps;
}

interface McpEntry {
  command: string;
  args: string[];
}

function entryOf(raw: unknown): McpEntry | null {
  const entry = raw as { command?: unknown; args?: unknown } | null | undefined;
  if (typeof entry?.command !== "string") return null;
  const args = Array.isArray(entry.args) ? entry.args.filter((a) => typeof a === "string") : [];
  return { command: entry.command, args };
}

/** Claude Code keeps user-scoped servers in ~/.claude.json; its own CLI removes them. */
async function removeClaude(
  host: LegacyHost,
  path: string,
  ours: (entry: McpEntry | null) => entry is McpEntry,
): Promise<Step> {
  const what = "Claude Code's ponzu MCP server";
  const config = readJson(join(host.home, ".claude.json")) as {
    mcpServers?: Record<string, unknown>;
  } | null;
  if (!ours(entryOf(config?.mcpServers?.ponzu))) return { what, outcome: "kept" };
  const claude = findCommand("claude", path, host);
  if (!claude) return { what, outcome: "failed", why: "the claude command wasn't found" };
  const done = await host.run(claude, ["mcp", "remove", "--scope", "user", "ponzu"], path);
  return done.status === 0
    ? { what, outcome: "removed" }
    : { what, outcome: "failed", why: `claude mcp remove exited ${done.status}` };
}

/** Codex says what it has with `codex mcp get --json`, and removes it itself. */
async function removeCodex(
  host: LegacyHost,
  path: string,
  ours: (entry: McpEntry | null) => entry is McpEntry,
): Promise<Step> {
  const what = "Codex's ponzu MCP server";
  const codex = findCommand("codex", path, host);
  if (!codex) return { what, outcome: "kept" };
  const got = await host.run(codex, ["mcp", "get", "ponzu", "--json"], path);
  if (got.status !== 0) return { what, outcome: "kept" };
  let transport: unknown = null;
  try {
    transport = (JSON.parse(got.stdout) as { transport?: unknown }).transport;
  } catch {}
  if (!ours(entryOf(transport))) return { what, outcome: "kept" };
  const done = await host.run(codex, ["mcp", "remove", "ponzu"], path);
  return done.status === 0
    ? { what, outcome: "removed" }
    : { what, outcome: "failed", why: `codex mcp remove exited ${done.status}` };
}

/** Cursor's ~/.cursor/mcp.json, which 1.x wrote itself: the one entry goes, the rest stays as is. */
function removeCursor(home: string, ours: (entry: McpEntry | null) => entry is McpEntry): Step {
  const what = "Cursor's ponzu MCP server";
  const file = join(home, ".cursor/mcp.json");
  const config = readJson(file) as { mcpServers?: Record<string, unknown> } | null;
  if (!config?.mcpServers || !ours(entryOf(config.mcpServers.ponzu)))
    return { what, outcome: "kept" };
  // A link into the person's dotfiles is theirs: writing over it would cut the link.
  if (lstatSync(file).isSymbolicLink()) {
    return { what, outcome: "kept", why: `${file} is a link, which Ponzu leaves to its owner` };
  }
  delete config.mcpServers.ponzu;
  try {
    const mode = statSync(file).mode & 0o777;
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(config, null, indentOf(readText(file) ?? ""))}\n`);
    chmodSync(temporary, mode);
    renameSync(temporary, file);
    return { what, outcome: "removed" };
  } catch (error) {
    return { what, outcome: "failed", why: String(error) };
  }
}

/** A JSON file's indent, to write it back as it was: two spaces unless it says otherwise. */
function indentOf(text: string): string | number {
  return /^\{\r?\n([ \t]+)"/.exec(text)?.[1] ?? 2;
}

/** The LaunchAgent the iPhone woke Ponzu through, when the server it starts is gone. */
async function removeLaunchAgent(host: LegacyHost): Promise<Step> {
  const plist = join(host.home, "Library/LaunchAgents", `${WAKE_LABEL}.plist`);
  const text = readText(plist);
  if (text === null) return { what: plist, outcome: "kept" };
  const label = /<key>Label<\/key>\s*<string>([^<]*)<\/string>/.exec(text)?.[1];
  const program =
    /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>\s*<string>wake<\/string>/
      .exec(text)?.[1]
      ?.replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  if (label !== WAKE_LABEL || !program?.endsWith(`/${MAC_SERVER}`)) {
    return { what: plist, outcome: "kept", why: "not the wake helper Ponzu wrote" };
  }
  if (host.exists(program))
    return { what: plist, outcome: "kept", why: `${program} still runs it` };
  await host.run("/bin/launchctl", ["bootout", `gui/${host.uid}/${WAKE_LABEL}`], "");
  return remove(plist);
}

/** Linux's systemd user socket for the same, and the service it starts. */
async function removeSystemdWake(host: LegacyHost): Promise<Step[]> {
  const units = join(host.env.XDG_CONFIG_HOME || join(host.home, ".config"), "systemd/user");
  const service = join(units, "ponzu-wake@.service");
  const text = readText(service);
  if (text === null) return [];
  const program = /^ExecStart="((?:[^"\\]|\\.)*)" wake$/m.exec(text)?.[1]?.replace(/\\(.)/g, "$1");
  if (!text.includes("Description=Ponzu wake helper") || !program) {
    return [{ what: service, outcome: "kept", why: "not the wake helper Ponzu wrote" }];
  }
  if (host.exists(program))
    return [{ what: service, outcome: "kept", why: `${program} still runs it` }];
  await host.run(
    "systemctl",
    ["--user", "disable", "--now", "ponzu-wake.socket"],
    host.env.PATH ?? "",
  );
  const steps = [
    remove(join(units, "sockets.target.wants/ponzu-wake.socket")),
    remove(join(units, "ponzu-wake.socket")),
    remove(service),
  ];
  await host.run("systemctl", ["--user", "daemon-reload"], host.env.PATH ?? "");
  return steps.filter((step) => step.outcome !== "kept");
}

function remove(path: string): Step {
  try {
    lstatSync(path);
  } catch {
    return { what: path, outcome: "kept" };
  }
  try {
    rmSync(path, { force: true });
    return { what: path, outcome: "removed" };
  } catch (error) {
    // /usr/local/bin needs an admin's password, which a launch never asks for.
    return {
      what: path,
      outcome: "failed",
      why: (error as NodeJS.ErrnoException).code ?? String(error),
    };
  }
}

/** The shim's folder, once the shim has gone and if nothing else is in it. */
function removeIfEmpty(dir: string): void {
  try {
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {}
}

/** Where agents' CLIs install, beyond the bare PATH an app opened from the Finder gets. */
function agentPath(host: LegacyHost): string {
  const dirs = [
    ...(host.env.PATH ?? "").split(delimiter),
    join(host.home, ".local/bin"),
    join(host.home, ".claude/local"),
    join(host.home, ".bun/bin"),
    join(host.home, ".npm-global/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  return [...new Set(dirs.filter(Boolean))].join(delimiter);
}

function findCommand(name: string, path: string, host: LegacyHost): string | null {
  const names = host.platform === "win32" ? [`${name}.cmd`, `${name}.exe`] : [name];
  for (const dir of path.split(delimiter)) {
    for (const file of names) {
      const candidate = join(dir, file);
      if (host.exists(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Runs a program without a shell and says how it exited. On Windows an npm-installed agent is a
 * `.cmd`, which Node won't start without one, so cmd.exe runs it, given only the quoted path and
 * this module's fixed arguments, so nothing in them is read as a command.
 */
export function runProgram(
  command: string,
  args: string[],
  path: string,
): Promise<{ status: number | null; stdout: string }> {
  const { file, argv, verbatim } = invocation(command, args, process.platform, process.env.ComSpec);
  return new Promise((done) =>
    execFile(
      file,
      argv,
      {
        timeout: 15_000,
        windowsHide: true,
        windowsVerbatimArguments: verbatim,
        env: { ...process.env, PATH: path },
      },
      (error, stdout) => done({ status: error ? ((error.code as number) ?? 1) : 0, stdout }),
    ),
  );
}

/** What to start for `command args`: itself, or a Windows `.cmd` through cmd.exe. */
export function invocation(
  command: string,
  args: string[],
  platform: NodeJS.Platform,
  comSpec = "cmd.exe",
): { file: string; argv: string[]; verbatim: boolean } {
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(command)) {
    return { file: command, argv: args, verbatim: false };
  }
  if (/["%]/.test(command) || !args.every((arg) => /^[\w.-]+$/.test(arg))) {
    throw new Error(`cmd.exe would read more than a command in ${command} ${args.join(" ")}`);
  }
  // /s: cmd.exe takes the outer quotes off and runs what's between them as it stands.
  return {
    file: comSpec,
    argv: ["/d", "/s", "/c", `""${command}" ${args.join(" ")}"`],
    verbatim: true,
  };
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function readJson(path: string): unknown {
  const text = readText(path);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
