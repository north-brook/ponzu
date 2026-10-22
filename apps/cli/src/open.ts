import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseOpenTarget, type Target } from "@ponzu/core";

/*
 * `ponzu open <owner>/<repo>[@ref]/<path>.design`: a design on GitHub, on your machine. Clones
 * the repo into ~/Ponzu/<owner>/<repo> (or reuses the clone there), checks out the ref, and
 * hands back the folder to serve. Takes the same paths as ponzu.design/gh, or a link to it or
 * to the repo on github.com.
 */

/** Runs git with these arguments in `cwd`, and resolves with its exit code. */
export type Git = (args: string[], cwd?: string) => Promise<number>;

export interface Opened {
  target: Target;
  /** The local clone. */
  clone: string;
  /** What to serve: the design, or the folder to find designs under. */
  path: string;
}

/** Where clones live: PONZU_CLONES, or ~/Ponzu. */
export function clonesDir(env = process.env): string {
  return env.PONZU_CLONES ?? join(homedir(), "Ponzu");
}

/**
 * Clone or update the repo `input` names, at its ref, and say what to serve. Throws a message
 * for the person when the input isn't a GitHub path or git fails.
 */
export async function openFromGitHub(
  input: string | undefined,
  git: Git,
  root = clonesDir(),
): Promise<Opened> {
  const target = input ? parseOpenTarget(input) : null;
  if (!target)
    throw new Error(
      `ponzu open takes a design on GitHub, like north-brook/ponzu/examples/kettle.design${input ? `, not "${input}"` : ""}.`,
    );
  const clone = join(root, target.owner, target.repo);
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
  if (target.ref && (await git(["checkout", "--quiet", target.ref, "--"], clone)) !== 0)
    throw new Error(`Couldn't check out ${target.ref} in ${clone}.`);
  const path = join(clone, target.kind === "design" ? target.path : target.prefix);
  if (!existsSync(path)) throw new Error(`${input} isn't in ${clone}.`);
  return { target, clone, path };
}

/** git, for real: its progress goes to the terminal. */
export const runGit: Git = async (args, cwd) => {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "inherit", stderr: "inherit" });
    return await proc.exited;
  } catch {
    return 127;
  }
};
