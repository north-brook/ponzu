import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

const SERVER = "Contents/Resources/server/ponzu";

/**
 * The Ponzu.app this binary ships inside, if it does. Not when it runs from
 * the disk image or a quarantine copy: those paths go away.
 */
export function ownBundle(): string | null {
  const app = /^(.*?\.app)\/Contents\/Resources\/server\/ponzu$/.exec(process.execPath)?.[1];
  if (!app || app.startsWith("/Volumes/") || app.includes("/AppTranslocation/")) return null;
  return app;
}

/**
 * The installed desktop app: the bundle this binary ships in, or one in the
 * usual places. PONZU_APP overrides; PONZU_APP=none opts out.
 */
export function findApp(): string | null {
  const override = process.env.PONZU_APP;
  if (override === "none") return null;
  if (override) return override;
  if (process.platform !== "darwin") return null;
  const candidates = [
    ownBundle(),
    "/Applications/Ponzu.app",
    join(homedir(), "Applications/Ponzu.app"),
  ];
  return candidates.find((c): c is string => Boolean(c && existsSync(join(c, SERVER)))) ?? null;
}

/**
 * Start the desktop app with no window. It serves agents, shows its canvas
 * once the person opens Ponzu, and quits itself (installing any downloaded
 * update) when agents go quiet.
 */
export async function launchApp(app: string, timeoutMs = 30_000): Promise<string | null> {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // Through Launch Services, so it runs as the app, not as this agent's child. -g keeps
  // focus where it is; -n means a running app gets our argv (and ignores it) rather
  // than a reopen, which would show its window.
  const [cmd, args] = app.endsWith(".app")
    ? ["open", ["-n", "-g", "-a", app, "--args", "--background"]]
    : [app, ["--background"]];
  const start = () => {
    try {
      spawn(cmd, args, { detached: true, stdio: "ignore", env }).unref();
    } catch {}
  };
  // Asked again after 10s: right after an update quits the app, the new bundle
  // may not have been in place yet.
  const deadline = Date.now() + timeoutMs;
  for (let tick = 0; Date.now() < deadline; tick++) {
    if (tick % 40 === 0) start();
    const url = await runningHost();
    if (url) return url;
    await Bun.sleep(250);
  }
  return null;
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

/** Where agents launch Ponzu from. */
export const shimPath = () => join(ponzuHome(), "bin/ponzu");

/**
 * Write ~/.ponzu/bin/ponzu: it runs the server inside whichever Ponzu.app is
 * installed, so agents registered with it pick up every app update, and
 * still find the app after it moves.
 */
export async function writeShim(app: string): Promise<string> {
  const path = shimPath();
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const script = `#!/bin/sh
# Written by Ponzu. Runs the server inside the installed Ponzu.app, so it updates with the app.
for app in ${quote(app)} /Applications/Ponzu.app "$HOME/Applications/Ponzu.app"; do
  bin="$app/${SERVER}"
  [ -x "$bin" ] && exec "$bin" "$@"
done
echo "Ponzu isn't installed. Download it from https://ponzu.design" >&2
exit 1
`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, script);
  await chmod(path, 0o755);
  return path;
}
