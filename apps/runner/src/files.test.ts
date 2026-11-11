import { afterAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileError } from "@ponzu/tools";
import { agentFiles } from "./files.ts";

/*
 * `env` stands in for the image's `as-agent`: it runs the command as this same user. What the
 * image's own adds (another user) is checked in a sandbox made from it (image/checks.ts).
 */
const files = agentFiles("/usr/bin/env", { PATH: "/usr/bin:/bin" });
const dir = await mkdtemp(join(tmpdir(), "ponzu-agent-files-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

const problem = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (err: FileError) => [err.problem, err.message],
  );

test("reads no more than it is asked for, and says what is missing or not a file", async () => {
  await writeFile(join(dir, "page.html"), "<p>hello</p>");
  expect(Buffer.from(await files.read(join(dir, "page.html"), 100)).toString()).toBe(
    "<p>hello</p>",
  );
  expect(Buffer.from(await files.read(join(dir, "page.html"), 3)).toString()).toBe("<p>");
  expect(await problem(files.read(join(dir, "nothing.html"), 10))).toEqual([
    "missing",
    join(dir, "nothing.html"),
  ]);
  expect(await problem(files.read(dir, 10))).toEqual(["not_file", dir]);
  // A link to nothing is nothing; a link to a file is read as the agent would read it.
  await symlink(join(dir, "nothing.html"), join(dir, "dangling.html"));
  expect((await problem(files.read(join(dir, "dangling.html"), 10)))?.[0]).toBe("missing");
  await symlink(join(dir, "page.html"), join(dir, "link.html"));
  expect(Buffer.from(await files.read(join(dir, "link.html"), 100)).toString()).toBe(
    "<p>hello</p>",
  );
  // A path that looks like an option is a path.
  expect((await problem(files.read("-n", 10)))?.[0]).toBe("missing");
});

test.skipIf(process.getuid?.() === 0)("a file the agent may not read is refused", async () => {
  await writeFile(join(dir, "secret.env"), "TOKEN=x");
  await chmod(join(dir, "secret.env"), 0o000);
  const [kind, message] = (await problem(files.read(join(dir, "secret.env"), 10)))!;
  expect(kind).toBe("denied");
  expect(message).toContain("Permission denied");
});

test("writes whole files, making the folders on the way", async () => {
  const path = join(dir, "exports", "deep", "board.png");
  const bytes = new Uint8Array(200_000).map((_, i) => i % 251);
  await files.write(path, bytes);
  expect(new Uint8Array(await readFile(path))).toEqual(bytes);
  await files.write(path, new Uint8Array([1, 2, 3]));
  expect(new Uint8Array(await readFile(path))).toEqual(new Uint8Array([1, 2, 3]));
});

test.skipIf(process.getuid?.() === 0)("a write the agent may not make is refused", async () => {
  await mkdir(join(dir, "locked"));
  await chmod(join(dir, "locked"), 0o500);
  const [kind] = (await problem(files.write(join(dir, "locked", "board.png"), new Uint8Array(1))))!;
  expect(kind).toBe("denied");
  await chmod(join(dir, "locked"), 0o700);
});
