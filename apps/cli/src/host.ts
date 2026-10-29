import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { chmod, copyFile, mkdir, rename, rm, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";

/**
 * A running Ponzu host (`ponzu serve`, which the desktop app runs too)
 * announces itself in ~/.ponzu/host.json, so `ponzu mcp` finds it on any
 * port without anyone configuring one.
 */
interface HostFile {
  url: string;
  mcp: string;
  pid: number;
}

export const ponzuHome = () => process.env.PONZU_HOME ?? join(homedir(), ".ponzu");
const hostFile = () => join(ponzuHome(), "host.json");

/**
 * Say this process is the machine's Ponzu. The desktop app always takes
 * over: it has the canvas window and the renderer. Others defer to a host
 * that still answers. Returns the cleanup for shutdown.
 */
export async function announceHost(
  url: string,
  opts: { takeOver?: boolean } = {},
): Promise<() => Promise<void>> {
  if (!opts.takeOver && (await runningHost())) return async () => {};
  const path = hostFile();
  await mkdir(dirname(path), { recursive: true });
  const me: HostFile = { url, mcp: `${url}/mcp`, pid: process.pid };
  await writeFile(path, `${JSON.stringify(me)}\n`);
  return async () => {
    // Another host may have announced itself since.
    if (readHost()?.pid === process.pid) await rm(path, { force: true });
  };
}

function readHost(): HostFile | null {
  try {
    return JSON.parse(readFileSync(hostFile(), "utf8")) as HostFile;
  } catch {
    return null;
  }
}

/** The announced host's MCP URL, if it answers as Ponzu. */
export async function runningHost(): Promise<string | null> {
  const host = readHost();
  if (!host) return null;
  try {
    const res = await fetch(`${host.url}/api/info`, { signal: AbortSignal.timeout(1000) });
    const info = res.ok ? ((await res.json()) as { mcp?: string }) : null;
    return info?.mcp ? host.mcp : null;
  } catch {
    return null;
  }
}

export const SERVER = "Contents/Resources/server/ponzu";

/*
 * The installed desktop app, which findApp returns, is a path that differs by
 * platform: the Ponzu.app bundle on a Mac; the install folder on Windows
 * (NSIS's per-user default is %LOCALAPPDATA%\Programs\ponzu) and for Linux's
 * .deb (/opt/Ponzu); or the AppImage file itself. An AppImage's files are
 * mounted only while it runs, so the CLI it carries is copied out to
 * ~/.ponzu/app (adoptAppImage) for agents and the shim to run.
 */

const pathFor = (os: NodeJS.Platform) => (os === "win32" ? win32 : posix);

/** Where the copy of an AppImage's CLI lives, and the record of which AppImage it came from. */
export const appImageServer = () => join(ponzuHome(), "app/ponzu");
const appImageRecord = () => join(ponzuHome(), "app/appimage");

/** The AppImage the person last ran Ponzu from, if it's still there. */
function recordedAppImage(): string | null {
  try {
    const path = readFileSync(appImageRecord(), "utf8").trim();
    return path && existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

/** An install folder, as opposed to a bundle or an AppImage file. */
function isFolder(app: string): boolean {
  try {
    return statSync(app).isDirectory() && !app.endsWith(".app");
  } catch {
    return false;
  }
}

/** The CLI inside an installed app. */
export function appServer(app: string, os = process.platform): string {
  if (os === "darwin") return join(app, SERVER);
  const path = pathFor(os);
  if (os === "linux" && !isFolder(app)) return appImageServer();
  return path.join(app, "resources", "server", os === "win32" ? "ponzu.exe" : "ponzu");
}

/** The command that starts an installed app with no window. */
export function appLauncher(app: string, os = process.platform): [string, string[]] {
  // Through Launch Services, so it runs as the app, not as this process's child. -g keeps
  // focus where it is; -n means a running app gets our argv (and ignores it) rather than a
  // reopen, which would show its window.
  if (app.endsWith(".app")) return ["open", ["-n", "-g", "-a", app, "--args", "--background"]];
  if (isFolder(app))
    return [pathFor(os).join(app, os === "win32" ? "Ponzu.exe" : "ponzu"), ["--background"]];
  return [app, ["--background"]];
}

/**
 * The installed app this binary ships inside, if it does. Not when it runs
 * from somewhere that goes away: the disk image, a quarantine copy, or an
 * AppImage's mount (whose AppImage then counts instead, as does the copy
 * adoptAppImage made of its CLI).
 */
export function ownBundle(
  execPath = process.execPath,
  os = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (os === "darwin") {
    const app = /^(.*?\.app)\/Contents\/Resources\/server\/ponzu$/.exec(execPath)?.[1];
    if (!app || app.startsWith("/Volumes/") || app.includes("/AppTranslocation/")) return null;
    return app;
  }
  if (os === "win32") return /^(.*)\\resources\\server\\ponzu\.exe$/i.exec(execPath)?.[1] ?? null;
  if (execPath === appImageServer()) return recordedAppImage();
  const folder = /^(.*)\/resources\/server\/ponzu$/.exec(execPath)?.[1];
  if (!folder) return null;
  // The AppImage runtime names its mount APPDIR and the file APPIMAGE.
  if (env.APPIMAGE && (folder === env.APPDIR || folder.startsWith("/tmp/.mount_")))
    return env.APPIMAGE;
  return folder.startsWith("/tmp/.mount_") ? null : folder;
}

/** Where each platform's installer puts the app. */
function installedApps(os = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (os === "darwin")
    return ["/Applications/Ponzu.app", join(homedir(), "Applications/Ponzu.app")];
  if (os === "win32") {
    return [
      // NSIS, per user (electron-builder's default) and for every user.
      env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, "Programs", "ponzu"),
      env.ProgramFiles && win32.join(env.ProgramFiles, "Ponzu"),
    ].filter((p): p is string => Boolean(p));
  }
  // The AppImage last opened, then the .deb's folder.
  return [recordedAppImage(), "/opt/Ponzu"].filter((p): p is string => Boolean(p));
}

/** An installed app that's still all there. */
function isInstalled(app: string, os = process.platform): boolean {
  if (os === "linux" && !isFolder(app)) return existsSync(app);
  return existsSync(appServer(app, os));
}

/**
 * The installed desktop app: the one this binary ships in, or one in the
 * usual places. PONZU_APP overrides; PONZU_APP=none opts out.
 */
export function findApp(
  os = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  execPath = process.execPath,
): string | null {
  const override = env.PONZU_APP;
  if (override === "none") return null;
  if (override) return override;
  const candidates = [ownBundle(execPath, os, env), ...installedApps(os, env)];
  return candidates.find((c): c is string => Boolean(c && isInstalled(c, os))) ?? null;
}

/**
 * When this binary runs from inside an AppImage, copy it to ~/.ponzu/app and
 * note the AppImage, so agents and the shim can run it and find the app while
 * the AppImage isn't mounted. Only when it changed: the app does this on
 * every launch. Returns the AppImage, or null when this isn't one.
 */
export async function adoptAppImage(
  execPath = process.execPath,
  os = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (os !== "linux") return null;
  const appimage = ownBundle(execPath, os, env);
  if (!appimage || isFolder(appimage) || execPath === appImageServer()) return null;
  const copy = appImageServer();
  const from = statSync(execPath);
  const to = statSync(copy, { throwIfNoEntry: false });
  if (!to || to.size !== from.size || Math.trunc(to.mtimeMs) !== Math.trunc(from.mtimeMs)) {
    await mkdir(dirname(copy), { recursive: true });
    // A new file renamed over the old: a copy that's running keeps its own.
    const temp = `${copy}.${process.pid}`;
    await copyFile(execPath, temp);
    await chmod(temp, 0o755);
    await utimes(temp, from.atime, from.mtime);
    await rename(temp, copy);
  }
  if (recordedAppImage() !== appimage) await writeFile(appImageRecord(), `${appimage}\n`);
  return appimage;
}

/**
 * Start the desktop app with no window. It serves agents, shows its canvas
 * once the person opens Ponzu, and quits itself (installing any downloaded
 * update) when agents go quiet.
 */
export async function launchApp(app: string, timeoutMs = 30_000): Promise<string | null> {
  // Asked again after 10s: right after an update quits the app, the new bundle
  // may not have been in place yet.
  const deadline = Date.now() + timeoutMs;
  for (let tick = 0; Date.now() < deadline; tick++) {
    if (tick % 40 === 0) startApp(app);
    const url = await runningHost();
    if (url) return url;
    await Bun.sleep(250);
  }
  return null;
}

/**
 * appLauncher's command, run as its own systemd service when this runs as one (Linux's wake
 * helper): systemd stops what a service leaves behind once it exits.
 */
export function launchCommand(
  app: string,
  os = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): [string, string[]] {
  const [cmd, args] = appLauncher(app, os);
  if (os !== "linux" || !env.INVOCATION_ID) return [cmd, args];
  return ["systemd-run", ["--user", "--collect", "--quiet", "--", cmd, ...args]];
}

/**
 * Ask for the desktop app with no window, and don't wait for it. Resolves once
 * it has started; detached, it outlives this process.
 */
export function startApp(app: string): Promise<void> {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const [cmd, args] = launchCommand(app);
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: "ignore", env });
      child.on("error", () => resolve());
      child.on("spawn", () => resolve());
      child.unref();
    } catch {
      resolve();
    }
  });
}

let launching: Promise<string | null> | null = null;
let lastFailed = 0;

/**
 * A running host, or else (with `launch`) the desktop app started in the
 * background. Null when neither: the caller runs tools itself. A launch that
 * failed isn't retried for a minute, so every call doesn't wait 30s.
 */
export async function findHost(launch: boolean): Promise<string | null> {
  const running = await runningHost();
  if (running || !launch) return running;
  if (Date.now() - lastFailed < 60_000) return null;
  const app = findApp();
  if (!app) return null;
  launching ??= launchApp(app).finally(() => {
    launching = null;
  });
  const url = await launching;
  if (!url) lastFailed = Date.now();
  return url;
}

/** Where agents and terminals launch Ponzu from: a batch file on Windows. */
export const shimPath = (os = process.platform) =>
  join(ponzuHome(), os === "win32" ? "bin/ponzu.cmd" : "bin/ponzu");

/**
 * The shim: it runs the server inside whichever Ponzu is installed, so agents
 * and terminals pick up every app update, and still find the app after it
 * moves.
 */
export function shimScript(app: string, os = process.platform): string {
  if (os === "win32") {
    // %VAR% expands inside a quoted path; the app's own path is written out as it is.
    const candidates = [
      appServer(app, os),
      "%LOCALAPPDATA%\\Programs\\ponzu\\resources\\server\\ponzu.exe",
      "%ProgramFiles%\\Ponzu\\resources\\server\\ponzu.exe",
    ];
    // Outside any ( ) block, %ERRORLEVEL% is read after the CLI exits, so its exit code passes on.
    return `@echo off\r
rem Written by Ponzu. Runs the server inside the installed Ponzu, so it updates with the app.\r
setlocal\r
${candidates.map((c) => `if exist "${c}" (\r\n  set "bin=${c}"\r\n  goto run\r\n)\r\n`).join("")}echo Ponzu isn't installed. Download it from https://ponzu.design 1>&2\r
exit /b 1\r
:run\r
"%bin%" %*\r
exit /b %ERRORLEVEL%\r
`;
  }
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  if (os === "darwin")
    return `#!/bin/sh
# Written by Ponzu. Runs the server inside the installed Ponzu.app, so it updates with the app.
for app in ${quote(app)} /Applications/Ponzu.app "$HOME/Applications/Ponzu.app"; do
  bin="$app/${SERVER}"
  [ -x "$bin" ] && exec "$bin" "$@"
done
echo "Ponzu isn't installed. Download it from https://ponzu.design" >&2
exit 1
`;
  const bins = new Set([appServer(app, os), "/opt/Ponzu/resources/server/ponzu", appImageServer()]);
  return `#!/bin/sh
# Written by Ponzu. Runs the server inside the installed Ponzu, so it updates with the app.
for bin in ${[...bins].map(quote).join(" ")}; do
  [ -x "$bin" ] && exec "$bin" "$@"
done
echo "Ponzu isn't installed. Download it from https://ponzu.design" >&2
exit 1
`;
}

/** Write the shim (~/.ponzu/bin/ponzu, or ponzu.cmd on Windows) for `app`. */
export async function writeShim(app: string): Promise<string> {
  const path = shimPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, shimScript(app));
  await chmod(path, 0o755);
  return path;
}
