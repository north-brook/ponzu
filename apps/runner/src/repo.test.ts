import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testSession } from "./api/fake.ts";
import { CheckoutError, checkout } from "./repo.ts";
import { agentShell, text } from "./save/shell.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ponzu-repo-"));
  dirs.push(dir);
  return dir;
}

/** A sandbox's HOME, and a repository on "GitHub" with one commit on main. */
async function world() {
  const home = await temp();
  const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
  // Awaited, never execFileSync: Bun 1.4.2's sync spawns can lose a child's exit in a
  // `bun test --parallel` worker and wait on it forever (oven-sh/bun#47257).
  const shell = agentShell(undefined, env);
  const git = async (args: string[], cwd?: string) =>
    text(await shell(["git", ...args], { cwd })).trim();
  const remote = join(await temp(), "fern.git");
  const seed = await temp();
  await git(["init", "--quiet", "--bare", "--initial-branch=main", remote]);
  await git(["init", "--quiet", "--initial-branch=main", seed]);
  await writeFile(join(seed, "README.md"), "Fern\n");
  await git(["add", "."], seed);
  await git(
    ["-c", "user.name=Seed", "-c", "user.email=seed@test", "commit", "--quiet", "-m", "Start"],
    seed,
  );
  await git(["push", "--quiet", remote, "main"], seed);
  const session = testSession({
    repo: { owner: "north", name: "fern", defaultBranch: "main" },
    branch: "pz/hero",
  });
  const root = join(home, "work");
  const opts = { root, helper: "!/opt/ponzu/helper", remote: () => remote, env };
  return { git, remote, seed, session, root, opts, home };
}

/** The credential helpers git asks for github.com, in order: an empty one clears those before it. */
async function helpers(git: (args: string[]) => Promise<string>): Promise<string[]> {
  return (
    await git(["config", "--global", "--null", "--get-all", "credential.https://github.com.helper"])
  )
    .split("\0")
    .slice(0, -1);
}

test("Scratch gets an empty folder and no git at all", async () => {
  const root = await temp();
  const dir = await checkout(testSession(), { root, helper: "!x" });
  expect(dir).toBe(join(root, "scratch"));
  expect(readdirSync(dir)).toEqual([]);
});

test("the first checkout clones and makes the canvas's branch from the default branch", async () => {
  const { git, session, opts, root, home } = await world();
  const dir = await checkout(session, opts);
  expect(dir).toBe(join(root, "fern"));
  expect(await git(["branch", "--show-current"], dir)).toBe("pz/hero");
  expect(await git(["rev-parse", "HEAD"], dir)).toBe(await git(["rev-parse", "origin/main"], dir));

  // Authored by the person, committed by the app, and github.com asks only Ponzu's helper.
  await writeFile(join(dir, "hero.html"), "<h1>Hi</h1>\n");
  await git(["add", "."], dir);
  await git(["commit", "--quiet", "-m", "Hero"], dir);
  expect(await git(["log", "-1", "--format=%an <%ae>|%cn <%ce>"], dir)).toBe(
    "Ada <1+ada@users.noreply.github.com>|ponzu[bot] <2+ponzu[bot]@users.noreply.github.com>",
  );
  expect(await helpers(git)).toEqual(["", "!/opt/ponzu/helper"]);
  expect(await git(["config", "--global", "credential.https://github.com.useHttpPath"])).toBe(
    "true",
  );
  // Nothing secret is written down.
  expect(await readFile(join(home, ".gitconfig"), "utf8")).not.toContain("ghs_");
});

test("a sandbox that slept keeps its checkout as it left it", async () => {
  const { git, session, opts } = await world();
  const dir = await checkout(session, opts);
  await writeFile(join(dir, "draft.txt"), "not committed\n");
  // Configuring twice leaves one helper, not two.
  expect(await checkout(session, opts)).toBe(dir);
  expect(existsSync(join(dir, "draft.txt"))).toBe(true);
  expect(await git(["branch", "--show-current"], dir)).toBe("pz/hero");
  expect(await helpers(git)).toEqual(["", "!/opt/ponzu/helper"]);
});

test("a clone cut off by a stop is made whole at the next start", async () => {
  const { git, session, opts, root } = await world();
  // What a clone killed early leaves: a .git with no remote and no branches.
  const dir = join(root, "fern");
  await mkdir(dir, { recursive: true });
  await git(["init", "--quiet", dir]);
  expect(await checkout(session, opts)).toBe(dir);
  expect(await git(["branch", "--show-current"], dir)).toBe("pz/hero");
  expect(await git(["rev-parse", "HEAD"], dir)).toBe(await git(["rev-parse", "origin/main"], dir));
  expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("Fern\n");
});

test("a branch already on GitHub is checked out, not made again", async () => {
  const { git, seed, remote, session, opts } = await world();
  await git(["switch", "--quiet", "-c", "pz/hero"], seed);
  await writeFile(join(seed, "hero.html"), "<h1>Earlier</h1>\n");
  await git(["add", "."], seed);
  await git(
    ["-c", "user.name=Seed", "-c", "user.email=seed@test", "commit", "--quiet", "-m", "Earlier"],
    seed,
  );
  await git(["push", "--quiet", remote, "pz/hero"], seed);

  const dir = await checkout(session, opts);
  expect(await git(["log", "-1", "--format=%s"], dir)).toBe("Earlier");
  expect(await git(["rev-parse", "--abbrev-ref", "@{upstream}"], dir)).toBe("origin/pz/hero");
});

test("a clone that fails says why", async () => {
  const { session, opts } = await world();
  const err = await checkout(session, { ...opts, remote: () => "/nowhere/fern.git" }).catch(
    (e) => e,
  );
  expect(err).toBeInstanceOf(CheckoutError);
  expect(err.message).toStartWith("Ponzu could not get north/fern:");
});

test("every git call goes through the git it is given, as the image's runs as the agent's user", async () => {
  const { git, session, opts } = await world();
  const bin = await temp();
  const log = join(bin, "calls");
  const wrapper = join(bin, "agent-git");
  await writeFile(wrapper, `#!/bin/sh\necho "$1" >> '${log}'\nexec git "$@"\n`, { mode: 0o755 });
  const dir = await checkout(session, { ...opts, git: wrapper });
  expect(await git(["branch", "--show-current"], dir)).toBe("pz/hero");
  const calls = (await readFile(log, "utf8")).trim().split("\n");
  expect(calls).toContain("config");
  expect(calls).toContain("clone");
  expect(calls).toContain("switch");
});
