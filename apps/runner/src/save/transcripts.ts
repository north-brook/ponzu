import { existsSync, lstatSync, readdirSync, type Stats } from "node:fs";
import { join } from "node:path";
import { MAX_SESSION_BYTES } from "../api/protocol.ts";
import { fingerprint } from "./fingerprint.ts";
import { type AgentShell, UNPACK_KEEPING_NEWER } from "./shell.ts";

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
   * upload the transcript again.
   */
  stamp(sessionId: string): string {
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
        parts.push(`${file}:${fingerprint(full, stat, since)}`);
        return;
      }
      for (const name of readdirSync(full).sort()) add(join(file, name));
    };
    for (const file of this.files(sessionId)) add(file);
    return parts.join("|");
  }

  /** The session's files as a gzipped tar, or null when there is no transcript. */
  async pack(sessionId: string): Promise<Uint8Array | null> {
    const files = this.files(sessionId);
    if (!files.length) return null;
    const bytes = await this.opts.shell(["tar", "-czf", "-", "-C", this.opts.configDir, ...files]);
    if (bytes.byteLength > this.maxBytes)
      throw new TranscriptTooLarge(
        `The session's transcript is ${bytes.byteLength} bytes compressed, over the ${this.maxBytes} a checkpoint keeps.`,
      );
    return bytes;
  }

  /**
   * Puts an archive `pack` made back under the config folder. A file on the disk that is newer
   * than the archive's copy is left as it is (`UNPACK_KEEPING_NEWER`): a transcript only grows, so
   * the disk's is newer when the turn after the checkpoint was written but never saved.
   */
  async unpack(archive: Uint8Array): Promise<void> {
    await this.opts.shell(["/bin/sh", "-c", UNPACK_KEEPING_NEWER, "sh", this.opts.configDir], {
      input: archive,
    });
  }

  /** Whether the session has a transcript on this disk. */
  has(sessionId: string): boolean {
    return this.files(sessionId).length > 0;
  }
}
