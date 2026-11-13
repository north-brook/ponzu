import { existsSync, lstatSync, readdirSync, type Stats } from "node:fs";
import { join } from "node:path";
import { MAX_SESSION_BYTES } from "../api/protocol.ts";
import { fingerprint, type HashSkipped } from "./fingerprint.ts";
import { type AgentShell, text, unpackKeepingNewer } from "./shell.ts";

/*
 * Claude Code's transcript of one session, as files under its config folder (`CLAUDE_CONFIG_DIR`,
 * `/home/agent/.claude` in the image): what makes a session resumable is
 * `projects/<cwd, every other character a dash>/<session id>.jsonl`, an append-only JSONL of every
 * message, tool call and result, and the folder of the same name beside it when Claude Code made
 * one (subagents' transcripts and tool results it kept out of the main file). `--resume <id>`
 * finds the file from any working folder. Nothing else under the config folder is needed to
 * resume: `session-env/`, `file-history/`, `todos/` and the project's `memory/` are conveniences
 * Claude Code recreates.
 *
 * The files are the agent's (0600 in the image), so they are packed and unpacked by `tar` run as
 * the agent. Listing them is the runner's (CAP_DAC_READ_SEARCH in the image).
 */

/** A Claude session id: what Claude Code makes (a UUID), and nothing that could be a path. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

/**
 * The runner's usage totals for the session (usage.ts), carried at the archive's top beside
 * `projects/`. A runner from before it puts the file back under the config folder, where nothing
 * reads it; this one takes it out instead.
 */
export const USAGE_FILE = ".ponzu-usage.json";

/** `tar` of the files `$2…` under `$1`, and the usage totals on its input as `USAGE_FILE`. */
const PACK_WITH_USAGE = `set -e
dir=$1
shift
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/${USAGE_FILE}"
tar -czf - -C "$dir" "$@" -C "$tmp" ${USAGE_FILE}`;

const UNPACK_SESSION = unpackKeepingNewer(USAGE_FILE);

export class TranscriptTooLarge extends Error {
  override name = "TranscriptTooLarge";
}

export class Transcripts {
  private readonly maxBytes: number;

  constructor(
    private readonly opts: {
      /** Claude Code's config folder: `CLAUDE_CONFIG_DIR`, or `~/.claude`. */
      configDir: string;
      /** Runs `tar` as the agent. */
      shell: AgentShell;
      maxBytes?: number;
    },
  ) {
    this.maxBytes = opts.maxBytes ?? MAX_SESSION_BYTES;
  }

  /** The files that make `sessionId` resumable, relative to the config folder. */
  files(sessionId: string): string[] {
    if (!SESSION_ID.test(sessionId)) return [];
    const projects = join(this.opts.configDir, "projects");
    let dirs: string[];
    try {
      dirs = readdirSync(projects);
    } catch {
      return [];
    }
    const found: string[] = [];
    for (const dir of dirs) {
      const file = join("projects", dir, `${sessionId}.jsonl`);
      if (!existsSync(join(this.opts.configDir, file))) continue;
      found.push(file);
      const beside = join("projects", dir, sessionId);
      if (existsSync(join(this.opts.configDir, beside))) found.push(beside);
    }
    return found;
  }

  /**
   * What the files are now, cheaply: their sizes and times (`fingerprint`), and those of every
   * file in the folder beside the transcript, whose own size and time do not change when a file
   * in it is written. The same stamp means nothing was written since, so a checkpoint need not
   * upload the transcript again. `skipped` hears of each file too large to hash.
   */
  stamp(sessionId: string, skipped?: HashSkipped): string {
    const since = Date.now();
    const parts: string[] = [];
    const add = (file: string) => {
      const full = join(this.opts.configDir, file);
      let stat: Stats;
      try {
        stat = lstatSync(full);
      } catch {
        parts.push(`${file}:gone`);
        return;
      }
      if (!stat.isDirectory()) {
        parts.push(`${file}:${fingerprint(full, stat, since, (size) => skipped?.(file, size))}`);
        return;
      }
      for (const name of readdirSync(full).sort()) add(join(file, name));
    };
    for (const file of this.files(sessionId)) add(file);
    return parts.join("|");
  }

  /**
   * The session's files as a gzipped tar, or null when there is no transcript. With `usage`, the
   * runner's usage totals for the session go with them.
   */
  async pack(sessionId: string, usage?: string | null): Promise<Uint8Array | null> {
    const files = this.files(sessionId);
    if (!files.length) return null;
    const { configDir } = this.opts;
    const bytes = usage
      ? await this.opts.shell(["/bin/sh", "-c", PACK_WITH_USAGE, "sh", configDir, ...files], {
          input: new TextEncoder().encode(usage),
        })
      : await this.opts.shell(["tar", "-czf", "-", "-C", configDir, ...files]);
    if (bytes.byteLength > this.maxBytes)
      throw new TranscriptTooLarge(
        `The session's transcript is ${bytes.byteLength} bytes compressed, over the ${this.maxBytes} a checkpoint keeps.`,
      );
    return bytes;
  }

  /**
   * Puts an archive `pack` made back under the config folder. A file on the disk that is newer
   * than the archive's copy is left as it is (`unpackKeepingNewer`): a transcript only grows, so
   * the disk's is newer when the turn after the checkpoint was written but never saved. Answers
   * the usage totals the archive carried, or null for one from before they went with it.
   */
  async unpack(archive: Uint8Array): Promise<{ usage: string | null }> {
    const printed = await this.opts.shell(
      ["/bin/sh", "-c", UNPACK_SESSION, "sh", this.opts.configDir],
      { input: archive },
    );
    const usage = text(printed);
    return { usage: usage.trim() ? usage : null };
  }

  /** Whether the session has a transcript on this disk. */
  has(sessionId: string): boolean {
    return this.files(sessionId).length > 0;
  }
}
