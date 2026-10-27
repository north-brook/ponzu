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
 * app menu's Install Terminal Command adds /usr/local/bin with one.
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
  const found = Bun.which("ponzu", { PATH: opts.path.join(delimiter) });
  if (found) {
    if (sameFile(found, shim)) say(`The ponzu command is on your PATH: ${found}`);
    return;
  }
  const state = readState();
  if (opts.auto && state.linked) return;
  const dir = commandDirs(opts.home).find((d) => opts.path.includes(d) && canLink(d, opts.home));
  if (!dir) {
    say(
      `To run ponzu from a terminal, add ${dirname(shim)} to your PATH, or choose Install Terminal Command in Ponzu's app menu.`,
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

function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}
