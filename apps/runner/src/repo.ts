import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { RunnerSession } from "./api/protocol.ts";

export interface CheckoutOptions {
  /** Where checkouts live: the repo goes in `<root>/<name>`, Scratch in `<root>/scratch`. */
  root: string;
  /** The command git runs as its credential helper for github.com, which asks the runner. */
  helper: string;
  /** Where to clone from. GitHub, unless a test says otherwise. */
  remote?: (repo: NonNullable<RunnerSession["repo"]>) => string;
  /** The environment git runs in: its HOME holds the global config written here. */
  env?: NodeJS.ProcessEnv;
  /**
   * The git to run, when it is not the one on the PATH: in the sandbox image, one that runs as
   * the agent's user, so the checkout and the global config written here are the agent's.
   */
  git?: string;
}

/** Why the checkout failed, in words for the thread. */
export class CheckoutError extends Error {
  override name = "CheckoutError";
}

/**
 * Get the design's working directory ready, and return it. For a repo: git's identity and
 * credential helper, the clone (or, when the disk kept it, a fetch), and the design's branch,
 * made from the default branch the first time. Work already on disk is never reset: a sandbox
 * that slept comes back to the checkout it left. Scratch gets an empty folder.
 */
export async function checkout(session: RunnerSession, opts: CheckoutOptions): Promise<string> {
  const { repo, branch } = session;
  if (!repo || !branch) {
    const dir = join(opts.root, "scratch");
    await mkdir(dir, { recursive: true });
    return dir;
  }
  const git = (args: string[], cwd?: string) =>
    run(opts.git ?? "git", args, { cwd, env: opts.env });
  await configure(session, opts.helper, git);

  const dir = join(opts.root, repo.name);
  const url = opts.remote?.(repo) ?? `https://github.com/${repo.owner}/${repo.name}.git`;
  try {
    if (existsSync(join(dir, ".git"))) {
      // Without an `origin` (a clone cut off early), the repair below adds it.
      const hasOrigin = await git(["remote"], dir).then(
        (out) => out.split("\n").includes("origin"),
        () => false,
      );
      if (hasOrigin) await git(["fetch", "--quiet", "origin"], dir);
    } else {
      await mkdir(opts.root, { recursive: true });
      await git(["clone", "--quiet", url, dir]);
    }
  } catch (err) {
    throw new CheckoutError(`Ponzu could not get ${repo.owner}/${repo.name}: ${said(err)}`);
  }

  const has = (ref: string) =>
    git(["rev-parse", "--verify", "--quiet", ref], dir).then(
      () => true,
      () => false,
    );
  // A clone cut off by a stop (the runner restarted under it) leaves a `.git` with no remote or
  // none of its branches: make it whole again rather than fail at every start after.
  if (!(await has(`refs/remotes/origin/${repo.defaultBranch}`))) {
    try {
      await git(["remote", "set-url", "origin", url], dir).catch(() =>
        git(["remote", "add", "origin", url], dir),
      );
      await git(["fetch", "--quiet", "origin", "+refs/heads/*:refs/remotes/origin/*"], dir);
    } catch (err) {
      throw new CheckoutError(`Ponzu could not get ${repo.owner}/${repo.name}: ${said(err)}`);
    }
  }
  try {
    if ((await git(["branch", "--show-current"], dir)).trim() === branch) return dir;
    if (await has(`refs/heads/${branch}`)) await git(["switch", "--quiet", branch], dir);
    else if (await has(`refs/remotes/origin/${branch}`))
      await git(["switch", "--quiet", "--track", `origin/${branch}`], dir);
    else
      await git(
        ["switch", "--quiet", "--no-track", "-c", branch, `origin/${repo.defaultBranch}`],
        dir,
      );
  } catch (err) {
    throw new CheckoutError(`Ponzu could not check out ${branch}: ${said(err)}`);
  }
  return dir;
}

/**
 * The global git config the agent's own git uses too. Commits are authored by the person and
 * committed by the app (`author.*` and `committer.*`, which git reads before `user.*`).
 * github.com asks the credential helper, by repository path, and nothing else: no token is
 * written down, and no other helper is asked.
 */
async function configure(
  session: RunnerSession,
  helper: string,
  git: (args: string[]) => Promise<string>,
): Promise<void> {
  const set = (key: string, value: string) => git(["config", "--global", key, value]);
  await set("author.name", session.author.name);
  await set("author.email", session.author.email);
  await set("committer.name", session.committer.name);
  await set("committer.email", session.committer.email);
  await set("push.autoSetupRemote", "true");
  const key = "credential.https://github.com.helper";
  await git(["config", "--global", "--unset-all", key]).catch(() => {});
  // An empty helper first clears any that a system or image config lists.
  await git(["config", "--global", "--add", key, ""]);
  await git(["config", "--global", "--add", key, helper]);
  await set("credential.https://github.com.useHttpPath", "true");
}

function run(
  git: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      git,
      args,
      {
        cwd: opts.cwd,
        env: { ...(opts.env ?? process.env), GIT_TERMINAL_PROMPT: "0" },
        timeout: 5 * 60_000,
      },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr.trim().split("\n").at(-1) || err.message));
        else resolve(stdout);
      },
    );
  });
}

function said(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
