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
export async function readGiven(path: string, limit: number, instead: string): Promise<Uint8Array> {
  const info = await stat(absolute(path)).catch(() => null);
  if (!info) throw new ToolError(`There is no file at ${path}.`);
  if (!info.isFile()) throw new ToolError(`${path} is not a file.`);
  // Read to one byte past the limit and no further, whatever size the file reports: one can
  // grow after it is asked, and some (under /proc) say they are empty.
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of createReadStream(path, { end: limit })) {
    chunks.push(chunk);
    size += chunk.length;
  }
  if (size > limit) {
    const actual = info.size > limit ? fileSize(info.size) : `more than ${fileSize(limit)}`;
    throw new ToolError(`${path} is ${actual}; the most is ${fileSize(limit)}. ${instead}`);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

/** Write a file where the agent asked for it, making the folders on the way. */
export async function writeGiven(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}
