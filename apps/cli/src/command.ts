import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { ponzuHome } from "./host.ts";

/**
 * `ponzu` in a terminal. Agents launch the shim the desktop app writes
 * (~/.ponzu/bin/ponzu), which no shell searches; this links it into a folder
 * the person's shell does, so it updates with the app too. Only folders that
 * are theirs to write without a password, never a package manager's: the
 * app menu's Install Terminal Command adds /usr/local/bin with one. Windows
 * has no such folder: the shim's own goes on the person's PATH instead.
 */
export function commandDirs(home = homedir()): string[] {
  return [join(home, ".local/bin"), join(home, "bin"), "/usr/local/bin"];
}

const stateFile = () => join(ponzuHome(), "command.json");

/**
 * Link the shim onto `path` (the login shell's PATH) unless a `ponzu` is
 * already there, ours or anyone's. The launch check (`auto`) links once: a
 * link the person has since removed stays removed, as agents do.
 */
export async function linkCommand(
  shim: string,
  opts: { auto?: boolean; path: string[]; home?: string },
): Promise<void> {
  const say = (s: string) => {
    if (!opts.auto) console.log(s);
  };
  if (process.platform === "win32") return addToUserPath(dirname(shim), opts.auto, say);
  const found = Bun.which("ponzu", { PATH: opts.path.join(delimiter) });
  // The .deb links /usr/bin/ponzu to the app itself, which a link earlier on the PATH can stand in front of.
  const app = found && opensApp(found) ? found : null;
  if (found && !app) {
    if (sameFile(found, shim)) say(`The ponzu command is on your PATH: ${found}`);
    return;
  }
  const state = readState();
  if (opts.auto && state.linked) return;
  const before = app ? opts.path.indexOf(dirname(app)) : -1;
  const dir = commandDirs(opts.home).find((d) => {
    const at = opts.path.indexOf(d);
    return at >= 0 && (before < 0 || at < before) && canLink(d, opts.home);
  });
  if (!dir) {
    say(
      process.platform === "darwin"
        ? `To run ponzu from a terminal, add ${dirname(shim)} to your PATH, or choose Install Terminal Command in Ponzu's app menu.`
        : `To run ponzu from a terminal, add ${dirname(shim)} to your PATH.`,
    );
    return;
  }
  const link = join(dir, "ponzu");
  try {
    await mkdir(dir, { recursive: true });
    await symlink(shim, link);
  } catch {
    say(`Couldn't link ponzu into ${dir}.`);
    return;
  }
  await mkdir(dirname(stateFile()), { recursive: true });
  await writeFile(stateFile(), `${JSON.stringify({ linked: link }, null, 2)}\n`);
  say(`Linked ${link}, so ponzu runs from a terminal.`);
}

/**
 * Windows: whether `dir` is on the user's PATH (HKCU\Environment), adding it
 * at the end with `add`. The PATH never leaves PowerShell, so nothing in it is
 * re-encoded: it's read and written as the registry holds it, so entries like
 * %USERPROFILE%\bin stay unexpanded, and compared without case or a trailing
 * backslash. Once it changes, Windows tells running programs, so terminals
 * opened from now on find `ponzu`. PONZU_ENVIRONMENT_KEY moves it, for tests.
 */
const USER_PATH = String.raw`
$at = if ($env:PONZU_ENVIRONMENT_KEY) { $env:PONZU_ENVIRONMENT_KEY } else { 'HKCU:\Environment' }
$key = Get-Item -LiteralPath $at
$norm = { param($p) $p.Trim().TrimEnd('\', '/') }
$entries = @(([string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')) -split ';' | Where-Object { $_.Trim() })
if ($entries | Where-Object { (& $norm $_) -ieq (& $norm $env:PONZU_BIN) }) { exit 0 }
if (-not $env:PONZU_ADD) { exit 3 }
$kind = if ($key.GetValueNames() -contains 'Path') { $key.GetValueKind('Path') } else { 'ExpandString' }
Set-ItemProperty -LiteralPath $at -Name Path -Value (($entries + $env:PONZU_BIN) -join ';') -Type $kind
if (-not $env:PONZU_ENVIRONMENT_KEY) {
  [Environment]::SetEnvironmentVariable('PONZU_PATH_CHANGED', '1', 'User')
  [Environment]::SetEnvironmentVariable('PONZU_PATH_CHANGED', $null, 'User')
}
exit 2
`;

export type UserPath = "on" | "off" | "added" | "failed";

export function userPath(dir: string, add: boolean, env: Record<string, string> = {}): UserPath {
  const out = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", USER_PATH],
    {
      stdio: "ignore",
      timeout: 15_000,
      env: { ...process.env, ...env, PONZU_BIN: dir, ...(add ? { PONZU_ADD: "1" } : {}) },
      windowsHide: true,
    },
  );
  return (
    ({ 0: "on", 3: "off", 2: "added" } as Record<number, UserPath>)[out.status ?? -1] ?? "failed"
  );
}

/** Windows: put the shim's folder on the person's PATH, once, as linkCommand links it. */
async function addToUserPath(dir: string, auto: boolean | undefined, say: (s: string) => void) {
  const now = userPath(dir, false);
  if (now === "on") return say(`The ponzu command is on your PATH: ${dir}`);
  if (now === "failed") return say(`To run ponzu from a terminal, add ${dir} to your PATH.`);
  if (auto && readState().linked) return;
  if (userPath(dir, true) !== "added")
    return say(`Couldn't add ${dir} to your PATH. Add it yourself to run ponzu from a terminal.`);
  await mkdir(dirname(stateFile()), { recursive: true });
  await writeFile(stateFile(), `${JSON.stringify({ linked: dir }, null, 2)}\n`);
  say(`Added ${dir} to your PATH. Open a new terminal and run ponzu.`);
}

function readState(): { linked?: string } {
  try {
    return JSON.parse(readFileSync(stateFile(), "utf8")) as { linked?: string };
  } catch {
    return {};
  }
}

/** Writable with nothing called ponzu in it, not even a broken link. A missing folder in the home folder is made. */
function canLink(dir: string, home = homedir()): boolean {
  try {
    lstatSync(join(dir, "ponzu"));
    return false;
  } catch {}
  if (!existsSync(dir)) return dir.startsWith(`${home}/`);
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** The desktop app's own executable, which keeps the CLI in resources/server beside it. */
function opensApp(file: string): boolean {
  try {
    return existsSync(join(dirname(realpathSync(file)), "resources/server/ponzu"));
  } catch {
    return false;
  }
}

function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}
