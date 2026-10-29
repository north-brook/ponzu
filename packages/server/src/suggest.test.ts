import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalWorkspace } from "./index.ts";
import { peerAllowed, serve } from "./serve.ts";
import {
  cwdOf,
  GLANCE_SCHEMA,
  glanceFor,
  glanceFrom,
  listingOf,
  PROMPT_SCHEMA,
  parseJson,
  promptFor,
  promptFrom,
  QUIET,
  type RecentProject,
  recentProjects,
  STALE,
  SuggestionService,
  type SuggestJob,
  shares,
  stepOf,
} from "./suggest.ts";

let home: string;
let alpha: string;
let beta: string;

/** A repository's main checkout, its origin on GitHub. */
async function repo(dir: string, remote: string) {
  await mkdir(join(dir, ".git"), { recursive: true });
  await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(dir, ".git", "config"), `[remote "origin"]\n\turl = ${remote}\n`);
}

/** A linked worktree of `main` at `dir`, as git lays one out. */
async function worktree(main: string, dir: string, name: string) {
  const meta = join(main, ".git", "worktrees", name);
  await mkdir(meta, { recursive: true });
  await writeFile(join(meta, "commondir"), "../..\n");
  await writeFile(join(meta, "HEAD"), `ref: refs/heads/${name}\n`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".git"), `gitdir: ${meta}\n`);
}

/** A session file that ran in `cwd`, last written `ago` ms back. */
async function session(file: string, lines: object[], ago: number) {
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const at = new Date(Date.now() - ago);
  await utimes(file, at, at);
}

beforeAll(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "ponzu-suggest-")));
  alpha = join(home, "code", "alpha");
  beta = join(home, "code", "beta");
  await repo(alpha, "git@github.com:me/alpha.git");
  await repo(beta, "https://github.com/me/beta");
  await worktree(alpha, join(home, "worktrees", "alpha-1"), "alpha-1");
  await mkdir(join(home, "notes"), { recursive: true });

  const claude = join(home, ".claude", "projects");
  // The newest: a worktree of alpha. Claude Code's first line needn't carry the folder.
  await session(
    join(claude, "-wt", "s1.jsonl"),
    [{ type: "queue-operation" }, { type: "user", cwd: join(home, "worktrees", "alpha-1") }],
    1_000,
  );
  // A folder deleted since, and one outside git: neither is a project.
  await session(join(claude, "-gone", "s2.jsonl"), [{ cwd: join(home, "gone") }], 2_000);
  await session(join(claude, "-notes", "s3.jsonl"), [{ cwd: join(home, "notes") }], 3_000);
  // alpha's main checkout, older: the same project as its worktree.
  await session(join(claude, "-alpha", "s4.jsonl"), [{ cwd: alpha }], 50_000);
  // Codex's session metadata, by day.
  await session(
    join(home, ".codex", "sessions", "2026", "10", "27", "rollout-1.jsonl"),
    [{ type: "session_meta", payload: { cwd: beta, base_instructions: { text: "…" } } }],
    10_000,
  );
});

afterAll(() => rm(home, { recursive: true, force: true }));

describe("which projects", () => {
  test("recent projects from both agents' histories, worktrees folded in, newest first", async () => {
    const projects = await recentProjects({ home });
    expect(projects.map((p) => [p.root, p.name, p.project])).toEqual([
      [alpha, "alpha", "github.com/me/alpha"],
      [beta, "beta", "github.com/me/beta"],
    ]);
  });

  test("capped", async () => {
    expect(await recentProjects({ home, limit: 1 })).toHaveLength(1);
  });

  test("a session's folder is the first cwd it recorded, escapes and all", async () => {
    const file = join(home, "escaped.jsonl");
    await writeFile(file, `{"x":1}\n{"cwd":"/a/\\"quoted\\"/b/","cwd2":"/no"}\n{"cwd":"/later"}\n`);
    expect(await cwdOf(file)).toBe('/a/"quoted"/b');
    await writeFile(file, `{"type":"summary"}\n`);
    expect(await cwdOf(file)).toBeNull();
  });

  test("no histories, no projects", async () => {
    const empty = await mkdtemp(join(tmpdir(), "ponzu-suggest-empty-"));
    expect(await recentProjects({ home: empty })).toEqual([]);
    await rm(empty, { recursive: true, force: true });
  });
});

const seekle: RecentProject = {
  root: "/Users/me/code/seekle",
  name: "seekle",
  project: "github.com/me/seekle",
  at: 0,
};

describe("the run", () => {
  test("ideas are split across projects, the most recent taking what's left over", () => {
    expect(shares(8, 1)).toEqual([4]);
    expect(shares(8, 3)).toEqual([3, 3, 2]);
    expect(shares(8, 5)).toEqual([2, 2, 2, 1, 1]);
    // A top-up asks the most recent for what's missing, and the rest for none.
    expect(shares(2, 5)).toEqual([1, 1, 0, 0, 0]);
    expect(shares(0, 2)).toEqual([0, 0]);
  });

  test("a glance is given the files and notes, and the designs it already has", () => {
    const listing = {
      files: ["app/home.tsx", "app/game.tsx"],
      count: 40,
      notes: "README.md:\nA game.",
    };
    const p = glanceFor(
      seekle,
      2,
      { designs: ["Brand"], suggested: ["Friends leaderboard"] },
      listing,
      "/Users/me",
    );
    expect(p).toContain("From the repository in ~/code/seekle, listed below, suggest 2 designs");
    expect(p).toContain("- files: two to four paths from the list that it starts from.");
    expect(p).toContain("so suggest others: “Brand”.");
    expect(p).toContain("not new takes on them: “Friends leaderboard”.");
    expect(p).toContain("Leave out branches, worktrees and time estimates.");
    expect(p).toContain("Use no tools and change nothing");
    expect(p).toContain('<files count="40">\napp/home.tsx\napp/game.tsx\n</files>');
    expect(p).toContain("<notes>\nREADME.md:\nA game.\n</notes>");
  });

  test("an idea's run starts from its files and writes the opening it's asked for", () => {
    const p = promptFor({ name: "Brand" }, ["app/brand.tsx", "docs/voice.md"], seekle, "/Users/me");
    expect(p).toContain(
      "to make a design called “Brand” in ~/code/seekle, starting from app/brand.tsx, docs/voice.md.",
    );
    expect(p).toContain("Start it with: In ~/code/seekle, make a new Ponzu design called “Brand”.");
    expect(p).toContain("Write plain text, no Markdown");
    expect(promptFor({ name: "Brand" }, [], seekle, "/Users/me")).toContain(
      "called “Brand” in ~/code/seekle. Read the code",
    );
  });

  test("a glance's ideas that hold up, tied to the project, their prompts still to write", () => {
    const found = glanceFrom(
      {
        ideas: [
          { name: "Every Seekle screen", files: ["app/home.tsx", "", 3, "a", "b", "c"] },
          { name: "", files: [] },
          { name: "every seekle  screen", files: [] },
          { name: "Friends leaderboard" },
          { name: "One too many", files: [] },
        ],
      },
      seekle,
      { count: 2, found: 5 },
    );
    expect(found).toEqual([
      {
        idea: {
          name: "Every Seekle screen",
          project: seekle.root,
          projectId: "github.com/me/seekle",
          projectName: "seekle",
          prompt: "",
          steps: [],
          found: 5,
        },
        files: ["app/home.tsx", "a", "b", "c"],
      },
      {
        idea: {
          name: "Friends leaderboard",
          project: seekle.root,
          projectId: "github.com/me/seekle",
          projectName: "seekle",
          prompt: "",
          steps: [],
          found: 5,
        },
        files: [],
      },
    ]);
    expect(glanceFrom(null, seekle, { count: 2, found: 0 })).toEqual([]);
    expect(glanceFrom({ ideas: "no" }, seekle, { count: 2, found: 0 })).toEqual([]);
  });

  test("an idea's prompt, with the opening it was asked for", () => {
    const idea = { name: "Every Seekle screen" };
    const opening = "In ~/code/seekle, make a new Ponzu design called “Every Seekle screen”.";
    expect(promptFrom({ prompt: `${opening}  Rebuild\n them.` }, idea, seekle, "/Users/me")).toBe(
      `${opening} Rebuild them.`,
    );
    expect(promptFrom({ prompt: "Explore three takes." }, idea, seekle, "/Users/me")).toBe(
      `${opening} Explore three takes.`,
    );
    // Naming the folder isn't enough: the design's name is how the design it becomes is found.
    expect(
      promptFrom(
        { prompt: "Give me three takes on the brand in ~/code/seekle." },
        { name: "Brand" },
        seekle,
        "/Users/me",
      ),
    ).toStartWith("In ~/code/seekle, make a new Ponzu design called “Brand”. ");
    expect(promptFrom({ prompt: " " }, idea, seekle)).toBe("");
    expect(promptFrom(null, idea, seekle)).toBe("");
  });

  test("what a run reads, in a few words for its card", () => {
    const root = "/Users/me/code/seekle";
    expect(stepOf("Read", { file_path: `${root}/apps/native/app/home.tsx` }, root)).toEqual({
      verb: "read",
      what: "app/home.tsx",
    });
    expect(stepOf("Glob", { pattern: "apps/**/*.tsx" }, root)).toEqual({
      verb: "find",
      what: "apps/**/*.tsx",
    });
    expect(stepOf("Grep", { pattern: "(?i)sign-?up|signup|alerts?" }, root)).toEqual({
      verb: "search",
      what: "sign-up",
    });
    expect(stepOf("Grep", { pattern: "requested.?material" }, root)).toEqual({
      verb: "search",
      what: "requested material",
    });
    expect(stepOf("Grep", { pattern: "\\w+" }, root)).toBeNull();
    expect(stepOf("Bash", { command: "ls" }, root)).toBeNull();
  });

  test("a glance lists the files git has, not built ones or pictures, and reads the notes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ponzu-suggest-listing-"));
    try {
      const git = (...args: string[]) => Bun.spawnSync(["git", "-C", dir, ...args]);
      git("init", "-q");
      await mkdir(join(dir, "src"), { recursive: true });
      await mkdir(join(dir, "node_modules", "x"), { recursive: true });
      await writeFile(join(dir, "src", "app.tsx"), "");
      await writeFile(join(dir, "logo.png"), "");
      await writeFile(join(dir, "node_modules", "x", "i.js"), "");
      await writeFile(join(dir, "secret.env"), "");
      await writeFile(join(dir, ".gitignore"), "secret.env\n");
      await writeFile(join(dir, "README.md"), "# Seekle\n\nA word game.\n");
      git("add", "src/app.tsx");
      const listing = await listingOf(dir, process.env);
      expect(listing.files.sort()).toEqual([".gitignore", "README.md", "src/app.tsx"]);
      expect(listing.count).toBe(3);
      expect(listing.notes).toBe("README.md:\n# Seekle\n\nA word game.");
      // Not a repository: nothing to list.
      expect((await listingOf(join(home, "notes"), process.env)).files).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an answer's JSON, alone or wrapped in prose", () => {
    expect(parseJson('{"ideas":[]}')).toEqual({ ideas: [] });
    expect(parseJson('Here:\n```json\n{"ideas":[1]}\n```')).toEqual({ ideas: [1] });
    expect(parseJson("nothing")).toBeNull();
  });
});

/** The design an idea's run is asked to write the prompt for. */
const nameIn = (job: SuggestJob) => /design called “([^”]+)”/.exec(job.prompt)?.[1] ?? "";

/**
 * Answers each project's glance with ideas named after it, when told to, and each idea's
 * prompt at once: `Draw <name>.`, unless `prompt` answers it.
 */
function fakeRunner(o: { prompt?: (job: SuggestJob) => Promise<unknown> } = {}) {
  /** The glances. */
  const jobs: SuggestJob[] = [];
  const prompts: SuggestJob[] = [];
  const waiting = new Map<string, (answer: unknown) => void>();
  const failing = new Map<string, (err: Error) => void>();
  const run = (job: SuggestJob) => {
    if (job.kind === "prompt") {
      prompts.push(job);
      return o.prompt ? o.prompt(job) : Promise.resolve({ prompt: `Draw ${nameIn(job)}.` });
    }
    return new Promise<unknown>((resolve, reject) => {
      jobs.push(job);
      waiting.set(job.project.name, resolve);
      failing.set(job.project.name, reject);
    });
  };
  const answer = (name: string, ideas: string[]) =>
    waiting.get(name)?.({ ideas: ideas.map((n) => ({ name: n, files: [`${n}.tsx`] })) });
  const fail = (name: string) => failing.get(name)?.(new Error("not signed in"));
  return { jobs, prompts, run, answer, fail };
}

/** The latest glance at a project: they start in whatever order their file lists come in. */
const glanceAt = (runner: { jobs: SuggestJob[] }, name: string) =>
  runner.jobs.filter((j) => j.project.name === name).at(-1);

const until = async (ok: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 200 && !(await ok()); i++) await Bun.sleep(5);
};

describe("the Suggested tab's state", () => {
  test("Claude Code if it's here, else Codex, else none and no run", async () => {
    const runner = fakeRunner();
    const make = (bins: Record<string, string>, found?: string[]) =>
      new SuggestionService({
        bin: (a) => bins[a] ?? null,
        agents: found
          ? async () =>
              ["claude", "codex"].map((id) => ({
                id,
                label: id,
                found: found.includes(id),
                connected: false,
              }))
          : undefined,
        run: runner.run,
        home,
      });
    expect((await make({ claude: "/c", codex: "/x" }).state()).agent).toBe("claude");
    expect((await make({ codex: "/x" }).state()).agent).toBe("codex");
    // The catalog's agents say which are installed; one it didn't find isn't run.
    expect((await make({ claude: "/c", codex: "/x" }, ["codex"]).state()).agent).toBe("codex");
    const none = make({});
    expect(await none.refresh()).toEqual({ agent: null, ideas: [], running: false, looking: [] });
    expect(runner.jobs).toHaveLength(0);
  });

  test("an agent whose CLI can't run isolated isn't run at all", async () => {
    const runner = fakeRunner();
    const make = (isolated: string[]) =>
      new SuggestionService({
        bin: (a) => `/bin/${a}`,
        isolated: async (a) => isolated.includes(a),
        run: runner.run,
        home,
      });
    expect((await make(["codex"]).state()).agent).toBe("codex");
    const none = make([]);
    expect(await none.refresh()).toEqual({ agent: null, ideas: [], running: false, looking: [] });
    expect(runner.jobs).toHaveLength(0);
    // The agent's own CLI is asked for its flags: one that doesn't answer has none of them.
    const missing = new SuggestionService({ bin: () => join(home, "no-such-cli"), home });
    expect((await missing.state()).agent).toBeNull();
  });

  test("a CLI that didn't answer for its flags is asked again", async () => {
    const cli = join(home, "late-claude");
    const service = new SuggestionService({ bin: (a) => (a === "claude" ? cli : null), home });
    // Not there yet, then installed.
    expect((await service.state()).agent).toBeNull();
    await writeFile(
      cli,
      "#!/bin/sh\necho '  --strict-mcp-config\n  --no-session-persistence\n  --settings <file>\n  --setting-sources <sources>'\n",
    );
    await chmod(cli, 0o755);
    await until(async () => (await service.state()).agent === "claude");
    expect((await service.state()).agent).toBe("claude");
  });

  test("ideas arrive at the front project by project, one run at a time, kept for next time", async () => {
    const file = join(home, "ponzu", "suggestions.json");
    const runner = fakeRunner();
    let now = 1_000_000;
    const service = new SuggestionService({
      bin: () => "/bin/claude",
      run: runner.run,
      home,
      file,
      now: () => now,
    });
    expect(await service.state()).toEqual({
      agent: "claude",
      ideas: [],
      running: false,
      looking: [],
    });

    expect((await service.refresh()).running).toBe(true);
    await until(() => runner.jobs.length === 2);
    expect(runner.jobs.map((j) => [j.agent, j.bin, j.kind, j.project.root]).sort()).toEqual([
      ["claude", "/bin/claude", "glance", alpha],
      ["claude", "/bin/claude", "glance", beta],
    ]);
    expect(glanceAt(runner, "alpha")!.prompt).toContain("suggest 4 designs");
    expect(glanceAt(runner, "alpha")!.schema).toBe(GLANCE_SCHEMA);
    // Each project shows as looking around until its glance names its designs.
    expect((await service.state()).looking).toEqual([
      {
        project: alpha,
        projectId: "github.com/me/alpha",
        projectName: "alpha",
        folder: "~/code/alpha",
      },
      {
        project: beta,
        projectId: "github.com/me/beta",
        projectName: "beta",
        folder: "~/code/beta",
      },
    ]);
    // Opening the tab again while it runs starts nothing more.
    await service.refresh();
    expect(runner.jobs).toHaveLength(2);

    runner.answer("beta", ["Beta map"]);
    await until(async () => (await service.state()).ideas.length === 1);
    expect((await service.state()).looking.map((l) => l.projectName)).toEqual(["alpha"]);
    runner.answer("alpha", ["Alpha screens", "Alpha flow"]);
    await until(async () => !(await service.state()).running);
    const after = await service.state();
    expect(after.ideas.map((i) => i.name)).toEqual(["Alpha screens", "Alpha flow", "Beta map"]);
    expect(after.looking).toEqual([]);
    // Each idea's run started from the files its glance named, and wrote its prompt.
    expect(runner.prompts.map((j) => [j.kind, j.project.name, nameIn(j)])).toEqual([
      ["prompt", "beta", "Beta map"],
      ["prompt", "alpha", "Alpha screens"],
      ["prompt", "alpha", "Alpha flow"],
    ]);
    expect(runner.prompts[0]!.prompt).toContain("starting from Beta map.tsx.");
    expect(runner.prompts[0]!.schema).toBe(PROMPT_SCHEMA);
    expect(runner.prompts[0]!.quiet).toBe(QUIET);
    expect(after.ideas[0]).toMatchObject({
      prompt:
        "In ~/code/alpha, make a new Ponzu design called “Alpha screens”. Draw Alpha screens.",
    });
    expect(after.ideas[0]!.steps).toBeUndefined();

    // Soon after, opening the tab shows what it has without looking again.
    now += 60_000;
    expect((await service.refresh()).running).toBe(false);
    expect(runner.jobs).toHaveLength(2);

    // A new launch shows them at once, and remembers when it last looked.
    const again = new SuggestionService({
      bin: () => "/bin/claude",
      run: runner.run,
      home,
      file,
      now: () => now,
    });
    expect((await again.state()).ideas.map((i) => i.name)).toEqual([
      "Alpha screens",
      "Alpha flow",
      "Beta map",
    ]);
    expect((await again.refresh()).running).toBe(false);
    expect(JSON.parse(await readFile(file, "utf8")).ran).toBe(1_000_000);

    // A while later it looks again, for what the tab is short of: new ideas in front, one
    // named again moves up, not twice.
    now += 20 * 60_000;
    expect((await again.refresh()).running).toBe(true);
    await until(() => runner.jobs.length === 4);
    expect(glanceAt(runner, "alpha")!.prompt).toContain("suggest 3 designs");
    expect(glanceAt(runner, "beta")!.prompt).toContain("suggest 2 designs");
    // It hears what it offered last time.
    expect(glanceAt(runner, "alpha")!.prompt).toContain("“Alpha screens”, “Alpha flow”");
    runner.answer("alpha", ["Alpha flow", "Alpha brand"]);
    runner.fail("beta");
    await until(async () => !(await again.state()).running);
    expect((await again.state()).ideas.map((i) => i.name)).toEqual([
      "Alpha flow",
      "Alpha brand",
      "Alpha screens",
      "Beta map",
    ]);
  });

  test("two refreshes at once start one run", async () => {
    let jobs = 0;
    const held: (() => void)[] = [];
    const service = new SuggestionService({
      bin: () => "/bin/claude",
      // Each look for the agent waits to be let through.
      agents: () =>
        new Promise((done) =>
          held.push(() =>
            done([{ id: "claude", label: "Claude Code", found: true, connected: false }]),
          ),
        ),
      run: async () => {
        jobs++;
        return { ideas: [] };
      },
      home,
    });
    const first = service.refresh();
    const second = service.refresh();
    await until(() => held.length === 2);
    // The first finds the agent, and its run is over before the second has.
    held.shift()!();
    await until(() => jobs === 2);
    await Bun.sleep(20);
    const rest = setInterval(() => {
      while (held.length) held.shift()!();
    }, 1);
    await Promise.all([first, second]);
    await until(async () => !(await service.state()).running);
    clearInterval(rest);
    expect(jobs).toBe(2);
  });

  test("an idea the person started drops out", async () => {
    const runner = fakeRunner();
    const designs: {
      name: string;
      key: string;
      git?: { project?: string };
      busy?: string;
      created?: number;
    }[] = [];
    const service = new SuggestionService({
      bin: () => "/bin/codex",
      run: runner.run,
      home,
      designs: async () => designs,
    });
    designs.push({
      name: "Brand",
      key: "/x/brand.design",
      git: { project: "github.com/me/alpha" },
    });
    await service.refresh();
    await until(() => runner.jobs.length === 2);
    // The agent hears what the project already has.
    expect(glanceAt(runner, "alpha")!.prompt).toContain("“Brand”");
    expect(glanceAt(runner, "beta")!.prompt).not.toContain("“Brand”");
    runner.answer("alpha", ["Brand", "Every alpha screen", "Alpha flow"]);
    runner.answer("beta", []);
    await until(async () => !(await service.state()).running);
    expect((await service.state()).ideas.map((i) => i.name)).toEqual([
      "Every alpha screen",
      "Alpha flow",
    ]);
    // A design called what an idea is, by name or by folder, means it's started. While an
    // agent makes it, or for a while after, the idea stays for its card to show the design.
    const started: { name: string; key: string; git: { project: string }; busy?: string } = {
      name: "Untitled",
      key: "/x/every-alpha-screen.design",
      git: { project: "github.com/me/alpha" },
      busy: "claude",
    };
    designs.push(started);
    expect((await service.state()).ideas.map((i) => i.name)).toEqual([
      "Every alpha screen",
      "Alpha flow",
    ]);
    delete started.busy;
    expect((await service.state()).ideas.map((i) => i.name)).toEqual(["Alpha flow"]);
  });

  test("a design in another project doesn't stand for an idea", async () => {
    let now = 1_000_000;
    const runner = fakeRunner();
    // alpha has a "Brand" and a "Beta map" of its own; beta's ideas have those names too.
    const designs = [
      { name: "Brand", key: "/a/brand.design", git: { project: "github.com/me/alpha" } },
      { name: "Beta map", key: "/a/beta-map.design", git: { project: "github.com/me/alpha" } },
    ];
    const service = new SuggestionService({
      bin: () => "/bin/claude",
      run: runner.run,
      home,
      designs: async () => designs,
      now: () => now,
    });
    await service.refresh();
    await until(() => runner.jobs.length === 2);
    runner.answer("alpha", ["Brand", "Alpha flow"]);
    runner.answer("beta", ["Brand", "Beta map"]);
    await until(async () => !(await service.state()).running);
    const ideas = (await service.state()).ideas;
    expect(ideas.map((i) => [i.projectName, i.name]).sort()).toEqual([
      ["alpha", "Alpha flow"],
      ["beta", "Beta map"],
      ["beta", "Brand"],
    ]);
    // Once beta has its own "Brand", that idea is started, and later drops out.
    designs.push({
      name: "Brand",
      key: "/b/brand.design",
      git: { project: "github.com/me/beta" },
    });
    now += 60_000;
    expect((await service.state()).ideas.map((i) => [i.projectName, i.name]).sort()).toEqual([
      ["alpha", "Alpha flow"],
      ["beta", "Beta map"],
    ]);
  });

  test("a run tops the tab up to eight, and lets old ideas go", async () => {
    let now = 1_000_000;
    const runner = fakeRunner();
    const designs: { name: string; key: string; git?: { project?: string } }[] = [];
    const service = new SuggestionService({
      bin: () => "/bin/claude",
      run: runner.run,
      home,
      designs: async () => designs,
      now: () => now,
      every: 0,
    });
    const names = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p} ${i + 1}`);
    await service.refresh();
    await until(() => runner.jobs.length === 2);
    runner.answer("alpha", names("Alpha", 4));
    runner.answer("beta", names("Beta", 4));
    await until(async () => !(await service.state()).running);
    expect((await service.state()).ideas).toHaveLength(8);

    // A full tab doesn't run its agent at all.
    now += 1000;
    await service.refresh();
    await until(async () => !(await service.state()).running);
    expect(runner.jobs).toHaveLength(2);

    // One started is one short: the most recent project is asked for one.
    designs.push({
      name: "Beta 2",
      key: "/b/beta-2.design",
      git: { project: "github.com/me/beta" },
    });
    await service.refresh();
    await until(() => runner.jobs.length === 3);
    expect(runner.jobs.at(-1)!.project.name).toBe("alpha");
    expect(runner.jobs.at(-1)!.prompt).toContain("suggest one design");
    runner.answer("alpha", ["Alpha 5"]);
    await until(async () => !(await service.state()).running);

    // A week on, every idea makes way for new ones, and the glances still hear them all.
    now += STALE;
    await service.refresh();
    await until(() => runner.jobs.length === 5);
    expect(glanceAt(runner, "alpha")!.prompt).toContain("suggest 4 designs");
    expect(glanceAt(runner, "alpha")!.prompt).toContain("“Alpha 5”, “Alpha 1”");
    expect(glanceAt(runner, "beta")!.prompt).toContain("“Beta 1”");
    runner.answer("alpha", ["Alpha fresh"]);
    runner.answer("beta", []);
    await until(async () => !(await service.state()).running);
    expect((await service.state()).ideas.map((i) => i.name)).toEqual(["Alpha fresh"]);
  });

  test("an idea's card hears what its run reads; a run that fails is tried again, then let go", async () => {
    const held = new Map<string, () => void>();
    const tries = new Map<string, number>();
    const runner = fakeRunner({
      prompt: (job) => {
        const name = nameIn(job);
        tries.set(name, (tries.get(name) ?? 0) + 1);
        if (name === "Never") return Promise.reject(new Error("went quiet"));
        if (name === "Once" && tries.get(name) === 1)
          return Promise.reject(new Error("went quiet"));
        job.onStep?.({ verb: "find", what: "app/**" });
        job.onStep?.({ verb: "read", what: "app/home.tsx" });
        return new Promise((done) => held.set(name, () => done({ prompt: `Draw ${name}.` })));
      },
    });
    const service = new SuggestionService({ bin: () => "/bin/claude", run: runner.run, home });
    await service.refresh();
    await until(() => runner.jobs.length === 2);
    runner.answer("alpha", ["Home", "Once", "Never"]);
    runner.answer("beta", []);
    await until(() => held.size === 2);
    const writing = (await service.state()).ideas.find((i) => i.name === "Home");
    expect(writing?.prompt).toBe("");
    expect(writing?.steps).toEqual([
      { verb: "find", what: "app/**" },
      { verb: "read", what: "app/home.tsx" },
    ]);
    for (const go of held.values()) go();
    await until(async () => !(await service.state()).running);
    const ideas = (await service.state()).ideas;
    expect(ideas.map((i) => [i.name, i.prompt.endsWith(`Draw ${i.name}.`)])).toEqual([
      ["Home", true],
      ["Once", true],
    ]);
    expect([...tries]).toEqual([
      ["Home", 1],
      ["Once", 2],
      ["Never", 2],
    ]);
  });

  test("an idea's second try has only what's left of its time", async () => {
    const signals: AbortSignal[] = [];
    const runner = fakeRunner({
      prompt: (job) => {
        signals.push(job.signal);
        // The first try uses up its time; the second starts with none left, so it never runs.
        return new Promise((_, reject) =>
          job.signal.addEventListener("abort", () => reject(new Error("timed out"))),
        );
      },
    });
    const service = new SuggestionService({
      bin: () => "/bin/claude",
      run: runner.run,
      home,
      timeout: 30,
    });
    await service.refresh();
    await until(() => runner.jobs.length === 2);
    runner.answer("alpha", ["Slow"]);
    runner.answer("beta", []);
    await until(async () => !(await service.state()).running);
    expect(signals).toHaveLength(1);
    expect((await service.state()).ideas).toEqual([]);
  });

  test("a run that takes too long is stopped, quietly", async () => {
    let stopped = false;
    const service = new SuggestionService({
      bin: () => "/bin/claude",
      home,
      timeout: 20,
      run: (job) =>
        new Promise((_, reject) =>
          job.signal.addEventListener("abort", () => {
            stopped = true;
            reject(new Error("timed out"));
          }),
        ),
    });
    await service.refresh();
    await until(async () => !(await service.state()).running);
    expect(stopped).toBe(true);
    expect((await service.state()).ideas).toEqual([]);
  });
});

test("the person's other Macs can read this Mac's suggestions and ask it to look again", () => {
  const ask = (path: string, method = "GET", headers: Record<string, string> = {}) =>
    peerAllowed(new Request(`http://mac:7777${path}`, { method, headers }), path);
  expect(ask("/api/suggestions")).toBe(true);
  expect(ask("/api/suggestions/refresh", "POST")).toBe(true);
  expect(ask("/api/suggestions/refresh")).toBe(false);
  // Not a web page on the tailnet.
  expect(ask("/api/suggestions", "GET", { "sec-fetch-site": "cross-site" })).toBe(false);
});

test("the home screen asks for them, and refreshes with a POST from its own page", async () => {
  const root = await mkdtemp(join(tmpdir(), "ponzu-suggest-serve-"));
  const runner = fakeRunner();
  const ws = new LocalWorkspace({ cwd: root });
  const bare = serve(ws, { port: 0, root, spotlight: "roots" });
  const server = serve(ws, {
    port: 0,
    root,
    spotlight: "roots",
    suggest: { bin: () => "/bin/claude", run: runner.run, home },
  });
  try {
    // Without a way to run an agent there's nothing to suggest, and no tab.
    const none = await fetch(`http://127.0.0.1:${bare.port}/api/suggestions`);
    expect(await none.json()).toEqual({ agent: null, ideas: [], running: false, looking: [] });

    const base = `http://127.0.0.1:${server.port}`;
    expect(await (await fetch(`${base}/api/suggestions`)).json()).toEqual({
      agent: "claude",
      ideas: [],
      running: false,
      looking: [],
    });
    expect((await fetch(`${base}/api/suggestions/refresh`)).status).toBe(405);
    const page = { method: "POST", headers: { origin: "https://evil.example" } };
    expect((await fetch(`${base}/api/suggestions/refresh`, page)).status).toBe(403);
    const started = await fetch(`${base}/api/suggestions/refresh`, { method: "POST" });
    expect(((await started.json()) as { running: boolean }).running).toBe(true);
    await until(() => runner.jobs.length === 2);
    runner.answer("alpha", ["Alpha screens"]);
    runner.answer("beta", []);
    await until(async () => {
      const s = (await (await fetch(`${base}/api/suggestions`)).json()) as { running: boolean };
      return !s.running;
    });
    const done = (await (await fetch(`${base}/api/suggestions`)).json()) as {
      ideas: { name: string; project: string }[];
    };
    expect(done.ideas.map((i) => [i.name, i.project])).toEqual([["Alpha screens", alpha]]);
  } finally {
    server.stop(true);
    bare.stop(true);
    await ws.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("another Mac's home screen reads them, and asks for a look, through this Mac's relay", async () => {
  const root = await mkdtemp(join(tmpdir(), "ponzu-suggest-peer-"));
  const before = process.env.PONZU_TAILSCALE;
  // A Tailscale that lists one other Mac, "spare", at 127.0.0.1: a second server here.
  const bin = join(root, "tailscale");
  await writeFile(
    bin,
    `#!/bin/sh
echo '{"BackendState":"Running","Self":{"TailscaleIPs":["100.64.0.1"],"UserID":7},"Peer":{"a":{"HostName":"spare","TailscaleIPs":["127.0.0.1"],"UserID":7,"OS":"macOS","Online":true}}}'
`,
  );
  await chmod(bin, 0o755);
  process.env.PONZU_TAILSCALE = bin;
  const runner = fakeRunner();
  const spareWs = new LocalWorkspace({ cwd: join(root, "spare") });
  const hereWs = new LocalWorkspace({ cwd: join(root, "here") });
  const spare = serve(spareWs, {
    port: 0,
    root,
    spotlight: "roots",
    suggest: { bin: () => "/bin/claude", run: runner.run, home },
  });
  const here = serve(hereWs, {
    port: 0,
    root,
    spotlight: "roots",
    tailnet: true,
    tailnetPort: spare.port,
  });
  try {
    const base = `http://127.0.0.1:${here.port}/peers/spare/api/suggestions`;
    expect(await (await fetch(base)).json()).toMatchObject({ agent: "claude", ideas: [] });
    const started = await fetch(`${base}/refresh`, { method: "POST" });
    expect(((await started.json()) as { running: boolean }).running).toBe(true);
    await until(() => runner.jobs.length === 2);
    runner.answer("alpha", ["Alpha screens"]);
    runner.answer("beta", []);
    await until(async () => !((await (await fetch(base)).json()) as { running: boolean }).running);
    const done = (await (await fetch(base)).json()) as { ideas: { name: string }[] };
    expect(done.ideas.map((i) => i.name)).toEqual(["Alpha screens"]);
  } finally {
    here.stop(true);
    spare.stop(true);
    await spareWs.closeAll();
    await hereWs.closeAll();
    if (before === undefined) delete process.env.PONZU_TAILSCALE;
    else process.env.PONZU_TAILSCALE = before;
    await rm(root, { recursive: true, force: true });
  }
});
