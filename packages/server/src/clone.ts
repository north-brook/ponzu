import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseOpenTarget, parseTarget, type Target } from "@ponzu/core/github";

/*
 * A design on GitHub, on this machine: clone its repo into ~/Ponzu/<owner>/<repo> (or fetch the
 * clone already there), check out the ref, and say which folder to open. `ponzu open` in the CLI
 * and `ponzu://open` in the Mac app both come through here.
 *
 * Everything that names the design comes from a link someone else wrote, so it's checked before
 * git sees it: owner and repo by GitHub's name rules, the ref by git's (and never an option), and
 * the path must end in .design and stay inside the clone. git runs from an argument list, never a
 * shell.
 */

/** Runs git with these arguments in `cwd`, and resolves with its exit code. */
export type Git = (args: string[], cwd?: string) => Promise<number>;

export interface Cloned {
  target: Target;
  /** The local clone. */
  clone: string;
  /** What to open: the design, or for a repo or folder, the folder to find designs under. */
  path: string;
}

/** Where clones live: PONZU_CLONES, or ~/Ponzu. */
export function clonesDir(env: Record<string, string | undefined> = process.env): string {
  return env.PONZU_CLONES ?? join(homedir(), "Ponzu");
}

/**
 * `ponzu://open?repo=<owner>/<repo>&ref=<ref>&path=<path>.design`, as ponzu.design's Open in
 * Ponzu button sends it. Null for anything else: another host, a missing repo, or a path that
 * isn't a design.
 */
export function parseOpenUrl(raw: string): Extract<Target, { kind: "design" }> | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "ponzu:") return null;
  // `ponzu://open?…` puts "open" in the host; `ponzu:open?…` in the path.
  const action = url.hostname || url.pathname.replace(/^\/+|\/+$/g, "");
  if (action !== "open") return null;
  const repo = url.searchParams.get("repo") ?? "";
  const ref = url.searchParams.get("ref") ?? "";
  const path = url.searchParams.get("path") ?? "";
  const [owner, name, ...extra] = repo.split("/");
  if (!owner || !name || extra.length || !path.endsWith(".design")) return null;
  // parseTarget's checks, on segments already decoded: no percent-decoding twice.
  const target = parseTarget(
    [owner, ref ? `${name}@${ref}` : name, ...path.split("/")].map(encodeURIComponent),
  );
  return target?.kind === "design" && !target.extra ? target : null;
}

/**
 * Clone or update the repo `target` names, at its ref, and say what to open. Throws a message for
 * the person when git fails or the design isn't there.
 */
export async function cloneTarget(target: Target, git: Git, root = clonesDir()): Promise<Cloned> {
  const clone = join(root, target.owner, target.repo);
  // parseTarget keeps names to [A-Za-z0-9_.-] and refuses . and .., but check the result anyway.
  if (!inside(root, clone)) throw new Error(`${target.owner}/${target.repo} isn't a repo name.`);
  const url = `https://github.com/${target.owner}/${target.repo}.git`;
  if (existsSync(join(clone, ".git"))) {
    // Someone's own clone may have work in it: fetch, and switch only when asked to.
    if ((await git(["fetch", "--quiet", "origin"], clone)) !== 0)
      throw new Error(`Couldn't update ${clone} from ${url}.`);
  } else {
    await mkdir(dirname(clone), { recursive: true });
    if ((await git(["clone", "--", url, clone])) !== 0)
      throw new Error(`Couldn't clone ${url}. Is the repo public, and is git installed?`);
  }
  // `--` after the ref: it's a revision, never a path, and parseTarget refuses a leading dash.
  if (target.ref && (await git(["checkout", "--quiet", target.ref, "--"], clone)) !== 0)
    throw new Error(`Couldn't check out ${target.ref} in ${clone}.`);
  const want = target.kind === "design" ? target.path : target.prefix;
  const path = resolve(clone, want);
  if (!inside(clone, path)) throw new Error(`${want} isn't inside ${clone}.`);
  if (!existsSync(path)) throw new Error(`${want || "That folder"} isn't in ${clone}.`);
  // A symlink in the repo could point out of it: follow it, and look again.
  if (!inside(realpathSync(clone), realpathSync(path)))
    throw new Error(`${want} points outside ${clone}.`);
  return { target, clone, path };
}

/** `ponzu open`'s argument: a GitHub path or link, cloned and ready to serve. */
export async function openFromGitHub(
  input: string | undefined,
  git: Git,
  root = clonesDir(),
): Promise<Cloned> {
  const target = input ? parseOpenTarget(input) : null;
  if (!target)
    throw new Error(
      `ponzu open takes a design on GitHub, like north-brook/ponzu/examples/kettle.design${input ? `, not "${input}"` : ""}.`,
    );
  return cloneTarget(target, git, root);
}

/** Whether `path` is `dir` or under it. */
function inside(dir: string, path: string): boolean {
  const rel = relative(resolve(dir), resolve(path));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep));
}

/** git, for real, from an argument list: `inherit` shows its progress in a terminal. */
export function spawnGit(stdio: "inherit" | "ignore" = "inherit"): Git {
  return (args, cwd) =>
    new Promise((done) => {
      const proc = spawn("git", args, {
        cwd,
        stdio: ["ignore", stdio, stdio],
        // No prompt for credentials: these are public repos, and nobody may be at a terminal.
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      proc.on("error", () => done(127));
      proc.on("close", (code) => done(code ?? 1));
    });
}
