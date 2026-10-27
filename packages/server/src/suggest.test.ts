import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalWorkspace } from "./index.ts";
import { peerAllowed, serve } from "./serve.ts";
import {
  cwdOf,
  ideasFrom,
  parseJson,
  promptFor,
  type RecentProject,
  recentProjects,
  SuggestionService,
  type SuggestJob,
  shares,
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
  });

  test("the prompt names the folder and the designs it already has, and no branch or time", () => {
    const p = promptFor(
      seekle,
      2,
      { designs: ["Brand"], suggested: ["Friends leaderboard"] },
      "/Users/me",
    );
    expect(p).toContain("In ~/code/seekle, put this in a new Ponzu design called “<name>”:");
    expect(p).toContain("suggest 2 designs");
    expect(p).toContain("so suggest others: “Brand”.");
    expect(p).toContain("not new takes on them: “Friends leaderboard”.");
    expect(p).toContain("Leave out branches, worktrees and time estimates.");
  });

  test("ideas that hold up, tied to the project, with the opening a prompt was asked for", () => {
    const ideas = ideasFrom(
      {
        ideas: [
          {
            name: "Every Seekle screen",
            project: "/somewhere/else",
            card: "Rebuild every screen in apps/native.",
            prompt:
              "In ~/code/seekle, put this in a new Ponzu design called “Every Seekle screen”: rebuild them.",
          },
          { name: "", card: "x", prompt: "y" },
          { name: "every seekle  screen", card: "Again.", prompt: "Again." },
          { name: "Friends leaderboard", card: "Three takes.", prompt: "Explore three takes." },
          { name: "One too many", card: "c", prompt: "p" },
        ],
      },
      seekle,
      { count: 2, found: 5, home: "/Users/me" },
    );
    expect(ideas).toEqual([
      {
        name: "Every Seekle screen",
        project: seekle.root,
        projectId: "github.com/me/seekle",
        projectName: "seekle",
        card: "Rebuild every screen in apps/native.",
        prompt:
          "In ~/code/seekle, put this in a new Ponzu design called “Every Seekle screen”: rebuild them.",
        found: 5,
      },
      {
        name: "Friends leaderboard",
        project: seekle.root,
        projectId: "github.com/me/seekle",
        projectName: "seekle",
        card: "Three takes.",
        prompt:
          "In ~/code/seekle, put this in a new Ponzu design called “Friends leaderboard”: Explore three takes.",
        found: 5,
      },
    ]);
    expect(ideasFrom(null, seekle, { count: 2, found: 0 })).toEqual([]);
    expect(ideasFrom({ ideas: "no" }, seekle, { count: 2, found: 0 })).toEqual([]);
  });

  test("an answer's JSON, alone or wrapped in prose", () => {
    expect(parseJson('{"ideas":[]}')).toEqual({ ideas: [] });
    expect(parseJson('Here:\n```json\n{"ideas":[1]}\n```')).toEqual({ ideas: [1] });
    expect(parseJson("nothing")).toBeNull();
  });
});

/** Answers each project's job with ideas named after it, when told to. */
function fakeRunner() {
  const jobs: SuggestJob[] = [];
  const waiting = new Map<string, (answer: unknown) => void>();
  const failing = new Map<string, (err: Error) => void>();
  const run = (job: SuggestJob) =>
    new Promise<unknown>((resolve, reject) => {
      jobs.push(job);
      waiting.set(job.project.name, resolve);
      failing.set(job.project.name, reject);
    });
  const answer = (name: string, ideas: string[]) =>
    waiting.get(name)?.({
      ideas: ideas.map((n) => ({ name: n, project: "", card: `${n}.`, prompt: `Draw ${n}.` })),
    });
  const fail = (name: string) => failing.get(name)?.(new Error("not signed in"));
  return { jobs, run, answer, fail };
}

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
    expect(await none.refresh()).toEqual({ agent: null, ideas: [], running: false });
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
    expect(await none.refresh()).toEqual({ agent: null, ideas: [], running: false });
    expect(runner.jobs).toHaveLength(0);
    // The agent's own CLI is asked for its flags: one that doesn't answer has none of them.
    const missing = new SuggestionService({ bin: () => join(home, "no-such-cli"), home });
    expect((await missing.state()).agent).toBeNull();
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
    expect(await service.state()).toEqual({ agent: "claude", ideas: [], running: false });

    expect((await service.refresh()).running).toBe(true);
    await until(() => runner.jobs.length === 2);
    expect(runner.jobs.map((j) => [j.agent, j.bin, j.project.root])).toEqual([
      ["claude", "/bin/claude", alpha],
      ["claude", "/bin/claude", beta],
    ]);
    expect(runner.jobs[0]!.prompt).toContain("suggest 4 designs");
    // Opening the tab again while it runs starts nothing more.
    await service.refresh();
    expect(runner.jobs).toHaveLength(2);

    runner.answer("beta", ["Beta map"]);
    await until(async () => (await service.state()).ideas.length === 1);
    runner.answer("alpha", ["Alpha screens", "Alpha flow"]);
    await until(async () => !(await service.state()).running);
    const after = await service.state();
    expect(after.ideas.map((i) => i.name)).toEqual(["Alpha screens", "Alpha flow", "Beta map"]);

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

    // A while later it looks again: new ideas in front, one named again moves up, not twice.
    now += 20 * 60_000;
    expect((await again.refresh()).running).toBe(true);
    await until(() => runner.jobs.length === 4);
    // It hears what it offered last time.
    expect(runner.jobs[2]!.prompt).toContain("“Alpha screens”, “Alpha flow”");
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
    expect(runner.jobs[0]!.prompt).toContain("“Brand”");
    expect(runner.jobs[1]!.prompt).not.toContain("“Brand”");
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

test("another Mac can't ask for this Mac's suggestions", () => {
  const get = (path: string, method = "GET") =>
    peerAllowed(new Request(`http://mac:7777${path}`, { method }), path);
  expect(get("/api/suggestions")).toBe(false);
  expect(get("/api/suggestions/refresh", "POST")).toBe(false);
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
    expect(await none.json()).toEqual({ agent: null, ideas: [], running: false });

    const base = `http://127.0.0.1:${server.port}`;
    expect(await (await fetch(`${base}/api/suggestions`)).json()).toEqual({
      agent: "claude",
      ideas: [],
      running: false,
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
