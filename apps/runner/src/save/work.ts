import { type Dirent, lstatSync, readdirSync, readFileSync, type Stats } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { MAX_WORKSPACE_BYTES, type SavedPoint, wipRef } from "../api/protocol.ts";
import { fingerprint, type HashSkipped } from "./fingerprint.ts";
import { type AgentShell, text, UNPACK_KEEPING_NEWER } from "./shell.ts";

/*
 * A canvas's work in progress: what is in its working folder and in no commit on GitHub. A
 * checkpoint saves it after each turn and before the sandbox sleeps, and a runner whose disk is
 * behind the checkpoint puts it back (docs/cloud.md, "Saving the sandbox").
 *
 * - A repo canvas's is a commit whose parent is the checkout's HEAD (so commits not yet pushed
 *   travel with it) and whose tree is the working tree, untracked files included and ignored
 *   ones not. It is made with an index of its own, so the canvas's branch, the index and the
 *   person's history are never touched, and it goes nowhere on GitHub: a git bundle of it (the
 *   commits GitHub does not have) is the checkpoint's workspace archive, kept where no client
 *   reads it. A ref on the repository would be readable by everyone who can read the repository
 *   (everyone, for a public one), and writable by every other canvas's agent there.
 * - A Scratch canvas's is a gzipped tar of its folder.
 *
 * Neither ever carries a secret: a file whose name says it holds one (`.env`, a key), or that
 * holds the value of one of the repo's secrets or the Claude credential, is left out, as a
 * file over the size limits is, and the checkpoint says which. The environment brings the
 * secrets back to the next sandbox; nothing else would.
 *
 * Neither ever restores something older over something newer: a commit is put back only on a
 * branch that has not moved on past it, the disk's own changes are stashed first (they stay in
 * `git stash list`), and a Scratch file newer on the disk than in the archive is kept.
 */

export interface WorkSaver {
  /**
   * A cheap fingerprint of the work as it is: the same means there is nothing new to save.
   * `skipped` hears of each file too large to hash.
   */
  stamp(skipped?: HashSkipped): Promise<string>;
  /** Saves the work in progress as checkpoint `turn` would carry it. */
  save(turn: number): Promise<SavedWork>;
  /** Puts the checkpoint's work back over what the disk has. */
  restore(point: SavedPoint, archive: Uint8Array | null): Promise<RestoredWork>;
}

export interface SavedWork {
  wipCommit: string | null;
  /** The archive to store, or null with `kept` when the stored one still holds this work. */
  workspace: Uint8Array | null;
  /** Nothing changed since the last save: the stored archive is still this work. */
  kept?: boolean;
  /** Files left out, each with why: its size, or that it looks like it holds a secret. */
  skipped: string[];
}

export type RestoredWork =
  | { done: true; what: string }
  /** `kept`: where the work is now, on this disk, when it could not go on the branch. */
  | { done: false; why: string; kept?: string };

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
) => Promise<Uint8Array>;

export function gitIn(shell: AgentShell, git: string, cwd: string): Git {
  return (args, opts = {}) => shell([git, ...args], { cwd, ...opts });
}

/* ------------------------------------------------------------------ */
/* Secrets                                                             */
/* ------------------------------------------------------------------ */

/** Example files that only name the variables, which repos commit on purpose. */
const ENV_EXAMPLES = /^\.env\.(example|sample|template|dist|defaults)$/i;
const SECRET_NAMES = [
  /^\.env(\..*)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|ppk|asc|gpg)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.(npmrc|netrc|pypirc|git-credentials|htpasswd|pgpass)$/i,
  /^credentials(\.json)?$/i,
];
const SECRET_DIRS = new Set([".aws", ".ssh", ".gnupg", ".docker", ".kube"]);
/** A secret value shorter than this is too common to look for. */
const MIN_SECRET = 8;

/** Whether a path's name says it holds a secret. */
export function secretPath(path: string): boolean {
  const name = basename(path);
  if (ENV_EXAMPLES.test(name)) return false;
  if (path.split("/").some((part) => SECRET_DIRS.has(part))) return true;
  return SECRET_NAMES.some((pattern) => pattern.test(name));
}

/** Picks the files a checkpoint may carry: within the limits, and holding no secret. */
class Picker {
  readonly skipped: string[] = [];
  private total = 0;
  private readonly secrets: Buffer[];

  constructor(
    private readonly cwd: string,
    private readonly limits: Limits,
    secrets: readonly string[],
  ) {
    this.secrets = [...new Set(secrets)]
      .filter((value) => value.length >= MIN_SECRET)
      .map((value) => Buffer.from(value));
  }

  /** Whether to take the file at `path`, as `lstat` saw it. */
  take(path: string, stat: Stats): boolean {
    const { size } = stat;
    if (secretPath(path)) {
      this.skipped.push(`${path} (may hold a secret)`);
      return false;
    }
    if (size > this.limits.fileBytes || this.total + size > this.limits.totalBytes) {
      this.skipped.push(`${path} (${size} bytes)`);
      return false;
    }
    // A link is saved as where it points, which is not read here (it could be anything).
    if (stat.isFile() && this.holdsSecret(path)) {
      this.skipped.push(`${path} (holds a secret's value)`);
      return false;
    }
    this.total += size;
    return true;
  }

  private holdsSecret(path: string): boolean {
    if (!this.secrets.length) return false;
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(this.cwd, path));
    } catch {
      // Unreadable here: what cannot be looked at is not taken.
      return true;
    }
    return this.secrets.some((secret) => bytes.includes(secret));
  }
}

/* ------------------------------------------------------------------ */
/* A repo's checkout                                                   */
/* ------------------------------------------------------------------ */

/** Work in progress in a repo's checkout, as a commit carried in a bundle. */
export class GitWork implements WorkSaver {
  private last: { key: string; commit: string } | null = null;

  constructor(
    private readonly opts: {
      cwd: string;
      canvasId: string;
      /** The canvas's branch, and the repository's default branch it was made from. */
      branch: string;
      defaultBranch: string;
      git: Git;
      /** The values of the repo's secrets and the Claude credential: never saved. */
      secrets?: readonly string[];
      limits?: Limits;
      maxBytes?: number;
      log?(message: string): void;
    },
  ) {}

  /** A local ref only, which keeps the commit the bundle is made from. Never pushed. */
  private get ref(): string {
    return wipRef(this.opts.canvasId);
  }

  private async git(args: string[], opts?: Parameters<Git>[1]): Promise<string> {
    return text(await this.opts.git(args, opts));
  }

  async stamp(skipped?: HashSkipped): Promise<string> {
    const head = await this.head();
    if (!head) return "";
    // Every change against HEAD, and every untracked file, by size and time (`fingerprint`).
    const since = Date.now();
    const listed = await this.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const paths = listed
      .split("\0")
      .filter(Boolean)
      .map((entry) => entry.slice(3));
    const sizes = paths.map((path) => {
      try {
        const full = join(this.opts.cwd, path);
        return `${path}:${fingerprint(full, lstatSync(full), since, (size) => skipped?.(path, size))}`;
      } catch {
        return `${path}:gone`;
      }
    });
    return `${head}|${sizes.join("|")}`;
  }

  async save(turn: number): Promise<SavedWork> {
    const limits = this.opts.limits ?? LIMITS;
    const head = await this.head();
    if (!head) return { wipCommit: null, workspace: null, skipped: [] };
    // An index of its own, beside the checkout's, which it never touches: it is made again from
    // HEAD each time, and left in .git between saves.
    const env = { GIT_INDEX_FILE: await this.indexPath(), GIT_LITERAL_PATHSPECS: "1" };
    await this.git(["read-tree", "HEAD"], { env });
    // Against HEAD: changed, deleted and untracked files, but not ignored ones.
    const listed = await this.git(
      ["ls-files", "-z", "--modified", "--deleted", "--others", "--exclude-standard"],
      { env },
    );
    const picker = new Picker(this.opts.cwd, limits, this.opts.secrets ?? []);
    const take: string[] = [];
    for (const path of [...new Set(listed.split("\0").filter(Boolean))].sort()) {
      let stat: Stats;
      try {
        stat = lstatSync(join(this.opts.cwd, path));
      } catch {
        take.push(path); // deleted: `add -A` records that
        continue;
      }
      if (picker.take(path, stat)) take.push(path);
    }
    const { skipped } = picker;
    if (take.length) {
      await this.git(["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], {
        env,
        input: Buffer.from(`${take.join("\0")}\0`),
      });
    }
    const tree = (await this.git(["write-tree"], { env })).trim();
    const key = `${head} ${tree}`;
    // Nothing new since the last save: the stored archive already has it.
    if (this.last?.key === key)
      return { wipCommit: this.last.commit, workspace: null, kept: true, skipped };
    const message = [
      `ponzu: work in progress at turn ${turn}`,
      "",
      `Ponzu-Turn: ${turn}`,
      ...skipped.map((s) => `Ponzu-Skipped: ${s}`),
    ].join("\n");
    const commit = (await this.git(["commit-tree", tree, "-p", head, "-m", message])).trim();
    await this.git(["update-ref", this.ref, commit]);
    // The commits GitHub does not have: the branch's and the default branch's are left out.
    const bases = await this.bases();
    const bundle = await this.opts.git([
      "bundle",
      "create",
      "--quiet",
      "-",
      this.ref,
      ...(bases.length ? ["--not", ...bases] : []),
    ]);
    const archive = gzipSync(bundle);
    const max = this.opts.maxBytes ?? MAX_WORKSPACE_BYTES;
    if (archive.byteLength > max)
      throw new Error(
        `The work in progress is ${archive.byteLength} bytes compressed, over ${max}.`,
      );
    this.last = { key, commit };
    return { wipCommit: commit, workspace: new Uint8Array(archive), skipped };
  }

  /** What GitHub had of the branch and the default branch, as this checkout last fetched it. */
  private async bases(): Promise<string[]> {
    const { branch, defaultBranch } = this.opts;
    const found: string[] = [];
    for (const name of new Set([branch, defaultBranch])) {
      const ref = `refs/remotes/origin/${name}`;
      if (await commitOf(this.opts.git, ref)) found.push(ref);
    }
    return found;
  }

  /** Where the saves' own index lives: inside .git, as an absolute path. */
  private async indexPath(): Promise<string> {
    const path = (await this.git(["rev-parse", "--git-path", "ponzu-wip.index"])).trim();
    return isAbsolute(path) ? path : join(this.opts.cwd, path);
  }

  async restore(point: SavedPoint, archive: Uint8Array | null): Promise<RestoredWork> {
    const wanted = point.wipCommit;
    if (!wanted) return { done: false, why: "the checkpoint has no work in progress" };
    // The commit the API recorded, and only that one.
    const why = await this.load(wanted, archive);
    if (why) return { done: false, why };
    const wip = wanted;
    const parent = (await this.git(["rev-parse", `${wip}^`])).trim();
    const head = await this.head();

    if (head !== parent) {
      const placed = await this.place(head, parent, point.turn);
      if (!placed) {
        // The work stays on this disk, on a branch of its own, for the agent to bring over.
        const kept = `ponzu-wip/turn-${point.turn}`;
        await this.git(["branch", "--force", "--no-track", kept, wip]).catch(() => {});
        return {
          done: false,
          why: "the branch has moved on since the work in progress was saved",
          kept,
        };
      }
    }
    if ((await this.treeNow()) === (await this.git(["rev-parse", `${wip}^{tree}`])).trim())
      return { done: true, what: "the checkout already held it" };
    await this.stashDisk(point.turn);
    // The working tree as saved, over HEAD: the index is left as HEAD has it, so what was
    // uncommitted is uncommitted again and what was untracked is untracked.
    await this.git(["restore", `--source=${wip}`, "--worktree", "--", "."]);
    await this.git(["update-ref", this.ref, wip]);
    return { done: true, what: `restored ${wip.slice(0, 12)} over ${parent.slice(0, 12)}` };
  }

  /**
   * Gets commit `wip` into this checkout: from the bundle in `archive` (checked to be the commit
   * asked for), or, for a checkpoint from before bundles, by its hash from GitHub. Answers why
   * not, or null once it is here.
   */
  private async load(wip: string, archive: Uint8Array | null): Promise<string | null> {
    if (await commitOf(this.opts.git, wip)) return null;
    if (archive) {
      let bundle: Buffer;
      try {
        bundle = gunzipSync(archive);
      } catch {
        return "the saved work in progress is not a gzipped bundle";
      }
      const parsed = parseBundle(bundle);
      if (!parsed) return "the saved work in progress is not a git bundle";
      if (!parsed.tips.includes(wip)) return "the saved bundle does not hold the recorded commit";
      for (const base of parsed.prerequisites) {
        if (!(await commitOf(this.opts.git, base)))
          return `the saved work in progress is built on ${base.slice(0, 12)}, which this checkout does not have`;
      }
      try {
        await this.opts.git(["index-pack", "--stdin", "--fix-thin"], { input: parsed.pack });
      } catch (err) {
        return `the saved work in progress could not be read: ${said(err)}`;
      }
    } else {
      // Asked for by its hash: whatever another writer put on a ref, it is not this.
      await this.git(["fetch", "--quiet", "--no-tags", "origin", wip]).catch(() => {});
    }
    return (await commitOf(this.opts.git, wip)) === wip
      ? null
      : `the recorded commit ${wip.slice(0, 12)} could not be had`;
  }

  /**
   * Puts the branch at `parent`, the HEAD the work was saved on, when that loses nothing: HEAD is
   * behind it (the saved HEAD is the branch plus commits that were never pushed), or the branch
   * is one this disk only just made (never pushed, nothing of its own beyond the default
   * branch, which may have moved on since). False when the branch has commits the saved work
   * does not.
   */
  private async place(head: string | null, parent: string, turn: number): Promise<boolean> {
    const { branch, defaultBranch } = this.opts;
    const ancestor = (a: string, b: string) =>
      this.opts.git(["merge-base", "--is-ancestor", a, b]).then(
        () => true,
        () => false,
      );
    if (head && (await ancestor(head, parent))) {
      await this.stashDisk(turn);
      await this.git(["merge", "--ff-only", "--quiet", parent]);
      return true;
    }
    const pushed = await commitOf(this.opts.git, `refs/remotes/origin/${branch}`);
    const base = await commitOf(this.opts.git, `refs/remotes/origin/${defaultBranch}`);
    const current = (await this.git(["branch", "--show-current"]).catch(() => "")).trim();
    const own =
      head && base
        ? (await this.git(["rev-list", "--count", `${base}..${head}`])).trim() !== "0"
        : head !== null;
    if (pushed || own || current !== branch) return false;
    await this.stashDisk(turn);
    await this.git(["switch", "--quiet", "--no-track", "-C", branch, parent]);
    return true;
  }

  /** What the disk has that no commit does, kept where git keeps it, before it is replaced. */
  private async stashDisk(turn: number): Promise<void> {
    const dirty = await this.git(["status", "--porcelain=v1", "--untracked-files=all"]);
    if (!dirty.trim()) return;
    await this.git([
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
    const env = { GIT_INDEX_FILE: await this.indexPath() };
    await this.git(["read-tree", "HEAD"], { env });
    await this.git(["add", "-A"], { env });
    return (await this.git(["write-tree"], { env })).trim();
  }

  private head(): Promise<string | null> {
    return commitOf(this.opts.git, "HEAD");
  }
}

/**
 * A v2 or v3 git bundle: the commits it needs the reader to have, the tips it carries, and its
 * pack. Null when it is not one.
 */
export function parseBundle(
  bundle: Buffer,
): { prerequisites: string[]; tips: string[]; pack: Buffer } | null {
  const end = bundle.indexOf("\n\n");
  if (end < 0) return null;
  const lines = bundle.subarray(0, end).toString("utf8").split("\n");
  if (!/^# v[23] git bundle$/.test(lines[0] ?? "")) return null;
  const prerequisites: string[] = [];
  const tips: string[] = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith("@")) continue; // a v3 capability
    const prerequisite = /^-([0-9a-f]{40,64})/.exec(line);
    if (prerequisite) prerequisites.push(prerequisite[1]!);
    const tip = /^([0-9a-f]{40,64}) /.exec(line);
    if (tip) tips.push(tip[1]!);
  }
  const pack = bundle.subarray(end + 2);
  if (pack.subarray(0, 4).toString("latin1") !== "PACK") return null;
  return { prerequisites, tips, pack };
}

/* ------------------------------------------------------------------ */
/* Scratch                                                             */
/* ------------------------------------------------------------------ */

/** A Scratch canvas's folder, as an archive uploaded with each checkpoint. */
export class ScratchWork implements WorkSaver {
  constructor(
    private readonly opts: {
      cwd: string;
      /** Runs `tar` as the agent. */
      shell: AgentShell;
      secrets?: readonly string[];
      limits?: Limits;
      maxBytes?: number;
    },
  ) {}

  async stamp(skipped?: HashSkipped): Promise<string> {
    const since = Date.now();
    return this.list()
      .taken.map(({ path, stat }) => {
        const full = join(this.opts.cwd, path);
        return `${path}:${fingerprint(full, stat, since, (size) => skipped?.(path, size))}`;
      })
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
    await this.opts.shell(["/bin/sh", "-c", UNPACK_KEEPING_NEWER, "sh", this.opts.cwd], {
      input: archive,
    });
    return { done: true, what: "restored the Scratch folder" };
  }

  /** Every file in the folder, but `node_modules` and `.git`, within the limits and no secret. */
  private list() {
    const picker = new Picker(this.opts.cwd, this.opts.limits ?? LIMITS, this.opts.secrets ?? []);
    const taken: { path: string; stat: Stats }[] = [];
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
        if (picker.take(path, stat)) taken.push({ path, stat });
      }
    };
    walk(this.opts.cwd);
    return { taken, skipped: picker.skipped };
  }
}

async function commitOf(git: Git, rev: string): Promise<string | null> {
  return git(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]).then(
    (out) => text(out).trim() || null,
    () => null,
  );
}

function said(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
