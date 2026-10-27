import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readlinkSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkCommand } from "./command.ts";

const saved = process.env.PONZU_HOME;
let home: string;
let shim: string;
let local: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ponzu-command-"));
  // Never the real ~/.ponzu.
  process.env.PONZU_HOME = join(home, ".ponzu");
  shim = join(home, ".ponzu/bin/ponzu");
  local = join(home, ".local/bin");
  await executable(shim);
});

afterEach(() => rm(home, { recursive: true, force: true }));

afterAll(() => {
  if (saved === undefined) delete process.env.PONZU_HOME;
  else process.env.PONZU_HOME = saved;
});

async function executable(path: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "#!/bin/sh\n");
  await chmod(path, 0o755);
}

test("links the shim into ~/.local/bin when the shell searches it, making the folder", async () => {
  await linkCommand(shim, { auto: true, path: ["/usr/bin", local], home });
  expect(readlinkSync(join(local, "ponzu"))).toBe(shim);
});

test("leaves the PATH alone when the shell searches none of its folders", async () => {
  await linkCommand(shim, { auto: true, path: ["/usr/bin", "/opt/homebrew/bin"], home });
  expect(existsSync(join(local, "ponzu"))).toBe(false);
});

test("never shadows another ponzu on the PATH", async () => {
  const other = join(home, "elsewhere");
  await executable(join(other, "ponzu"));
  await linkCommand(shim, { auto: true, path: [other, local], home });
  expect(existsSync(join(local, "ponzu"))).toBe(false);
});

test("never replaces a file called ponzu, even a broken link", async () => {
  await mkdir(local, { recursive: true });
  await symlink(join(home, "gone"), join(local, "ponzu"));
  await linkCommand(shim, { auto: true, path: [local], home });
  expect(readlinkSync(join(local, "ponzu"))).toBe(join(home, "gone"));
});

test("a link the person removed stays removed at launch, and `ponzu install` puts it back", async () => {
  await linkCommand(shim, { auto: true, path: [local], home });
  await rm(join(local, "ponzu"));
  await linkCommand(shim, { auto: true, path: [local], home });
  expect(existsSync(join(local, "ponzu"))).toBe(false);
  await linkCommand(shim, { path: [local], home });
  expect(readlinkSync(join(local, "ponzu"))).toBe(shim);
});
