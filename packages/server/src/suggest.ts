import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  type CatalogAgent,
  type Idea,
  type SuggestionAgent,
  type Suggestions,
  settled,
  startedAs,
  startedFrom,
} from "@ponzu/core";
import { repositoryOf } from "./catalog.ts";

/*
 * The home screen's Suggested tab. Ponzu runs the person's own coding agent, headless and
 * strictly read-only, over the projects their agents worked in lately, and asks each for a few
 * designs grounded in what's really there. Projects run side by side and each one's ideas are
 * published as it finishes, so they arrive one project at a time. What it found is kept in
 * Ponzu's app data and shown at once next time, while it looks again in the background.
 */

/** Projects looked at in one run, the most recent first. */
export const PROJECTS = 5;
/** Ideas asked for in one run, across its projects. */
export const IDEAS = 8;
/** Ideas asked of one project, however few projects there are. */
const PER_PROJECT = 4;
/** Ideas kept: a run's new ones in front, the last run's behind them. */
const KEEP = 16;
/** Session files read for their folder, newest first, before giving up on finding more projects. */
const SESSIONS = 200;
/** A session file's first line holds its folder; a Codex one's carries long instructions too. */
const HEAD_BYTES = 64 * 1024;
/** The agent's CLIs running at once. */
const AT_ONCE = 3;
/** The shortest wait between two runs: opening the tab again soon after shows what it has. */
export const RUN_EVERY = 10 * 60_000;
/** How long one project's run may take before it's stopped. */
export const RUN_TIMEOUT = 4 * 60_000;

/** A project the person's agents worked in lately. */
export interface RecentProject {
  /** Its main checkout. */
  root: string;
  /** Its folder's name: "seekle". */
  name: string;
  /** What every checkout of it shares (see CatalogGit.project). */
  project: string;
  /** Its newest session, ms since the epoch. */
  at: number;
}

/** One project's run: what the runner is asked to do. */
export interface SuggestJob {
  agent: SuggestionAgent;
  /** The agent's CLI. */
  bin: string;
  project: RecentProject;
  /** What to ask it. */
  prompt: string;
  /** The JSON Schema its answer follows. */
  schema: object;
  signal: AbortSignal;
  env: Record<string, string | undefined>;
}

/** Runs one project's job and gives back the agent's answer, parsed: `{ ideas: [...] }`. */
export type SuggestRunner = (job: SuggestJob) => Promise<unknown>;

/** Whether an agent's CLI can run a job cut off from everything but reading the project. */
export type SuggestCheck = (
  agent: SuggestionAgent,
  bin: string,
  env: SuggestJob["env"],
) => Promise<boolean>;

export interface SuggestOptions {
  /** The path of an agent's CLI on this Mac, or null when it isn't installed. */
  bin(agent: SuggestionAgent): string | null;
  /** The agents Ponzu sets up here: one that isn't found isn't run. */
  agents?: () => Promise<CatalogAgent[]>;
  /** The designs this Mac has, so ideas already started drop out. */
  designs?: () => Promise<Design[]>;
  /** Where what it found is kept. In memory only without one. */
  file?: string;
  /** Runs one project's job. Default: the agent's CLI. */
  run?: SuggestRunner;
  /**
   * Whether an agent can be run at all: one that can't is treated as not installed. Default,
   * for the agent's CLI: its version has every flag that keeps the run isolated.
   */
  isolated?: SuggestCheck;
  /** Whose agent histories to read. Default: the person's home folder. */
  home?: string;
  /** The environment the agent runs in: a PATH that finds what it needs. */
  env?: Record<string, string | undefined>;
  every?: number;
  timeout?: number;
  now?: () => number;
}

/** A design on this Mac, as far as suggestions care. */
interface Design {
  name: string;
  key: string;
  git?: { project?: string };
  busy?: string;
  created?: number;
}

/** What's kept between launches. */
interface Saved {
  /** When the last run started. */
  ran: number;
  ideas: Idea[];
}

/** The answer each run gives, for agents that take a schema. */
export const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ideas"],
  properties: {
    ideas: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "project", "card", "prompt"],
        properties: {
          name: { type: "string" },
          project: { type: "string" },
          card: { type: "string" },
          prompt: { type: "string" },
        },
      },
    },
  },
} as const;

export class SuggestionService {
  private ideas: Idea[] = [];
  private ran = 0;
  private running = false;
  private stopped = new AbortController();
  private loaded: Promise<void>;
  private saving = Promise.resolve();
  private readonly every: number;
  private readonly now: () => number;

  constructor(private opts: SuggestOptions) {
    this.every = opts.every ?? RUN_EVERY;
    this.now = opts.now ?? Date.now;
    this.loaded = this.load();
  }

  /**
   * What the tab shows now: the agent, and the ideas not started yet. One whose design is
   * still being made stays, so its card can show the design in its place.
   */
  async state(): Promise<Suggestions> {
    await this.loaded;
    const [agent, designs] = await Promise.all([this.agent(), this.designs()]);
    const now = this.now();
    return {
      agent: agent?.id ?? null,
      ideas: this.ideas.filter((i) => {
        const started = startedFrom(i, designs);
        return !started || !settled(started, now);
      }),
      running: this.running,
    };
  }

  /**
   * Look again, unless a run is going or one started a little while ago. Resolves with the
   * state as the run starts; the run goes on in the background.
   */
  async refresh(): Promise<Suggestions> {
    await this.loaded;
    const due = () => !this.running && this.now() - this.ran >= this.every;
    if (due()) {
      const agent = await this.agent();
      // Asked again: another refresh may have run while this one looked for the agent.
      if (agent && due()) {
        this.running = true;
        this.ran = this.now();
        void this.run(agent).finally(() => {
          this.running = false;
        });
      }
    }
    return this.state();
  }

  /** Stops a run that's going. */
  stop() {
    this.stopped.abort();
  }

  /** Claude Code if it's here and can run isolated, else Codex. */
  private async agent(): Promise<{ id: SuggestionAgent; bin: string } | null> {
    const listed = this.opts.agents ? await this.opts.agents().catch(() => []) : null;
    // A runner of one's own keeps its own runs apart.
    const isolated = this.opts.isolated ?? (this.opts.run ? null : isolates);
    for (const id of ["claude", "codex"] as const) {
      if (listed && !listed.some((a) => a.id === id && a.found)) continue;
      const bin = this.opts.bin(id);
      if (!bin) continue;
      if (isolated && !(await isolated(id, bin, this.env()).catch(() => false))) continue;
      return { id, bin };
    }
    return null;
  }

  private env() {
    return { ...process.env, ...this.opts.env };
  }

  private async designs() {
    return (await this.opts.designs?.().catch(() => [])) ?? [];
  }

  private async run(agent: { id: SuggestionAgent; bin: string }) {
    await this.save();
    const projects = await recentProjects({ home: this.opts.home }).catch(() => []);
    if (!projects.length) return;
    const designs = await this.designs();
    const counts = shares(IDEAS, projects.length);
    const runner = this.opts.run ?? runAgent;
    await eachAtOnce(projects, AT_ONCE, async (project, i) => {
      if (this.stopped.signal.aborted) return;
      // What it has and what it was offered last time, so this time brings new ones.
      const taken = {
        designs: designs.filter((d) => d.git?.project === project.project).map((d) => d.name),
        suggested: this.ideas.filter((i) => i.project === project.root).map((i) => i.name),
      };
      const job: SuggestJob = {
        agent: agent.id,
        bin: agent.bin,
        project,
        prompt: promptFor(project, counts[i]!, taken, this.opts.home),
        schema: SCHEMA,
        signal: AbortSignal.any([
          this.stopped.signal,
          AbortSignal.timeout(this.opts.timeout ?? RUN_TIMEOUT),
        ]),
        env: this.env(),
      };
      let answer: unknown;
      try {
        answer = await runner(job);
      } catch (err) {
        // Quietly: the tab keeps what it had.
        console.error(`Suggestions for ${project.name}: ${(err as Error).message ?? err}`);
        return;
      }
      const found = ideasFrom(answer, project, {
        count: counts[i]!,
        found: this.now(),
        home: this.opts.home,
      }).filter((idea) => !startedFrom(idea, designs));
      if (!found.length) return;
      this.ideas = [
        ...found,
        ...this.ideas.filter((old) => !found.some((f) => sameIdea(f, old))),
      ].slice(0, KEEP);
      await this.save();
    });
  }

  private async load() {
    if (!this.opts.file) return;
    try {
      const saved = JSON.parse(await readFile(this.opts.file, "utf8")) as Partial<Saved>;
      this.ran = typeof saved.ran === "number" ? saved.ran : 0;
      this.ideas = Array.isArray(saved.ideas) ? saved.ideas.filter(isIdea) : [];
    } catch {}
  }

  /** Writes what it has, one write at a time, each with what it has by then. */
  private save(): Promise<void> {
    const file = this.opts.file;
    if (!file) return Promise.resolve();
    this.saving = this.saving.then(async () => {
      const saved: Saved = { ran: this.ran, ideas: this.ideas };
      try {
        await mkdir(dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, `${JSON.stringify(saved, null, 2)}\n`);
        await rename(tmp, file);
      } catch {}
    });
    return this.saving;
  }
}

/** Two ideas are one when they're named the same in the same project. */
function sameIdea(a: Idea, b: Idea): boolean {
  return a.project === b.project && startedAs(a, { name: b.name, key: b.name });
}

function isIdea(i: unknown): i is Idea {
  const o = i as Idea;
  return (
    typeof o?.name === "string" &&
    typeof o.project === "string" &&
    typeof o.projectId === "string" &&
    typeof o.projectName === "string" &&
    typeof o.card === "string" &&
    typeof o.prompt === "string" &&
    typeof o.found === "number"
  );
}

/** `total` split across `n`, the first ones taking what's left over, none more than PER_PROJECT. */
export function shares(total: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) =>
    Math.min(PER_PROJECT, Math.floor(total / n) + (i < total % n ? 1 : 0)),
  ).map((c) => Math.max(1, c));
}

async function eachAtOnce<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

/* ------------------------------------------------------------------ */
/* Which projects                                                     */
/* ------------------------------------------------------------------ */

interface Session {
  file: string;
  at: number;
}

/**
 * The projects the person's agents worked in lately, newest first: the folder each Claude Code
 * and Codex session recorded, resolved to its repository's main checkout, so a worktree counts
 * as its project. Folders gone since, and folders outside git, are left out.
 */
export async function recentProjects(
  o: { home?: string; limit?: number; env?: Record<string, string | undefined> } = {},
): Promise<RecentProject[]> {
  const home = o.home ?? homedir();
  const env = o.env ?? (o.home ? {} : process.env);
  const limit = o.limit ?? PROJECTS;
  const sessions = [
    ...(await claudeSessions(env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"))),
    ...(await codexSessions(env.CODEX_HOME ?? join(home, ".codex"))),
  ].sort((a, b) => b.at - a.at);
  const out = new Map<string, RecentProject>();
  const tried = new Set<string>();
  for (const s of sessions.slice(0, SESSIONS)) {
    if (out.size >= limit) break;
    const cwd = await cwdOf(s.file);
    if (!cwd || tried.has(cwd)) continue;
    tried.add(cwd);
    // A scratch folder in the system's temporary ones isn't a project the person keeps.
    if (cwd === home || (!cwd.startsWith(`${home}/`) && isTemporary(cwd))) continue;
    if (
      !(await stat(cwd).then(
        (st) => st.isDirectory(),
        () => false,
      ))
    )
      continue;
    const repo = await repositoryOf(cwd).catch(() => null);
    if (!repo || repo.root === home || out.has(repo.project)) continue;
    // Named by its folder, as the prompt names it: a remote's name ("app") can say less.
    out.set(repo.project, {
      root: repo.root,
      name: basename(repo.root),
      project: repo.project,
      at: s.at,
    });
  }
  return [...out.values()];
}

/** Claude Code keeps a session per file in `projects/<folder>/<session>.jsonl`. */
async function claudeSessions(dir: string): Promise<Session[]> {
  const folders = await readdir(join(dir, "projects")).catch(() => []);
  const out: Session[] = [];
  await Promise.all(
    folders.map(async (f) => {
      const at = join(dir, "projects", f);
      const files = await readdir(at).catch(() => []);
      for (const name of files) {
        if (!name.endsWith(".jsonl")) continue;
        const file = join(at, name);
        const s = await stat(file).catch(() => null);
        if (s?.isFile()) out.push({ file, at: s.mtimeMs });
      }
    }),
  );
  return out;
}

/** Codex keeps them by day, `sessions/2026/10/27/rollout-….jsonl`: the newest days are enough. */
async function codexSessions(dir: string): Promise<Session[]> {
  const files: string[] = [];
  const walk = async (at: string, depth: number) => {
    const names = (await readdir(at).catch(() => [])).sort().reverse();
    for (const name of names) {
      if (files.length >= SESSIONS) return;
      const path = join(at, name);
      if (depth < 3) await walk(path, depth + 1);
      else if (name.endsWith(".jsonl")) files.push(path);
    }
  };
  await walk(join(dir, "sessions"), 0);
  const out: Session[] = [];
  for (const file of files) {
    const s = await stat(file).catch(() => null);
    if (s?.isFile()) out.push({ file, at: s.mtimeMs });
  }
  return out;
}

const CWD = /"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/;

/** The folder a session ran in: the first `cwd` it recorded. */
export async function cwdOf(file: string): Promise<string | null> {
  const head = await new Promise<string>((done) => {
    let text = "";
    const stream = createReadStream(file, { encoding: "utf8", start: 0, end: HEAD_BYTES - 1 });
    stream.on("data", (chunk) => {
      text += chunk;
      if (CWD.test(text)) stream.destroy();
    });
    stream.on("close", () => done(text));
    stream.on("error", () => done(text));
  });
  const m = CWD.exec(head);
  if (!m) return null;
  try {
    const cwd = JSON.parse(m[1]!) as string;
    return cwd.startsWith("/") ? cwd.replace(/\/+$/, "") || "/" : null;
  } catch {
    return null;
  }
}

function isTemporary(dir: string): boolean {
  return [tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"].some(
    (t) => dir === t || dir.startsWith(`${t.replace(/\/+$/, "")}/`),
  );
}

/* ------------------------------------------------------------------ */
/* The run                                                            */
/* ------------------------------------------------------------------ */

/** `~/code/seekle` for a folder in the home folder. */
export function tilde(path: string, home = homedir()): string {
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** What the agent is asked for one project. */
export function promptFor(
  p: RecentProject,
  count: number,
  taken: { designs: string[]; suggested: string[] },
  home?: string,
): string {
  const folder = tilde(p.root, home);
  const names = (list: string[]) => list.map((n) => `“${n}”`).join(", ");
  const ideas = count === 1 ? "one design" : `${count} designs`;
  return [
    `You're suggesting designs for Ponzu, a design canvas where the person's coding agent draws in HTML and CSS and they steer it with comments.`,
    ``,
    `Look around the repository in ${folder} and suggest ${ideas} they might ask their agent for next. Each must start from something really in this repository, named the way the code names it: its screens and their states, a flow end to end, a component, the data model, how its parts fit together, its brand or docs, a page it's missing. Prefer what someone working on it would want to see laid out, or decide between a few takes on.`,
    ``,
    `For each one give:`,
    `- name: what the design is called, like a file name, in sentence case and two to five words, e.g. "Every Seekle screen" or "Checkout, three takes".`,
    `- card: one or two short sentences, at most 140 characters, saying what it shows and the real files, folders or features it starts from.`,
    `- prompt: the whole prompt to paste into the agent. Start it with: In ${folder}, put this in a new Ponzu design called “<name>”: and then say what to draw and where to start, in two to four sentences.`,
    `- project: ${p.root}`,
    ``,
    `Leave out branches, worktrees and time estimates.${
      taken.designs.length
        ? ` It already has these designs, so suggest others: ${names(taken.designs)}.`
        : ""
    }${
      taken.suggested.length
        ? ` These were suggested before; suggest different ones, not new takes on them: ${names(taken.suggested)}.`
        : ""
    }`,
    `Only read: change nothing. Answer with the JSON alone: {"ideas": [{"name", "project", "card", "prompt"}]}.`,
  ].join("\n");
}

/**
 * The ideas in an agent's answer that hold up: each with a name, a card and a prompt, at most
 * `count` of them, tied to the project it was asked about. A prompt that doesn't name the
 * folder gets the opening it was asked for.
 */
export function ideasFrom(
  answer: unknown,
  p: RecentProject,
  o: { count: number; found: number; home?: string },
): Idea[] {
  const list = (answer as { ideas?: unknown })?.ideas;
  if (!Array.isArray(list)) return [];
  const folder = tilde(p.root, o.home);
  const out: Idea[] = [];
  for (const raw of list) {
    const r = raw as Record<string, unknown>;
    const name = clean(r?.name);
    const card = clean(r?.card);
    let prompt = clean(r?.prompt);
    if (!name || !card || !prompt || name.length > 80) continue;
    if (out.some((i) => startedAs(i, { name, key: name }))) continue;
    if (!prompt.includes(folder) && !prompt.includes(p.root))
      prompt = `In ${folder}, put this in a new Ponzu design called “${name}”: ${prompt}`;
    out.push({
      name,
      project: p.root,
      projectId: p.project,
      projectName: p.name,
      card,
      prompt,
      found: o.found,
    });
    if (out.length >= o.count) break;
  }
  return out;
}

function clean(v: unknown): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
}

/** The agent's CLI, headless and read-only. */
export const runAgent: SuggestRunner = async (job) => {
  if (job.agent === "claude") return runClaude(job);
  return runCodex(job);
};

/**
 * The flags a run can't go without, each agent's: no MCP servers (so not Ponzu's own), no
 * hooks, and no session saved into the history the projects come from. Hooks are turned off
 * with Claude Code's `--settings` and Codex's `-c`, which every version has.
 */
const ISOLATION: Record<SuggestionAgent, string[]> = {
  claude: ["--strict-mcp-config", "--no-session-persistence", "--settings", "--setting-sources"],
  codex: ["--ephemeral"],
};

/**
 * Whether this version of the agent's CLI has every flag that keeps a run isolated. One that
 * doesn't isn't run at all, rather than run with the person's MCP servers, hooks or history.
 */
export const isolates: SuggestCheck = async (agent, bin, env) => {
  const has = flagsOf(await helpOf(bin, agent === "codex" ? ["exec", "--help"] : ["--help"], env));
  return ISOLATION[agent].every(has);
};

/** Whether a CLI's help lists a flag, as an option of its own, not in another's text. */
function flagsOf(help: string): (flag: string) => boolean {
  return (flag) => new RegExp(`^\\s*(?:-\\w, )?${flag}\\b`, "m").test(help);
}

/**
 * `claude -p`, its tools cut to Read, Glob and Grep and everything else denied, with no MCP
 * servers, no hooks, none of the project's settings, and no session saved.
 */
async function runClaude(job: SuggestJob): Promise<unknown> {
  const help = await helpOf(job.bin, ["--help"], job.env);
  const has = flagsOf(help);
  if (!ISOLATION.claude.every(has)) throw new Error("Claude Code can't run isolated");
  const tools = "Read,Glob,Grep";
  const args = [
    "-p",
    "--output-format",
    "json",
    ...(has("--json-schema") ? ["--json-schema", JSON.stringify(job.schema)] : []),
    ...(has("--tools") ? ["--tools", tools] : []),
    "--allowedTools",
    tools,
    "--disallowedTools",
    "Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task",
    ...(help.includes("dontAsk") ? ["--permission-mode", "dontAsk"] : []),
    // Only the person's own settings, for how they sign in: a repository's can bring hooks,
    // plugins and permissions. And no hooks at all, the person's included.
    "--setting-sources",
    "user",
    "--settings",
    JSON.stringify({ disableAllHooks: true }),
    "--strict-mcp-config",
    "--no-session-persistence",
    // Quick enough to look around a repository while the person watches.
    "--model",
    "sonnet",
  ];
  const out = await exec(job.bin, args, {
    cwd: job.project.root,
    input: job.prompt,
    env: job.env,
    signal: job.signal,
  });
  const result = parseJson(out) as {
    is_error?: boolean;
    result?: string;
    structured_output?: unknown;
  } | null;
  if (!result || result.is_error) throw new Error("Claude Code didn't answer");
  return result.structured_output ?? parseJson(result.result ?? "");
}

/**
 * `codex exec` in its read-only sandbox, never asking, with an output schema, without the
 * person's config (so no MCP servers), hooks, plugins or apps, and without saving a session.
 * It starts in an empty folder, so no project's config, hooks or rules load; its sandbox still
 * reads the project.
 */
async function runCodex(job: SuggestJob): Promise<unknown> {
  const help = await helpOf(job.bin, ["exec", "--help"], job.env);
  const has = flagsOf(help);
  if (!ISOLATION.codex.every(has)) throw new Error("Codex can't run isolated");
  const dir = await mkdtemp(join(tmpdir(), "ponzu-suggest-"));
  try {
    const work = join(dir, "work");
    const schema = join(dir, "schema.json");
    const last = join(dir, "answer.json");
    await mkdir(work);
    await writeFile(schema, JSON.stringify(job.schema));
    const off = (feature: string) => ["-c", `features.${feature}=false`];
    const args = [
      "exec",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--color",
      "never",
      "-C",
      work,
      "--output-schema",
      schema,
      "-o",
      last,
      "-c",
      'approval_policy="never"',
      ...off("hooks"),
      ...off("plugins"),
      ...off("apps"),
      ...off("memories"),
      ...(has("--ignore-user-config")
        ? ["--ignore-user-config"]
        : ["-c", "mcp_servers={}", "-c", "notify=[]"]),
      ...(has("--ignore-rules") ? ["--ignore-rules"] : []),
      "--ephemeral",
      "-",
    ];
    const out = await exec(job.bin, args, {
      cwd: work,
      input: job.prompt,
      env: job.env,
      signal: job.signal,
    });
    const answer = await readFile(last, "utf8").catch(() => out);
    return parseJson(answer);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** An answer's JSON, alone or among other text. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {}
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

const helps = new Map<string, Promise<string>>();

/** A CLI's help, asked once: which flags this version has. */
function helpOf(bin: string, args: string[], env: SuggestJob["env"]): Promise<string> {
  const key = `${bin} ${args.join(" ")}`;
  let h = helps.get(key);
  if (!h) {
    h = exec(bin, args, { env, signal: AbortSignal.timeout(15_000) }).catch(() => "");
    helps.set(key, h);
  }
  return h;
}

/** What a command prints, once it exits cleanly. Stopped, and its answer dropped, on `signal`. */
function exec(
  bin: string,
  args: string[],
  o: { cwd?: string; input?: string; env: SuggestJob["env"]; signal: AbortSignal },
): Promise<string> {
  return new Promise((done, fail) => {
    if (o.signal.aborted) return fail(new Error("stopped"));
    const child = spawn(bin, args, {
      cwd: o.cwd,
      env: o.env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const stop = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    };
    o.signal.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (d: Buffer) => {
      if (out.length < 4_000_000) out += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      if (err.length < 4000) err += d.toString();
    });
    child.on("error", (e) => {
      o.signal.removeEventListener("abort", stop);
      fail(e);
    });
    child.on("close", (code) => {
      o.signal.removeEventListener("abort", stop);
      if (o.signal.aborted) fail(new Error("timed out"));
      else if (code === 0) done(out);
      else fail(new Error(err.trim().split("\n").pop() || `exited with ${code}`));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(o.input ?? "");
  });
}
