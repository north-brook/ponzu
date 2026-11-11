import { type Dirent, lstatSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { MAX_WORKSPACE_BYTES, type SavedPoint, wipRef } from "../api/protocol.ts";
import { type AgentShell, text } from "./shell.ts";

/*
 * A design's work in progress: what is in its working folder and in no commit on GitHub. A
 * checkpoint saves it after each turn and before the sandbox sleeps, and a runner whose disk is
 * behind the checkpoint puts it back (docs/cloud.md, "Saving the sandbox").
 *
 * - A repo design's is a commit on the hidden ref `refs/ponzu/wip/<design id>`, pushed through
 *   the same credential path as the agent's own pushes: its parent is the checkout's HEAD (so
 *   commits not yet pushed travel with it) and its tree is the working tree, untracked files
 *   included and ignored ones not. It never touches the design's branch, the index or the
 *   person's history, and GitHub runs no workflow for it and lists it under no branch.
 * - A Scratch design's is a gzipped tar of its folder, uploaded with the checkpoint.
 *
 * Neither ever restores something older over something newer: a commit is put back only when the
 * branch has not moved on past it, the disk's own changes are stashed first (they stay in
 * `git stash list`), and a Scratch file newer on the disk than in the archive is kept.
 */

export interface WorkSaver {
  /** A cheap fingerprint of the work as it is: the same means there is nothing new to save. */
  stamp(): Promise<string>;
  /** Saves the work in progress as checkpoint `turn` would carry it. */
  save(turn: number): Promise<SavedWork>;
  /** Puts the checkpoint's work back over what the disk has. */
  restore(point: SavedPoint, archive: Uint8Array | null): Promise<RestoredWork>;
}

export interface SavedWork {
  wipCommit: string | null;
  workspace: Uint8Array | null;
  /** Files left out for their size, with it. */
  skipped: string[];
}

export type RestoredWork = { done: true; what: string } | { done: false; why: string };

export interface Limits {
  /** A file larger than this is left out. */
  fileBytes: number;
  /** Files are taken, in order, until they add up to this. */
  totalBytes: number;
}

export const LIMITS: Limits = { fileBytes: 5 * 1024 * 1024, totalBytes: 50 * 1024 * 1024 };

/** Runs the checkout's git (as the agent in the image) and answers what it printed. */
export type Git = (
  args: string[],
  opts?: { input?: Uint8Array; env?: Record<string, string> },
) => Promise<string>;

export function gitIn(shell: AgentShell, git: string, cwd: string): Git {
  return async (args, opts = {}) => text(await shell([git, ...args], { cwd, ...opts }));
}

/** Work in progress in a repo's checkout, on `refs/ponzu/wip/<design id>`. */
export class GitWork implements WorkSaver {
  private last: { key: string; commit: string } | null = null;

  constructor(
    private readonly opts: {
      cwd: string;
      designId: string;
      git: Git;
      limits?: Limits;
      log?(message: string): void;
    },
  ) {}

  private get ref(): string {
    return wipRef(this.opts.designId);
  }

  async stamp(): Promise<string> {
    const { git } = this.opts;
    const head = await this.head();
    if (!head) return "";
    // Every change against HEAD, and every untracked file, by size and time.
    const listed = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const paths = listed
      .split("\0")
      .filter(Boolean)
      .map((entry) => entry.slice(3));
    const sizes = paths.map((path) => {
      try {
        const stat = lstatSync(join(this.opts.cwd, path));
        return `${path}:${stat.size}:${stat.mtimeMs}`;
      } catch {
        return `${path}:gone`;
      }
    });
    return `${head}|${sizes.join("|")}`;
  }

  async save(turn: number): Promise<SavedWork> {
    const { git } = this.opts;
    const limits = this.opts.limits ?? LIMITS;
    const head = await this.head();
    if (!head) return { wipCommit: null, workspace: null, skipped: [] };
    // An index of its own, beside the checkout's, which it never touches: it is made again from
    // HEAD each time, and left in .git between saves.
    const env = { GIT_INDEX_FILE: await this.indexPath(), GIT_LITERAL_PATHSPECS: "1" };
    await git(["read-tree", "HEAD"], { env });
    // Against HEAD: changed, deleted and untracked files, but not ignored ones.
    const listed = await git(
      ["ls-files", "-z", "--modified", "--deleted", "--others", "--exclude-standard"],
      { env },
    );
    const take: string[] = [];
    const skipped: string[] = [];
    let total = 0;
    for (const path of [...new Set(listed.split("\0").filter(Boolean))].sort()) {
      let size = 0;
      try {
        size = lstatSync(join(this.opts.cwd, path)).size;
      } catch {
        take.push(path); // deleted: `add -A` records that
        continue;
      }
      if (size > limits.fileBytes || total + size > limits.totalBytes) {
        skipped.push(`${path} (${size} bytes)`);
        continue;
      }
      total += size;
      take.push(path);
    }
    if (take.length) {
      await git(["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], {
        env,
        input: Buffer.from(`${take.join("\0")}\0`),
      });
    }
    const tree = (await git(["write-tree"], { env })).trim();
    const key = `${head} ${tree}`;
    // Nothing new since the last save: the ref already has it.
    if (this.last?.key === key) return { wipCommit: this.last.commit, workspace: null, skipped };
    const message = [
      `ponzu: work in progress at turn ${turn}`,
      "",
      `Ponzu-Turn: ${turn}`,
      ...skipped.map((s) => `Ponzu-Skipped: ${s}`),
    ].join("\n");
    const commit = (await git(["commit-tree", tree, "-p", head, "-m", message])).trim();
    // A hidden ref, forced: it is this design's alone, and each save replaces the last.
    // `--no-verify`: the repo's pre-push hooks are for its branches.
    await git(["push", "--quiet", "--force", "--no-verify", "origin", `${commit}:${this.ref}`]);
    this.last = { key, commit };
    return { wipCommit: commit, workspace: null, skipped };
  }

  /** Where the saves' own index lives: inside .git, as an absolute path. */
  private async indexPath(): Promise<string> {
    const path = (await this.opts.git(["rev-parse", "--git-path", "ponzu-wip.index"])).trim();
    return isAbsolute(path) ? path : join(this.opts.cwd, path);
  }

  async restore(point: SavedPoint, _archive: Uint8Array | null = null): Promise<RestoredWork> {
    const { git } = this.opts;
    if (!point.wipCommit) return { done: false, why: "the checkpoint has no work in progress" };
    try {
      await git(["fetch", "--quiet", "--no-tags", "origin", `+${this.ref}:${this.ref}`]);
    } catch (err) {
      return { done: false, why: `${this.ref} could not be fetched: ${said(err)}` };
    }
    // The commit the checkpoint names; or, if a later save moved the ref past it, the ref.
    const saved = await commitOf(git, point.wipCommit);
    const wip = saved ?? (await commitOf(git, this.ref));
    if (!wip) return { done: false, why: `${this.ref} holds no commit` };
    const parent = (await git(["rev-parse", `${wip}^`])).trim();
    const head = await this.head();

    if (head !== parent) {
      // Only forward: the saved HEAD is the branch plus commits that were never pushed.
      const behind =
        head !== null &&
        (await git(["merge-base", "--is-ancestor", head, parent]).then(
          () => true,
          () => false,
        ));
      if (!behind)
        return {
          done: false,
          why: "the branch has moved on since the work in progress was saved; it stays on the ref",
        };
      await this.stashDisk(point.turn);
      await git(["merge", "--ff-only", "--quiet", parent]);
    }
    if ((await this.treeNow()) === (await git(["rev-parse", `${wip}^{tree}`])).trim())
      return { done: true, what: "the checkout already held it" };
    await this.stashDisk(point.turn);
    // The working tree as saved, over HEAD: the index is left as HEAD has it, so what was
    // uncommitted is uncommitted again and what was untracked is untracked.
    await git(["restore", `--source=${wip}`, "--worktree", "--", "."]);
    return { done: true, what: `restored ${wip.slice(0, 12)} over ${parent.slice(0, 12)}` };
  }

  /** What the disk has that no commit does, kept where git keeps it, before it is replaced. */
  private async stashDisk(turn: number): Promise<void> {
    const { git } = this.opts;
    const dirty = await git(["status", "--porcelain=v1", "--untracked-files=all"]);
    if (!dirty.trim()) return;
    await git([
      "stash",
      "push",
      "--include-untracked",
      "--quiet",
      "-m",
      `ponzu: what this disk had before turn ${turn}'s work was restored`,
    ]);
    this.opts.log?.("the disk's own changes were older than the checkpoint: they are in git stash");
  }

  /** The working tree as a tree object, as `save` would write it, without the size limits. */
  private async treeNow(): Promise<string> {
    const { git } = this.opts;
    const env = { GIT_INDEX_FILE: await this.indexPath() };
    await git(["read-tree", "HEAD"], { env });
    await git(["add", "-A"], { env });
    return (await git(["write-tree"], { env })).trim();
  }

  private head(): Promise<string | null> {
    return this.opts.git(["rev-parse", "--verify", "--quiet", "HEAD"]).then(
      (out) => out.trim() || null,
      () => null,
    );
  }
}

/** A Scratch design's folder, as an archive uploaded with each checkpoint. */
export class ScratchWork implements WorkSaver {
  constructor(
    private readonly opts: {
      cwd: string;
      /** Runs `tar` as the agent. */
      shell: AgentShell;
      limits?: Limits;
      maxBytes?: number;
    },
  ) {}

  async stamp(): Promise<string> {
    return this.list()
      .taken.map(({ path, size, mtime }) => `${path}:${size}:${mtime}`)
      .join("|");
  }

  async save(): Promise<SavedWork> {
    const { taken, skipped } = this.list();
    if (!taken.length) return { wipCommit: null, workspace: null, skipped };
    const archive = await this.opts.shell(
      ["tar", "-czf", "-", "-C", this.opts.cwd, "--null", "-T", "-"],
      { input: Buffer.from(`${taken.map((f) => f.path).join("\0")}\0`) },
    );
    const max = this.opts.maxBytes ?? MAX_WORKSPACE_BYTES;
    if (archive.byteLength > max)
      throw new Error(`The Scratch folder is ${archive.byteLength} bytes compressed, over ${max}.`);
    return { wipCommit: null, workspace: archive, skipped };
  }

  async restore(_point: SavedPoint, archive: Uint8Array | null): Promise<RestoredWork> {
    if (!archive) return { done: false, why: "the checkpoint has no Scratch files" };
    // A file newer on this disk than in the archive stays as it is.
    await this.opts.shell(
      [
        "/bin/sh",
        "-c",
        'mkdir -p "$1" && exec tar -xzf - -C "$1" --keep-newer-files --no-same-owner',
        "sh",
        this.opts.cwd,
      ],
      { input: archive },
    );
    return { done: true, what: "restored the Scratch folder" };
  }

  /** Every file in the folder, but `node_modules` and `.git`, within the limits. */
  private list() {
    const limits = this.opts.limits ?? LIMITS;
    const taken: { path: string; size: number; mtime: number }[] = [];
    const skipped: string[] = [];
    let total = 0;
    const walk = (dir: string) => {
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules" && entry.name !== ".git") walk(full);
          continue;
        }
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        const stat = lstatSync(full);
        const path = relative(this.opts.cwd, full);
        if (stat.size > limits.fileBytes || total + stat.size > limits.totalBytes) {
          skipped.push(`${path} (${stat.size} bytes)`);
          continue;
        }
        total += stat.size;
        taken.push({ path, size: stat.size, mtime: stat.mtimeMs });
      }
    };
    walk(this.opts.cwd);
    return { taken, skipped };
  }
}

async function commitOf(git: Git, rev: string): Promise<string | null> {
  return git(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]).then(
    (out) => out.trim() || null,
    () => null,
  );
}

function said(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
