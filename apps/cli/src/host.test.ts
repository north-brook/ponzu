import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adoptAppImage,
  appImageServer,
  appLauncher,
  appServer,
  findApp,
  ownBundle,
  shimPath,
  shimScript,
} from "./host.ts";

let dir: string;
const saved = process.env.PONZU_HOME;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ponzu-host-"));
  // Never the real ~/.ponzu.
  process.env.PONZU_HOME = join(dir, "home");
});

afterAll(async () => {
  if (saved === undefined) delete process.env.PONZU_HOME;
  else process.env.PONZU_HOME = saved;
  await rm(dir, { recursive: true, force: true });
});

/** An install folder like the .deb's /opt/Ponzu or Windows' %LOCALAPPDATA%\Programs\ponzu. */
async function installFolder(name: string, server: string): Promise<string> {
  const folder = join(dir, name);
  await mkdir(join(folder, "resources/server"), { recursive: true });
  await writeFile(join(folder, "resources/server", server), "");
  return folder;
}

test("the CLI's place in each platform's install", async () => {
  expect(appServer("/Applications/Ponzu.app", "darwin")).toBe(
    "/Applications/Ponzu.app/Contents/Resources/server/ponzu",
  );
  const programs = "C:\\Users\\me\\AppData\\Local\\Programs\\ponzu";
  expect(appServer(programs, "win32")).toBe(`${programs}\\resources\\server\\ponzu.exe`);
  const deb = await installFolder("opt-ponzu", "ponzu");
  expect(appServer(deb, "linux")).toBe(join(deb, "resources/server/ponzu"));
  // An AppImage's CLI is mounted only while it runs: the copy beside ~/.ponzu stands in.
  const appimage = join(dir, "Ponzu-x64.AppImage");
  await writeFile(appimage, "");
  expect(appServer(appimage, "linux")).toBe(appImageServer());
});

test("starting the app with no window", async () => {
  expect(appLauncher("/Applications/Ponzu.app", "darwin")).toEqual([
    "open",
    ["-n", "-g", "-a", "/Applications/Ponzu.app", "--args", "--background"],
  ]);
  const deb = await installFolder("launch-deb", "ponzu");
  expect(appLauncher(deb, "linux")).toEqual([join(deb, "ponzu"), ["--background"]]);
  const win = await installFolder("launch-win", "ponzu.exe");
  expect(appLauncher(win, "win32")[0]).toMatch(/[\\/]Ponzu\.exe$/);
  expect(appLauncher("/home/me/Ponzu-x64.AppImage", "linux")).toEqual([
    "/home/me/Ponzu-x64.AppImage",
    ["--background"],
  ]);
});

test("the app this binary ships in", () => {
  const mac = "/Applications/Ponzu.app/Contents/Resources/server/ponzu";
  expect(ownBundle(mac, "darwin")).toBe("/Applications/Ponzu.app");
  // Places that go away.
  expect(ownBundle("/Volumes/Ponzu/Ponzu.app/Contents/Resources/server/ponzu", "darwin")).toBe(
    null,
  );
  expect(
    ownBundle(
      "/private/var/folders/x/AppTranslocation/y/d/Ponzu.app/Contents/Resources/server/ponzu",
      "darwin",
    ),
  ).toBe(null);

  expect(
    ownBundle(
      "C:\\Users\\me\\AppData\\Local\\Programs\\ponzu\\resources\\server\\ponzu.exe",
      "win32",
    ),
  ).toBe("C:\\Users\\me\\AppData\\Local\\Programs\\ponzu");
  expect(ownBundle("C:\\Program Files\\Ponzu\\Resources\\Server\\PONZU.EXE", "win32")).toBe(
    "C:\\Program Files\\Ponzu",
  );
  expect(ownBundle("C:\\Users\\me\\ponzu.exe", "win32")).toBe(null);

  expect(ownBundle("/opt/Ponzu/resources/server/ponzu", "linux", {})).toBe("/opt/Ponzu");
  const mount = "/tmp/.mount_PonzuAb12";
  const appimage = "/home/me/Apps/Ponzu-x64.AppImage";
  expect(
    ownBundle(`${mount}/resources/server/ponzu`, "linux", { APPIMAGE: appimage, APPDIR: mount }),
  ).toBe(appimage);
  // A mount with no word of its AppImage is gone once the app quits.
  expect(ownBundle(`${mount}/resources/server/ponzu`, "linux", {})).toBe(null);
  expect(ownBundle("/home/me/ponzu/apps/desktop/dist/server/ponzu", "linux", {})).toBe(null);
});

test("an AppImage's CLI is copied out once per version, and the AppImage found again", async () => {
  const mount = join(dir, "mount");
  const server = join(mount, "resources/server/ponzu");
  await mkdir(join(mount, "resources/server"), { recursive: true });
  await writeFile(server, "#!/bin/sh\necho one\n");
  const appimage = join(dir, "Apps/Ponzu-x64.AppImage");
  await mkdir(join(dir, "Apps"), { recursive: true });
  await writeFile(appimage, "");
  const env = { APPIMAGE: appimage, APPDIR: mount };

  expect(await adoptAppImage(server, "darwin", env)).toBe(null);
  expect(await adoptAppImage(server, "linux", env)).toBe(appimage);
  expect(readFileSync(appImageServer(), "utf8")).toBe("#!/bin/sh\necho one\n");
  expect(statSync(appImageServer()).mode & 0o111).toBeTruthy();
  const copied = statSync(appImageServer()).ino;

  // Unchanged: left alone.
  await adoptAppImage(server, "linux", env);
  expect(statSync(appImageServer()).ino).toBe(copied);

  // An update: copied again.
  await writeFile(server, "#!/bin/sh\necho two, longer\n");
  await utimes(server, new Date(), new Date(Date.now() + 5000));
  await adoptAppImage(server, "linux", env);
  expect(readFileSync(appImageServer(), "utf8")).toBe("#!/bin/sh\necho two, longer\n");

  // Agents run the copy, which finds the AppImage it came from to start.
  expect(ownBundle(appImageServer(), "linux", {})).toBe(appimage);
  expect(findApp("linux", {}, "/usr/bin/somewhere-else")).toBe(appimage);
  expect(findApp("linux", { PONZU_APP: "none" })).toBe(null);
  await rm(appimage);
  expect(findApp("linux", {}, appImageServer())).toBe(null);
});

test("the Mac's shim is unchanged", () => {
  expect(shimScript("/Users/me/Applications/Ponzu.app", "darwin")).toBe(`#!/bin/sh
# Written by Ponzu. Runs the server inside the installed Ponzu.app, so it updates with the app.
for app in '/Users/me/Applications/Ponzu.app' /Applications/Ponzu.app "$HOME/Applications/Ponzu.app"; do
  bin="$app/Contents/Resources/server/ponzu"
  [ -x "$bin" ] && exec "$bin" "$@"
done
echo "Ponzu isn't installed. Download it from https://ponzu.design" >&2
exit 1
`);
});

test.skipIf(process.platform === "win32")(
  "Linux's shim runs the installed CLI with its arguments and exit code",
  async () => {
    const folder = await installFolder("shim-deb", "ponzu");
    const server = appServer(folder, "linux");
    await writeFile(server, '#!/bin/sh\necho "ran $*"\nexit 3\n');
    await chmod(server, 0o755);
    const shim = join(dir, "shim.sh");
    await writeFile(shim, shimScript(folder, "linux"));
    await chmod(shim, 0o755);
    const out = spawnSync(shim, ["mcp", "it's"], { encoding: "utf8" });
    expect(out.stdout).toBe("ran mcp it's\n");
    expect(out.status).toBe(3);

    await rm(folder, { recursive: true });
    await rm(appImageServer(), { force: true });
    const missing = spawnSync(shim, [], { encoding: "utf8" });
    // Unless this machine has a .deb install of its own.
    if (missing.status !== 0) expect(missing.stderr).toContain("Ponzu isn't installed");
  },
);

test.skipIf(process.platform !== "win32")(
  "on Windows, finds the per-user install and the one for every user",
  async () => {
    const local = join(dir, "Local");
    const files = join(dir, "Program Files");
    expect(findApp("win32", { LOCALAPPDATA: local, ProgramFiles: files }, "C:\\x.exe")).toBe(null);
    await mkdir(join(files, "Ponzu/resources/server"), { recursive: true });
    await writeFile(join(files, "Ponzu/resources/server/ponzu.exe"), "");
    expect(findApp("win32", { LOCALAPPDATA: local, ProgramFiles: files }, "C:\\x.exe")).toBe(
      join(files, "Ponzu"),
    );
    await mkdir(join(local, "Programs/ponzu/resources/server"), { recursive: true });
    await writeFile(join(local, "Programs/ponzu/resources/server/ponzu.exe"), "");
    expect(findApp("win32", { LOCALAPPDATA: local, ProgramFiles: files }, "C:\\x.exe")).toBe(
      join(local, "Programs/ponzu"),
    );
  },
);

test.skipIf(process.platform !== "win32")(
  "on Windows, the shim runs the installed CLI with its arguments and exit code",
  async () => {
    // Bun itself stands in for ponzu.exe.
    const folder = await installFolder("shim-win", "ponzu.exe");
    await copyFile(process.execPath, appServer(folder, "win32"));
    const shim = join(dir, "ponzu.cmd");
    await writeFile(shim, shimScript(folder, "win32"));
    const version = spawnSync("cmd.exe", ["/d", "/c", shim, "--version"], { encoding: "utf8" });
    expect(version.stdout.trim()).toBe(Bun.version);
    const exit = spawnSync("cmd.exe", ["/d", "/c", shim, "-e", "process.exit(3)"], {
      encoding: "utf8",
    });
    expect(exit.status).toBe(3);
    expect(shimPath("win32")).toMatch(/[\\/]bin[\\/]ponzu\.cmd$/);
  },
);
