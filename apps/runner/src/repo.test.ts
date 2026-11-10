import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testSession } from "./api/fake.ts";
import { CheckoutError, checkout } from "./repo.ts";

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
  const git = (args: string[], cwd?: string) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  const remote = join(await temp(), "fern.git");
  const seed = await temp();
  git(["init", "--quiet", "--bare", "--initial-branch=main", remote]);
  git(["init", "--quiet", "--initial-branch=main", seed]);
  await writeFile(join(seed, "README.md"), "Fern\n");
  git(["add", "."], seed);
  git(
    ["-c", "user.name=Seed", "-c", "user.email=seed@test", "commit", "--quiet", "-m", "Start"],
    seed,
  );
  git(["push", "--quiet", remote, "main"], seed);
  const session = testSession({
    repo: { owner: "north", name: "fern", defaultBranch: "main" },
    branch: "pz/hero",
  });
  const root = join(home, "work");
  const opts = { root, helper: "!/opt/ponzu/helper", remote: () => remote, env };
  return { git, remote, seed, session, root, opts, home };
}

/** The credential helpers git asks for github.com, in order: an empty one clears those before it. */
function helpers(git: (args: string[]) => string): string[] {
  return git(["config", "--global", "--null", "--get-all", "credential.https://github.com.helper"])
    .split("\0")
    .slice(0, -1);
}

test("Scratch gets an empty folder and no git at all", async () => {
  const root = await temp();
  const dir = await checkout(testSession(), { root, helper: "!x" });
  expect(dir).toBe(join(root, "scratch"));
  expect(readdirSync(dir)).toEqual([]);
});

test("the first checkout clones and makes the design's branch from the default branch", async () => {
  const { git, session, opts, root, home } = await world();
  const dir = await checkout(session, opts);
  expect(dir).toBe(join(root, "fern"));
  expect(git(["branch", "--show-current"], dir)).toBe("pz/hero");
  expect(git(["rev-parse", "HEAD"], dir)).toBe(git(["rev-parse", "origin/main"], dir));

  // Authored by the person, committed by the app, and github.com asks only Ponzu's helper.
  await writeFile(join(dir, "hero.html"), "<h1>Hi</h1>\n");
  git(["add", "."], dir);
  git(["commit", "--quiet", "-m", "Hero"], dir);
  expect(git(["log", "-1", "--format=%an <%ae>|%cn <%ce>"], dir)).toBe(
    "Ada <1+ada@users.noreply.github.com>|ponzu[bot] <2+ponzu[bot]@users.noreply.github.com>",
  );
  expect(helpers(git)).toEqual(["", "!/opt/ponzu/helper"]);
  expect(git(["config", "--global", "credential.https://github.com.useHttpPath"])).toBe("true");
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
  expect(git(["branch", "--show-current"], dir)).toBe("pz/hero");
  expect(helpers(git)).toEqual(["", "!/opt/ponzu/helper"]);
});

test("a branch already on GitHub is checked out, not made again", async () => {
  const { git, seed, remote, session, opts } = await world();
  git(["switch", "--quiet", "-c", "pz/hero"], seed);
  await writeFile(join(seed, "hero.html"), "<h1>Earlier</h1>\n");
  git(["add", "."], seed);
  git(
    ["-c", "user.name=Seed", "-c", "user.email=seed@test", "commit", "--quiet", "-m", "Earlier"],
    seed,
  );
  git(["push", "--quiet", remote, "pz/hero"], seed);

  const dir = await checkout(session, opts);
  expect(git(["log", "-1", "--format=%s"], dir)).toBe("Earlier");
  expect(git(["rev-parse", "--abbrev-ref", "@{upstream}"], dir)).toBe("origin/pz/hero");
});

test("a clone that fails says why", async () => {
  const { session, opts } = await world();
  const err = await checkout(session, { ...opts, remote: () => "/nowhere/fern.git" }).catch(
    (e) => e,
  );
  expect(err).toBeInstanceOf(CheckoutError);
  expect(err.message).toStartWith("Ponzu could not get north/fern:");
});
