import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  type CatalogAgent,
  type Idea,
  type IdeaStep,
  type LookingAt,
  type SuggestionAgent,
  type Suggestions,
  settled,
  startedAs,
  startedFrom,
} from "@ponzu/core";
import { repositoryOf } from "./catalog.ts";

/*
 * The home screen's Suggested tab. Ponzu runs the person's own coding agent, headless and
 * strictly read-only, over the projects their agents worked in lately, in two steps. First a
 * glance at each project with no tools: its file list and readme go in, and a few designs come
 * back, named, with the files each starts from. Their cards show at once. Then one run for each
 * design reads those files and writes the prompt that asks for it, while its card shows what it
 * reads. What it found is kept in Ponzu's app data and shown at once next time, and a later run
 * only tops it up.
 */

/** Projects looked at in one run, the most recent first. */
export const PROJECTS = 5;
/** Ideas the tab holds: a run tops it up to this many. */
export const IDEAS = 8;
/** Ideas asked of one project, however few projects there are. */
const PER_PROJECT = 4;
/** Ideas kept, the started ones among them: a run's new ones in front. */
const KEEP = 16;
/** An idea this old makes way for a new one the next time a run looks. */
export const STALE = 7 * 24 * 60 * 60_000;
/** Session files read for their folder, newest first, before giving up on finding more projects. */
const SESSIONS = 200;
/** A session file's first line holds its folder; a Codex one's carries long instructions too. */
const HEAD_BYTES = 64 * 1024;
/** The agent's CLIs running at once: every project's glance, then each idea's prompt. */
const AT_ONCE = 8;
/** The shortest wait between two runs: opening the tab again soon after shows what it has. */
export const RUN_EVERY = 10 * 60_000;
/** How long a glance, or one idea's prompt, may take before it's stopped. */
export const RUN_TIMEOUT = 3 * 60_000;
/** A prompt's run that says nothing for this long is stuck, and starts again. */
export const QUIET = 20_000;
/** Times an idea's prompt is tried before the idea is let go. */
const TRIES = 2;
/** What a card shows of what its run read: the latest few. */
const STEPS = 4;
/** Files a glance lists: enough to see a repository's shape, few enough to read at once. */
const LISTED = 600;
/** How much of each readme and agent note a glance reads. */
const NOTE_BYTES = 4000;

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

/** One run of the agent: what the runner is asked to do. */
export interface SuggestJob {
  agent: SuggestionAgent;
  /** The agent's CLI. */
  bin: string;
  /** A glance at the project that names designs, or the prompt for one of them. */
  kind: "glance" | "prompt";
  project: RecentProject;
  /** What to ask it. */
  prompt: string;
  /** The JSON Schema its answer follows. */
  schema: object;
  signal: AbortSignal;
  env: Record<string, string | undefined>;
  /** What the run reads, as it reads it, from an agent whose CLI says. */
  onStep?: (step: IdeaStep) => void;
  /** Stop it when it says nothing for this long, from an agent whose CLI streams. */
  quiet?: number;
}

/** Runs one job and gives back the agent's answer, parsed: `{ ideas: [...] }` or `{ prompt }`. */
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
  /** Runs one job. Default: the agent's CLI. */
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

/** What's kept between launches: ideas with their prompts written. */
interface Saved {
  /** When the last run started. */
  ran: number;
  ideas: Idea[];
}

type Agent = { id: SuggestionAgent; bin: string };

/** A glance's answer, for agents that take a schema. */
export const GLANCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ideas"],
  properties: {
    ideas: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "files"],
        properties: {
          name: { type: "string" },
          files: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

/** An idea's prompt. */
export const PROMPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["prompt"],
  properties: { prompt: { type: "string" } },
} as const;

export class SuggestionService {
  private ideas: Idea[] = [];
  private looking: LookingAt[] = [];
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
   * What the tab shows now: the agent, the projects a run is still looking around, and the ideas
   * not started yet. One whose design is still being made stays, so its card can show the design
   * in its place.
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
      looking: this.looking,
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
          this.looking = [];
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
  private async agent(): Promise<Agent | null> {
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

  /** A job for the agent, its time counted from when it starts. */
  private job(
    agent: Agent,
    project: RecentProject,
    kind: SuggestJob["kind"],
    prompt: string,
    more: Partial<SuggestJob> = {},
  ): SuggestJob {
    return {
      agent: agent.id,
      bin: agent.bin,
      kind,
      project,
      prompt,
      schema: kind === "glance" ? GLANCE_SCHEMA : PROMPT_SCHEMA,
      signal: AbortSignal.any([
        this.stopped.signal,
        AbortSignal.timeout(this.opts.timeout ?? RUN_TIMEOUT),
      ]),
      env: this.env(),
      ...more,
    };
  }

  private async run(agent: Agent) {
    await this.save();
    const projects = await recentProjects({ home: this.opts.home }).catch(() => []);
    if (!projects.length) return;
    const designs = await this.designs();
    // Ideas started stay for their cards; old ones make way. The rest it tops up. Each glance
    // still hears every idea offered before, old ones too, so it doesn't offer them again.
    const offered = this.ideas;
    const now = this.now();
    this.ideas = this.ideas.filter((i) => startedFrom(i, designs) || now - i.found < STALE);
    const open = this.ideas.filter((i) => !startedFrom(i, designs)).length;
    const counts = shares(IDEAS - open, projects.length);
    const home = this.opts.home;
    this.looking = projects.filter((_, i) => counts[i]! > 0).map((p) => lookingAt(p, home));
    const runner = this.opts.run ?? runAgent;
    const lane = limiter(AT_ONCE);
    const writing: Promise<void>[] = [];
    await Promise.all(
      projects.map(async (project, i) => {
        const count = counts[i]!;
        if (!count || this.stopped.signal.aborted) return;
        try {
          // What it has and what it was offered before, so this time brings new ones.
          const taken = {
            designs: designs.filter((d) => d.git?.project === project.project).map((d) => d.name),
            suggested: offered.filter((i) => i.project === project.root).map((i) => i.name),
          };
          const listing = await listingOf(project.root, this.env());
          const ask = glanceFor(project, count, taken, listing, home);
          const answer = await lane(() => runner(this.job(agent, project, "glance", ask)));
          const found = glanceFrom(answer, project, { count, found: this.now() }).filter(
            ({ idea }) => !startedFrom(idea, designs),
          );
          if (!found.length) return;
          this.ideas = [
            ...found.map((f) => f.idea),
            ...this.ideas.filter((old) => !found.some((f) => sameIdea(f.idea, old))),
          ].slice(0, KEEP);
          for (const f of found) writing.push(this.write(agent, project, f.idea, f.files, lane));
        } catch (err) {
          // Quietly: the tab keeps what it had.
          console.error(`Suggestions for ${project.name}: ${(err as Error).message ?? err}`);
        } finally {
          this.looking = this.looking.filter((l) => l.project !== project.root);
        }
      }),
    );
    await Promise.all(writing);
  }

  /**
   * Writes an idea's prompt, its card showing what the run reads meanwhile. A run that fails or
   * goes quiet starts again once, in what's left of the idea's time; an idea whose prompt can't be
   * written is let go.
   */
  private async write(
    agent: Agent,
    project: RecentProject,
    idea: Idea,
    files: string[],
    lane: Lane,
  ) {
    const ask = promptFor(idea, files, project, this.opts.home);
    const runner = this.opts.run ?? runAgent;
    const onStep = (step: IdeaStep) => {
      idea.steps = [...(idea.steps ?? []), step].slice(-STEPS);
    };
    // Its time counts from when its first try starts, the second try's included.
    let deadline: AbortSignal | undefined;
    for (let tries = 0; tries < TRIES && !this.stopped.signal.aborted; tries++) {
      if (deadline?.aborted) break;
      idea.steps = [];
      try {
        const answer = await lane(() => {
          deadline ??= AbortSignal.timeout(this.opts.timeout ?? RUN_TIMEOUT);
          const signal = AbortSignal.any([this.stopped.signal, deadline]);
          return runner(this.job(agent, project, "prompt", ask, { onStep, quiet: QUIET, signal }));
        });
        const prompt = promptFrom(answer, idea, project, this.opts.home);
        if (!prompt) continue;
        idea.prompt = prompt;
        delete idea.steps;
        await this.save();
        return;
      } catch (err) {
        console.error(`Suggestion “${idea.name}”: ${(err as Error).message ?? err}`);
      }
    }
    this.ideas = this.ideas.filter((i) => i !== idea);
  }

  private async load() {
    if (!this.opts.file) return;
    try {
      const saved = JSON.parse(await readFile(this.opts.file, "utf8")) as Partial<Saved>;
      this.ran = typeof saved.ran === "number" ? saved.ran : 0;
      this.ideas = Array.isArray(saved.ideas)
        ? saved.ideas.filter((i) => isIdea(i) && i.prompt)
        : [];
    } catch {}
  }

  /** Writes what it has, one write at a time, each with what it has by then. */
  private save(): Promise<void> {
    const file = this.opts.file;
    if (!file) return Promise.resolve();
    this.saving = this.saving.then(async () => {
      // An idea whose prompt isn't written yet is the run's: a run after a restart names anew.
      const ideas = this.ideas.filter((i) => i.prompt).map(({ steps: _, ...i }) => i);
      const saved: Saved = { ran: this.ran, ideas };
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
    typeof o.prompt === "string" &&
    typeof o.found === "number"
  );
}

function lookingAt(p: RecentProject, home?: string): LookingAt {
  return {
    project: p.root,
    projectId: p.project,
    projectName: p.name,
    folder: tilde(p.root, home),
  };
}

/**
 * `total` split across `n`, the most recent taking what's left over, none more than
 * PER_PROJECT. With fewer than `n` to ask for, the oldest are asked for none.
 */
export function shares(total: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) =>
    Math.min(PER_PROJECT, Math.max(0, Math.floor(total / n) + (i < total % n ? 1 : 0))),
  );
}

type Lane = <T>(fn: () => Promise<T>) => Promise<T>;

/** Runs at most `n` of what it's given at once, the rest in turn. */
function limiter(n: number): Lane {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async (fn) => {
    if (running < n) running++;
    else await new Promise<void>((go) => waiting.push(go));
    try {
      return await fn();
    } finally {
      // Its place goes straight to the next in turn.
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  };
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

/** What a glance reads: the repository's files, by name, and its readme and agent notes. */
export interface Listing {
  files: string[];
  /** How many files it has, the ones left off the list too. */
  count: number;
  notes: string;
}

/** Folders and files a glance's list leaves out: built, vendored, and pictures and fonts. */
const UNLISTED_DIR = /(^|\/)(node_modules|dist|build|out|\.next|vendor|Pods)\//;
const UNLISTED_FILE = /\.(png|jpe?g|gif|svg|ico|icns|webp|avif|mp4|mov|woff2?|ttf|otf|lock|snap)$/i;
const NOTES = ["README.md", "AGENTS.md", "CLAUDE.md"];

/** The repository's files as git has them, tracked or not but not ignored, and its notes. */
export async function listingOf(root: string, env: SuggestJob["env"]): Promise<Listing> {
  const out = await exec(
    "git",
    ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard"],
    { env, signal: AbortSignal.timeout(15_000) },
  ).catch(() => "");
  const all = out.split("\n").filter((f) => f && !UNLISTED_DIR.test(f) && !UNLISTED_FILE.test(f));
  // A big one keeps its shallower files: they say most about its shape.
  const files =
    all.length > LISTED ? all.filter((f) => f.split("/").length <= 5).slice(0, LISTED) : all;
  const notes = await Promise.all(
    NOTES.map(async (name) => {
      const text = await readFile(join(root, name), "utf8").catch(() => "");
      return text.trim() ? `${name}:\n${text.slice(0, NOTE_BYTES).trim()}` : "";
    }),
  );
  return { files, count: all.length, notes: notes.filter(Boolean).join("\n\n") };
}

/** What a glance at one project is asked: names for designs, from the list it's given. */
export function glanceFor(
  p: RecentProject,
  count: number,
  taken: { designs: string[]; suggested: string[] },
  listing: Listing,
  home?: string,
): string {
  const folder = tilde(p.root, home);
  const names = (list: string[]) => list.map((n) => `“${n}”`).join(", ");
  const ideas = count === 1 ? "one design" : `${count} designs`;
  return [
    `You're suggesting designs for Ponzu, a design canvas where the person's coding agent draws in HTML and CSS and they steer it with comments on the canvas.`,
    ``,
    `From the repository in ${folder}, listed below, suggest ${ideas} they might ask their agent for next. Each must start from something really in it, named the way the code names it: its screens and their states, a flow end to end, a component, the data model, how its parts fit together, its brand or docs, a page it's missing. Prefer what someone working on it would want to see laid out, or decide between a few takes on.`,
    ``,
    `For each one give:`,
    `- name: what the design is called, like a file name, in sentence case and two to five words, e.g. "Every Seekle screen" or "Checkout, three takes".`,
    `- files: two to four paths from the list that it starts from.`,
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
    `Use no tools and change nothing: everything you need is here. Answer with the JSON alone: {"ideas": [{"name", "files"}]}.`,
    ``,
    `<files count="${listing.count}">`,
    ...listing.files,
    `</files>`,
    ...(listing.notes ? [``, `<notes>`, listing.notes, `</notes>`] : []),
  ].join("\n");
}

/** What one idea's run is asked: read the code it starts from, then write its prompt. */
export function promptFor(
  idea: Pick<Idea, "name">,
  files: string[],
  p: RecentProject,
  home?: string,
): string {
  const folder = tilde(p.root, home);
  return [
    `You're writing a prompt for Ponzu, a design canvas where the person's coding agent draws in HTML and CSS and they steer it with comments on the canvas. They'll send it to their agent to make a design called “${idea.name}” in ${folder}${files.length ? `, starting from ${files.join(", ")}` : ""}. Read the code it should start from, a few files at most, then write it.`,
    ``,
    `Its card shows the prompt, so it also teaches them how to ask for a design: write it in their voice, the way they'd type it, and be specific. Ask for what Ponzu is good at: each screen or state on its own artboard, side by side; a few takes to compare; a flow or a diagram drawn from the code; and their comments on the canvas to steer it.`,
    ``,
    `Start it with: In ${folder}, make a new Ponzu design called “${idea.name}”. Then, in three to six sentences, ask for what to draw, name the files, screens and states in the code to start from, and say how to lay it out on the canvas. End by asking it to watch the canvas for their comments. Write plain text, no Markdown, and leave out branches, worktrees and time estimates.`,
    ``,
    `Only read: change nothing. Answer with the JSON alone: {"prompt": "…"}.`,
  ].join("\n");
}

/**
 * The ideas in a glance's answer that hold up, each with the files it starts from: at most
 * `count`, named once, tied to the project it was asked about, their prompts still to write.
 */
export function glanceFrom(
  answer: unknown,
  p: RecentProject,
  o: { count: number; found: number },
): { idea: Idea; files: string[] }[] {
  const list = (answer as { ideas?: unknown })?.ideas;
  if (!Array.isArray(list)) return [];
  const out: { idea: Idea; files: string[] }[] = [];
  for (const raw of list) {
    const r = raw as Record<string, unknown>;
    const name = clean(r?.name);
    if (!name || name.length > 80) continue;
    if (out.some(({ idea }) => startedAs(idea, { name, key: name }))) continue;
    const files = (Array.isArray(r.files) ? r.files : []).map(clean).filter(Boolean).slice(0, 4);
    out.push({
      idea: {
        name,
        project: p.root,
        projectId: p.project,
        projectName: p.name,
        prompt: "",
        steps: [],
        found: o.found,
      },
      files,
    });
    if (out.length >= o.count) break;
  }
  return out;
}

/**
 * The prompt in an idea's answer, or "" for none. One that doesn't name the folder and the
 * design gets the opening it was asked for.
 */
export function promptFrom(
  answer: unknown,
  idea: Pick<Idea, "name">,
  p: RecentProject,
  home?: string,
): string {
  const prompt = clean((answer as { prompt?: unknown })?.prompt);
  if (!prompt) return "";
  const folder = tilde(p.root, home);
  // The design's name too: it's how the design it becomes is known for the idea's.
  const opens = prompt.includes(idea.name) && (prompt.includes(folder) || prompt.includes(p.root));
  return opens ? prompt : `In ${folder}, make a new Ponzu design called “${idea.name}”. ${prompt}`;
}

function clean(v: unknown): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
}

/**
 * What a run is doing, from one of its tool calls, for its card: the file it reads (its last
 * two parts), the files it looks for, or the words it searches for. Null for anything else.
 */
export function stepOf(tool: string, input: unknown, root: string): IdeaStep | null {
  const i = (input ?? {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  if (tool === "Read") {
    const path = text(i.file_path);
    const rel = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
    return rel ? { verb: "read", what: rel.split("/").slice(-2).join("/") } : null;
  }
  if (tool === "Glob") {
    const pattern = text(i.pattern);
    return pattern ? { verb: "find", what: pattern } : null;
  }
  if (tool === "Grep") {
    const words = text(i.pattern)
      .replace(/^\(\?i\)/, "")
      .split("|")[0]!
      .replace(/\\[wsdb][+*?]?/g, " ")
      .replace(/\.[+*?]?/g, " ")
      .replace(/[\\^$()[\]{}?*+]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40);
    return words ? { verb: "search", what: words } : null;
  }
  return null;
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
 * `claude -p` with no MCP servers, no hooks, none of the project's settings, and no session
 * saved. A glance has no tools at all; a prompt's run has Read, Glob and Grep, everything else
 * denied, and streams, so its card hears each file it reads and a stuck run is noticed.
 */
async function runClaude(job: SuggestJob): Promise<unknown> {
  const help = await helpOf(job.bin, ["--help"], job.env);
  const has = flagsOf(help);
  if (!ISOLATION.claude.every(has)) throw new Error("Claude Code can't run isolated");
  // A version without --tools can't take them all away: the glance reads, as a prompt's run does.
  const tools = job.kind === "glance" && has("--tools") ? "" : "Read,Glob,Grep";
  // Partial messages say it's thinking, so only a run that's really stuck goes quiet.
  const stream = job.kind === "prompt" && has("--include-partial-messages");
  const args = [
    "-p",
    "--output-format",
    stream ? "stream-json" : "json",
    ...(stream ? ["--verbose", "--include-partial-messages"] : []),
    ...(tools && has("--json-schema") ? ["--json-schema", JSON.stringify(job.schema)] : []),
    ...(has("--tools") ? ["--tools", tools] : []),
    ...(tools ? ["--allowedTools", tools] : []),
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
  type Result = { is_error?: boolean; result?: string; structured_output?: unknown };
  let result: Result | null = null;
  const onLine = (line: string) => {
    const e = parseJson(line) as {
      type?: string;
      message?: { content?: { type?: string; name?: string; input?: unknown }[] };
    } | null;
    if (e?.type === "result") result = e as Result;
    if (e?.type !== "assistant") return;
    for (const block of e.message?.content ?? []) {
      if (block?.type !== "tool_use" || !block.name) continue;
      const step = stepOf(block.name, block.input, job.project.root);
      if (step) job.onStep?.(step);
    }
  };
  const out = await exec(job.bin, args, {
    cwd: job.project.root,
    input: job.prompt,
    env: job.env,
    signal: job.signal,
    ...(stream ? { onLine, quiet: job.quiet } : {}),
  });
  const r = (stream ? result : parseJson(out)) as Result | null;
  if (!r || r.is_error) throw new Error("Claude Code didn't answer");
  return r.structured_output ?? parseJson(r.result ?? "");
}

/**
 * `codex exec` in its read-only sandbox, never asking, with an output schema, without the
 * person's config (so no MCP servers), hooks, plugins or apps, and without saving a session.
 * It starts in an empty folder, so no project's config, hooks or rules load; its sandbox still
 * reads the project. Its glance is told everything it needs.
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

/** How long a CLI's help holds: one upgraded in place may have the flags it lacked. */
const HELP_FOR = RUN_EVERY;
const helps = new Map<string, { at: number; help: Promise<string> }>();

/**
 * A CLI's help, asked once in a while: which flags this version has. One that fails or says
 * nothing (slow to start, or briefly missing) is asked again next time, rather than hiding the
 * agent until Ponzu restarts.
 */
function helpOf(bin: string, args: string[], env: SuggestJob["env"]): Promise<string> {
  const key = `${bin} ${args.join(" ")}`;
  const kept = helps.get(key);
  if (kept && Date.now() - kept.at < HELP_FOR) return kept.help;
  const help = exec(bin, args, { env, signal: AbortSignal.timeout(15_000) }).catch(() => "");
  helps.set(key, { at: Date.now(), help });
  void help.then((text) => {
    if (!text && helps.get(key)?.help === help) helps.delete(key);
  });
  return help;
}

/**
 * What a command prints, once it exits cleanly; or with `onLine`, each line as it comes. Stopped,
 * and its answer dropped, on `signal`, or when it prints nothing for `quiet` ms.
 */
function exec(
  bin: string,
  args: string[],
  o: {
    cwd?: string;
    input?: string;
    env: SuggestJob["env"];
    signal: AbortSignal;
    onLine?: (line: string) => void;
    quiet?: number;
  },
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
    let quiet = false;
    const stop = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    };
    let hush: ReturnType<typeof setTimeout> | undefined;
    const heard = () => {
      if (!o.quiet) return;
      clearTimeout(hush);
      hush = setTimeout(() => {
        quiet = true;
        stop();
      }, o.quiet);
    };
    heard();
    const lines = (flush: boolean) => {
      if (!o.onLine) return;
      let i = out.indexOf("\n");
      while (i >= 0) {
        o.onLine(out.slice(0, i));
        out = out.slice(i + 1);
        i = out.indexOf("\n");
      }
      if (flush && out) o.onLine(out);
    };
    o.signal.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (d: Buffer) => {
      heard();
      if (out.length < 4_000_000) out += d.toString();
      lines(false);
    });
    child.stderr.on("data", (d: Buffer) => {
      if (err.length < 4000) err += d.toString();
    });
    child.on("error", (e) => {
      clearTimeout(hush);
      o.signal.removeEventListener("abort", stop);
      fail(e);
    });
    child.on("close", (code) => {
      clearTimeout(hush);
      o.signal.removeEventListener("abort", stop);
      if (quiet) return fail(new Error("went quiet"));
      if (o.signal.aborted) return fail(new Error("timed out"));
      lines(true);
      if (code === 0) done(o.onLine ? "" : out);
      else fail(new Error(err.trim().split("\n").pop() || `exited with ${code}`));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(o.input ?? "");
  });
}
