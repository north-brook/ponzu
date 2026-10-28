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
 * The user's PATH with `dir` added at the end, or null when it's already
 * there. Windows compares paths without case or a trailing backslash.
 */
export function withDir(path: string, dir: string): string | null {
  const norm = (p: string) =>
    p
      .trim()
      .replace(/[\\/]+$/, "")
      .toLowerCase();
  const entries = path.split(";").filter((p) => p.trim());
  if (entries.some((p) => norm(p) === norm(dir))) return null;
  return [...entries, dir].join(";");
}

/**
 * Reads and writes HKCU\Environment's Path as the registry holds it, so
 * entries like %USERPROFILE%\bin stay unexpanded, then has Windows tell
 * running programs, so terminals opened from now on find `ponzu`.
 */
const USER_PATH = `
$key = Get-Item -LiteralPath 'HKCU:Environment'
$path = $key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
if ($env:PONZU_PATH_SET) {
  $kind = if ($key.GetValueNames() -contains 'Path') { $key.GetValueKind('Path') } else { 'ExpandString' }
  Set-ItemProperty -LiteralPath 'HKCU:Environment' -Name Path -Value $env:PONZU_PATH_SET -Type $kind
  [Environment]::SetEnvironmentVariable('PONZU_PATH_CHANGED', '1', 'User')
  [Environment]::SetEnvironmentVariable('PONZU_PATH_CHANGED', $null, 'User')
} else { [Console]::Out.Write($path) }
`;

function powershell(env: Record<string, string> = {}): { ok: boolean; out: string } {
  const out = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", USER_PATH],
    { encoding: "utf8", timeout: 15_000, env: { ...process.env, ...env }, windowsHide: true },
  );
  return { ok: out.status === 0, out: out.stdout ?? "" };
}

/** Windows: put the shim's folder on the person's PATH, once, as linkCommand links it. */
async function addToUserPath(dir: string, auto: boolean | undefined, say: (s: string) => void) {
  const read = powershell();
  if (!read.ok) return say(`To run ponzu from a terminal, add ${dir} to your PATH.`);
  const next = withDir(read.out, dir);
  if (!next) return say(`The ponzu command is on your PATH: ${dir}`);
  const state = readState();
  if (auto && state.linked) return;
  if (!powershell({ PONZU_PATH_SET: next }).ok)
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
