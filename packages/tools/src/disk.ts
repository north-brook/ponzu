import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { ToolError } from "./define.ts";

/*
 * Files an agent names by path. In a sandbox the tools run on the machine the agent works on,
 * so a path is how something too big for an argument gets in, and how an export gets out to
 * where the agent can use it.
 *
 * Only the cloud's tools read one. The local server answers callers on other machines, and
 * there a path names a file of the server's, which the caller could not otherwise read.
 */

/**
 * How the tools reach the files an agent names. The tools run in the host's process, which may
 * reach more than the agent may: in the sandbox image the runner can read its own token and the
 * agent cannot. A host like that reads and writes as the agent (the runner's `AgentUser`), so a
 * path, or a link the agent made, reaches only what the agent could have reached itself.
 */
export interface AgentFiles {
  /**
   * At most `max` bytes from the start of the file at `path`. Throws a `FileError` when the
   * agent sees nothing there, it is not a file, or the agent may not read it.
   */
  read(path: string, max: number): Promise<Uint8Array>;
  /** Writes `bytes` to `path`, making its folders. Throws a `FileError` when the agent may not. */
  write(path: string, bytes: Uint8Array): Promise<void>;
}

export type FileProblem = "missing" | "not_file" | "denied";

export class FileError extends Error {
  override name = "FileError";
  constructor(
    readonly problem: FileProblem,
    message: string,
  ) {
    super(message);
  }
}

/** The files as this process reaches them: where the agent and the host are the same user. */
export const localFiles: AgentFiles = {
  async read(path, max) {
    const info = await stat(path).catch(() => null);
    if (!info) throw new FileError("missing", path);
    if (!info.isFile()) throw new FileError("not_file", path);
    // Read to `max` and no further, whatever size the file reports: one can grow after it is
    // asked, and some (under /proc) say they are empty.
    const chunks: Uint8Array[] = [];
    try {
      for await (const chunk of createReadStream(path, { end: max - 1 })) chunks.push(chunk);
    } catch (err) {
      throw new FileError("denied", err instanceof Error ? err.message : String(err));
    }
    return Buffer.concat(chunks);
  },
  async write(path, bytes) {
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    } catch (err) {
      throw new FileError("denied", err instanceof Error ? err.message : String(err));
    }
  },
};

/** "340 KB", "1.2 MB". */
export function fileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${Number((bytes / 1024 / 1024).toFixed(1))} MB`;
}

/** A path only means one place when it's absolute: the agent's working directory isn't the tools'. */
export function absolute(path: string): string {
  if (!isAbsolute(path)) throw new ToolError(`${path} is a relative path. Pass an absolute path.`);
  return path;
}

/**
 * The bytes of the file at `path`, which the agent wrote with its own file tools. `limit` is
 * the most the caller takes, and `instead` says what to do with a larger one.
 */
export async function readGiven(
  files: AgentFiles,
  path: string,
  limit: number,
  instead: string,
): Promise<Uint8Array> {
  // One byte past the limit says whether there is more.
  const bytes = await files.read(absolute(path), limit + 1).catch((err) => {
    throw toolError(err, path, "read");
  });
  if (bytes.length > limit)
    throw new ToolError(`${path} is more than ${fileSize(limit)}, the most it takes. ${instead}`);
  return bytes;
}

/** Write a file where the agent asked for it, making the folders on the way. */
export async function writeGiven(
  files: AgentFiles,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  await files.write(absolute(path), bytes).catch((err) => {
    throw toolError(err, path, "write");
  });
}

function toolError(err: unknown, path: string, verb: "read" | "write"): Error {
  if (!(err instanceof FileError)) return err as Error;
  if (err.problem === "missing") return new ToolError(`There is no file at ${path}.`);
  if (err.problem === "not_file") return new ToolError(`${path} is not a file.`);
  return new ToolError(`You can't ${verb} ${path}: ${err.message}`);
}
