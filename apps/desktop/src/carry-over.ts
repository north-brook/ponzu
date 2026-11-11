import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { APP_NAMES } from "./config.ts";

/*
 * Ponzu Dev's first launch on a Mac that had its earlier names. It was "Ponzu Preview" (bundle id
 * design.ponzu.app.preview) and a run from a checkout was "Ponzu Dev"; now the installed app is
 * Ponzu Dev and the checkout run Ponzu Local. Once, before anything opens the data folder:
 *
 * - A "Ponzu Dev" folder this app didn't make (no record in it) is a checkout run's, from
 *   before the rename: its session is sealed by a keychain item another program made, which this
 *   app can't open without asking. It moves to "Ponzu Local", where the checkout run now looks,
 *   or beside it when that is taken. Nothing is deleted.
 * - Ponzu Preview's window state (the studio's localStorage: the workspace and design last
 *   open, the sidebar, the rail, the filters) is copied in, when Ponzu Preview isn't running.
 *   Its session is not: it is sealed by "Ponzu Preview Safe Storage", which only Ponzu Preview
 *   can open. The person signs in again, once, and the window comes back as they left it.
 *
 * Ponzu Preview's app and folder are left where they are, for the person to remove.
 *
 * Signed out, the app forgets what the studio kept (main.ts). What came over waits for the first
 * sign-in instead, while the record says so (`awaitingSignIn`); a sign-out wipes it as ever.
 */

export const PREVIEW_NAME = "Ponzu Preview";
/** In Ponzu Dev's folder: what its first launch did, and that the folder is its own. */
export const RECORD = "carried-over.json";
/** Chromium's localStorage for every origin, the studio's among them. */
const LOCAL_STORAGE = "Local Storage";

export interface CarryOver {
  at: string;
  /** Where a checkout run's "Ponzu Dev" folder went, if there was one. */
  checkoutFolder: string | null;
  /** What became of Ponzu Preview's window state. */
  windowState: "copied" | "none" | "running";
  /** True until the first sign-in: the copied window state is kept while signed out. */
  awaitingSignIn: boolean;
}

export interface CarryOverHost {
  appData: string;
  /** Whether an app holds the single-instance lock in `folder` now. */
  running(folder: string): boolean;
  now(): Date;
}

/** Done before the instance lock, which lives in the folder. Null when it was done before. */
export function carryOver(host: CarryOverHost): CarryOver | null {
  const folder = join(host.appData, APP_NAMES.dev);
  if (existsSync(join(folder, RECORD))) return null;

  let checkoutFolder: string | null = null;
  if (existsSync(folder)) {
    // A checkout run from before the rename has it open: leave it be, and look again next time.
    if (host.running(folder)) return null;
    checkoutFolder = freeName(host.appData, APP_NAMES.local);
    renameSync(folder, checkoutFolder);
  }

  const preview = join(host.appData, PREVIEW_NAME);
  let windowState: CarryOver["windowState"] = "none";
  if (existsSync(join(preview, LOCAL_STORAGE))) {
    if (host.running(preview)) windowState = "running";
    else {
      // Copied whole beside, then moved in: a copy cut short never looks like the real thing.
      const partial = join(folder, `${LOCAL_STORAGE}.partial`);
      mkdirSync(folder, { recursive: true });
      rmSync(partial, { recursive: true, force: true });
      cpSync(join(preview, LOCAL_STORAGE), partial, { recursive: true });
      rmSync(join(partial, "leveldb", "LOCK"), { force: true });
      renameSync(partial, join(folder, LOCAL_STORAGE));
      windowState = "copied";
    }
  }

  const record: CarryOver = {
    at: host.now().toISOString(),
    checkoutFolder,
    windowState,
    awaitingSignIn: windowState === "copied",
  };
  writeRecord(folder, record);
  return record;
}

/**
 * Ponzu Local's side of the rename: launched before Ponzu Dev has been, it takes its own folder
 * back from under the old name, so either way round the checkout's folder ends up Ponzu Local's.
 * Its session stays sealed by the old name's keychain item ("Ponzu Dev Safe Storage", made by
 * node_modules' Electron.app), so a checkout run signs in again, once. Returns where the folder
 * went, or null.
 */
export function adoptCheckoutFolder(
  host: Pick<CarryOverHost, "appData" | "running">,
): string | null {
  const old = join(host.appData, APP_NAMES.dev);
  const local = join(host.appData, APP_NAMES.local);
  if (existsSync(local) || !existsSync(old) || existsSync(join(old, RECORD))) return null;
  if (host.running(old)) return null;
  renameSync(old, local);
  return local;
}

/** Whether the window state that came over is still waiting for the person to sign in. */
export function awaitingSignIn(folder: string): boolean {
  try {
    return (JSON.parse(readFileSync(join(folder, RECORD), "utf8")) as CarryOver).awaitingSignIn;
  } catch {
    return false;
  }
}

/** Once signed in, the window state is theirs, and a sign-out forgets it as ever. */
export function signedInOnce(folder: string): void {
  try {
    const record = JSON.parse(readFileSync(join(folder, RECORD), "utf8")) as CarryOver;
    if (record.awaitingSignIn) writeRecord(folder, { ...record, awaitingSignIn: false });
  } catch {}
}

function writeRecord(folder: string, record: CarryOver) {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, RECORD), `${JSON.stringify(record, null, 2)}\n`);
}

/** `name` in `parent`, or the first of "name 2", "name 3"… that is free. */
function freeName(parent: string, name: string): string {
  let candidate = join(parent, name);
  for (let n = 2; existsSync(candidate); n++) candidate = join(parent, `${name} ${n}`);
  return candidate;
}

/**
 * Whether an app holds the single-instance lock in `folder`: Chromium's SingletonLock, a link to
 * "<host>-<pid>" on a Mac and Linux, naming a process that is alive.
 */
export function lockHeld(folder: string): boolean {
  let target: string;
  try {
    target = readlinkSync(join(folder, "SingletonLock"));
  } catch {
    return false;
  }
  const pid = Number(/-(\d+)$/.exec(target)?.[1]);
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
