import { ShellError, text } from "./save/shell.ts";
import type { Git } from "./save/work.ts";

/*
 * Getting a design's commits to GitHub without relying on the agent (docs/cloud.md, "Git").
 * The agent commits and pushes as it goes, but a push can fail (GitHub refused a token it had
 * just minted: "Repository not found"), and an agent can forget, give up or be cut off. So the
 * runner pushes the design's branch itself at the end of every turn, before the sandbox sleeps,
 * when it starts, and when a person presses Create PR while GitHub lacks the commits. It pushes
 * with plain git through the same credential helper as the agent, never forces, and tries a
 * failure that may pass again a few times, giving the token back between tries so the next one
 * is new. What it could not push, and why, goes to the API with the runner's state and, when it
 * gives up, into the thread.
 */

/** Why a push failed, in kinds the runner treats differently. */
export type PushFailureKind =
  /** GitHub's branch has commits this one does not: pushing would throw them away. */
  | "diverged"
  /** GitHub refused it for good: a rule, a protected branch, a workflow file the App may not write. */
  | "refused"
  /** It may pass on another try: the token, the network, GitHub itself. */
  | "transient";

export interface PushFailure {
  kind: PushFailureKind;
  /** git's own words, its last few lines. Never a secret: git does not print the token. */
  said: string;
}

export interface PushOutcome {
  /** Commits on the branch that GitHub does not have, after this. */
  unpushed: number;
  /** Commits this push put on GitHub. */
  pushed: number;
  /** Null when there was nothing to push or it went. */
  failure: PushFailure | null;
}

export interface BranchPushOptions {
  /** The checkout's git, as the agent (`gitIn`). */
  git: Git;
  /** The design's branch. */
  branch: string;
  defaultBranch: string;
  /**
   * Gives back the token GitHub refused, so the next try mints a new one: git asks its helper to
   * erase only after a 401, never after the 404 GitHub answers for a token it will not honour.
   */
  erase(reason: string): Promise<void>;
  /** A structured line for the journal. */
  event(name: string, fields: Record<string, unknown>): void;
  /**
   * Whether the design's pull request was merged: a branch GitHub no longer has is then one that
   * was deleted after its merge, not one to push again.
   */
  merged?(): boolean;
  /** Waits between tries of a failure that may pass. */
  waitsMs?: number[];
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

/** About half a minute in all: long enough for GitHub to honour a new token, short for a turn's end. */
export const PUSH_WAITS_MS = [2_000, 5_000, 10_000, 15_000];

export class BranchPush {
  private readonly waits: number[];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly opts: BranchPushOptions) {
    this.waits = opts.waitsMs ?? PUSH_WAITS_MS;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = opts.now ?? Date.now;
  }

  get branchName(): string {
    return this.opts.branch;
  }

  /**
   * Commits on the design's branch that GitHub does not have, as the checkout last knew GitHub:
   * beyond `origin/<branch>` when that is in its history, else beyond the default branch, and
   * none for a branch deleted on GitHub after it was pushed. No network.
   */
  async unpushed(): Promise<number> {
    const local = `refs/heads/${this.opts.branch}`;
    if (!(await this.has(local))) return 0;
    const remote = `refs/remotes/origin/${this.opts.branch}`;
    const tracked = await this.has(remote);
    // Pushed once and gone from GitHub since (merged and deleted, by Ponzu's Merge or the repo's
    // setting, or by a person): not the runner's to bring back.
    if (!tracked && (await this.deletedOnGithub())) return 0;
    const base =
      tracked && (await this.isAncestor(remote, local))
        ? remote
        : `refs/remotes/origin/${this.opts.defaultBranch}`;
    if (!(await this.has(base))) return 0;
    return this.count(`${base}..${local}`);
  }

  /** The commit the branch is at here, or null when there is no such branch. */
  async head(): Promise<string | null> {
    try {
      return text(
        await this.opts.git(["rev-parse", "--verify", "--quiet", `refs/heads/${this.opts.branch}`]),
      ).trim();
    } catch {
      return null;
    }
  }

  /**
   * Push the design's branch when it has commits GitHub lacks, trying a failure that may pass
   * again (`waitsMs`) until `deadline`. Never forces: a branch GitHub moved on past is reported,
   * not overwritten. A branch GitHub already has at this commit is left alone, so one deleted on
   * GitHub after it was merged is not put back; new commits on it are pushed, as the agent's own
   * push would.
   */
  async push(opts: { deadline?: number } = {}): Promise<PushOutcome> {
    const { branch, defaultBranch } = this.opts;
    const local = `refs/heads/${branch}`;
    const nothing: PushOutcome = { unpushed: 0, pushed: 0, failure: null };
    if (!(await this.has(local))) return nothing;
    const base = `refs/remotes/origin/${defaultBranch}`;
    // Nothing of the design's own yet: nothing to push, and nothing for a pull request.
    if ((await this.has(base)) && (await this.count(`${base}..${local}`)) === 0) return nothing;
    const remote = `refs/remotes/origin/${branch}`;
    if (await this.has(remote)) {
      // GitHub had this very commit when the checkout last heard: nothing it lacks.
      if ((await this.sha(remote)) === (await this.sha(local))) return nothing;
    } else if (await this.deletedOnGithub()) {
      return nothing;
    }
    const before = await this.unpushed();
    let failure: PushFailure | null = null;
    for (let attempt = 0; ; attempt++) {
      const started = this.now();
      try {
        await this.opts.git(["push", "--porcelain", "-u", "origin", `${local}:${local}`]);
        this.opts.event("git_push", { branch, attempt, ok: true, ms: this.now() - started });
        return { unpushed: 0, pushed: before, failure: null };
      } catch (err) {
        failure = classify(err);
        this.opts.event("git_push", {
          branch,
          attempt,
          ok: false,
          kind: failure.kind,
          said: failure.said,
          ms: this.now() - started,
        });
      }
      const wait = this.waits[attempt];
      if (failure.kind !== "transient" || wait === undefined) break;
      if (opts.deadline !== undefined && this.now() + wait > opts.deadline) break;
      // The token may be one GitHub will not honour: the next try asks for a new one.
      await this.opts
        .erase(`git push failed: ${failure.said.split("\n").at(-1) ?? ""}`)
        .catch(() => {});
      await this.sleep(wait);
    }
    return { unpushed: await this.unpushed(), pushed: 0, failure };
  }

  /**
   * The branch was on GitHub once and is not now, as far as the checkout knows: it has an
   * upstream but no remote-tracking ref (a fetch pruned it), or the design's pull request was
   * merged (`merged`), after which GitHub or Ponzu deletes the branch.
   */
  private async deletedOnGithub(): Promise<boolean> {
    if (this.opts.merged?.()) return true;
    return this.opts.git(["config", "--get", `branch.${this.opts.branch}.merge`]).then(
      (out) => text(out).trim() !== "",
      () => false,
    );
  }

  private async sha(ref: string): Promise<string> {
    return text(await this.opts.git(["rev-parse", "--verify", ref])).trim();
  }

  private has(ref: string): Promise<boolean> {
    return this.opts.git(["rev-parse", "--verify", "--quiet", ref]).then(
      () => true,
      () => false,
    );
  }

  private isAncestor(a: string, b: string): Promise<boolean> {
    return this.opts.git(["merge-base", "--is-ancestor", a, b]).then(
      () => true,
      () => false,
    );
  }

  private async count(range: string): Promise<number> {
    return Number(text(await this.opts.git(["rev-list", "--count", range])).trim()) || 0;
  }
}

/** What a failed `git push --porcelain` says about whether to try again. */
export function classify(err: unknown): PushFailure {
  const out = err instanceof ShellError ? `${err.stdout}\n${err.stderr}` : String(err);
  const lines = out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^To /.test(line) && line !== "Done");
  const said = lines.slice(-3).join("\n") || (err instanceof Error ? err.message : String(err));
  if (/\[rejected\]|non-fast-forward|fetch first|stale info/i.test(out)) {
    return { kind: "diverged", said };
  }
  // Another push to the branch landed at the same moment (the agent's): GitHub's ref was locked.
  if (/failed to update ref|cannot lock ref|incorrect old value/i.test(out)) {
    return { kind: "transient", said };
  }
  if (
    /protected branch|GH0\d\d|rule violations|refusing to allow|remote rejected|pre-receive hook declined/i.test(
      out,
    )
  ) {
    return { kind: "refused", said };
  }
  return { kind: "transient", said };
}

/** What the thread says when the runner gives up on a push: the product's words, then git's. */
export function pushFailureText(
  failure: PushFailure,
  where: { branch: string; repo: string; unpushed: number },
): string {
  const commits = where.unpushed === 1 ? "1 commit" : `${where.unpushed} commits`;
  const safe = `${commits} on ${where.branch} ${where.unpushed === 1 ? "is" : "are"} safe in this design's sandbox`;
  const said = failure.said.split("\n").at(-1) ?? "";
  switch (failure.kind) {
    case "diverged":
      return `${where.branch} on GitHub has commits this design doesn't, so Ponzu didn't push over them. ${safe}. Ask Claude to bring in what's on GitHub and push again.`;
    case "refused":
      return `GitHub refused the push to ${where.branch} in ${where.repo} (${said}). ${safe}. Ask Claude to fix what GitHub objects to and push again.`;
    case "transient":
      return `Ponzu couldn't push ${where.branch} to ${where.repo} (${said}). ${safe}: Ponzu tries again when Claude's next turn ends, and Create PR tries again too.`;
  }
}
