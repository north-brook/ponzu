import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * Where an app keeps Chromium's profile, its session file and its record of the 1.x cleanup: a
 * folder in the system's app data folder named after the app (config.ts's `appName`), so Ponzu,
 * Ponzu Preview and Ponzu Dev each have their own and none reads another's. The single-instance
 * lock lives in it too, which is what lets them run at once.
 *
 * The smoke check has none of them: it runs on a throwaway folder, so checking a packaged app on
 * someone's Mac (where Ponzu's folder may still be Ponzu 1.x's) writes nothing of theirs.
 */

/** Chosen before anything reads the folder: before `ready`, and before the instance lock. */
export function dataFolder(
  appData: string,
  appName: string,
  opts: { smoke: boolean; temporary?: () => string },
): string {
  if (opts.smoke) return (opts.temporary ?? throwawayDataFolder)();
  return join(appData, appName);
}

/** A new, empty folder under the system's temporary folder, for `removeOnceExited`. */
export function throwawayDataFolder(parent = tmpdir()): string {
  return mkdtempSync(join(parent, "ponzu-smoke-"));
}

/**
 * Removes `folder` once this process has gone. Chromium writes its profile (session storage,
 * Local State) as the app exits, after anything in the process could remove it, so a shell
 * outside waits for the process to end, then removes it. Windows has no such shell here: the
 * folder is removed now, and what Chromium writes after stays in the temporary folder.
 */
export function removeOnceExited(folder: string, pid = process.pid): void {
  if (process.platform === "win32") {
    rmSync(folder, { recursive: true, force: true });
    return;
  }
  const wait = 'while kill -0 "$1" 2>/dev/null; do sleep 0.1; done; rm -rf "$0"';
  spawn("/bin/sh", ["-c", wait, folder, String(pid)], { detached: true, stdio: "ignore" }).unref();
}
