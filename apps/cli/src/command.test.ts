import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readlinkSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkCommand, userPath } from "./command.ts";

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

test("stands in front of the .deb's /usr/bin/ponzu, which opens the app", async () => {
  const opt = join(home, "opt/Ponzu");
  await executable(join(opt, "ponzu"));
  await executable(join(opt, "resources/server/ponzu"));
  const usrBin = join(home, "usr/bin");
  await mkdir(usrBin, { recursive: true });
  await symlink(join(opt, "ponzu"), join(usrBin, "ponzu"));
  // Behind it on the PATH, a link would never run.
  await linkCommand(shim, { auto: true, path: [usrBin, local], home });
  expect(existsSync(join(local, "ponzu"))).toBe(false);
  await linkCommand(shim, { path: [local, usrBin], home });
  expect(readlinkSync(join(local, "ponzu"))).toBe(shim);
});

test.skipIf(process.platform !== "win32")(
  "on Windows, the shim's folder joins the user's PATH once, leaving the rest as it was",
  () => {
    const key = "HKCU:\\Software\\PonzuTest\\Environment";
    const before = "%USERPROFILE%\\bin;C:\\Users\\Zoë\\tools;";
    const ps = (script: string, env: Record<string, string> = {}) =>
      spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        env: { ...process.env, PONZU_KEY: key, ...env },
      }).status;
    expect(
      ps(
        "New-Item -Path $env:PONZU_KEY -Force | Out-Null; New-ItemProperty -LiteralPath $env:PONZU_KEY -Name Path -Value $env:PONZU_PATH -PropertyType ExpandString -Force | Out-Null",
        { PONZU_PATH: before },
      ),
    ).toBe(0);
    try {
      const env = { PONZU_ENVIRONMENT_KEY: key };
      const bin = "C:\\Users\\Zoë\\.ponzu\\bin";
      expect(userPath(bin, false, env)).toBe("off");
      expect(userPath(bin, true, env)).toBe("added");
      expect(userPath(`${bin.toUpperCase()}\\`, false, env)).toBe("on");
      expect(userPath(bin, true, env)).toBe("on");
      // Unexpanded, non-ASCII entries intact, still an expandable string.
      expect(
        ps(
          "$k = Get-Item -LiteralPath $env:PONZU_KEY; if ($k.GetValueKind('Path') -ne 'ExpandString') { exit 1 }; if ($k.GetValue('Path', '', 'DoNotExpandEnvironmentNames') -cne $env:PONZU_WANT) { exit 2 }",
          { PONZU_WANT: `%USERPROFILE%\\bin;C:\\Users\\Zoë\\tools;${bin}` },
        ),
      ).toBe(0);
    } finally {
      ps("Remove-Item -Path 'HKCU:\\Software\\PonzuTest' -Recurse -Force");
    }
  },
);
