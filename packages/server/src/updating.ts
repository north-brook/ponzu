import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { compareVersions } from "@ponzu/core";

/*
 * An update installing, in ~/.ponzu/updating.json. The desktop app writes it just before it quits
 * into an update. Squirrel's installer on a Mac gives up if any Ponzu is running when it swaps the
 * bundle, and so does the Windows installer's, so nothing may start the old Ponzu meanwhile: an
 * agent's `ponzu mcp` reads it and waits for the updated app instead of launching one, and an old
 * app launched in the background (by an agent's older `ponzu mcp`, which doesn't read it) quits at
 * once. The updated app clears it when it starts.
 */

export interface Updating {
  from: string;
  to: string;
  at: number;
  /** A launch already said how this install went, so no other launch says it again. */
  told?: boolean;
}

/** Longer than any install takes: an older marker is an install that failed. */
export const UPDATING_WITHIN = 2 * 60_000;

const updatingFile = () =>
  join(process.env.PONZU_HOME ?? join(homedir(), ".ponzu"), "updating.json");

function read(): Updating | null {
  try {
    const u = JSON.parse(readFileSync(updatingFile(), "utf8")) as Partial<Updating>;
    if (typeof u.from !== "string" || typeof u.to !== "string" || typeof u.at !== "number")
      return null;
    return { from: u.from, to: u.to, at: u.at, ...(u.told ? { told: true } : {}) };
  } catch {
    return null;
  }
}

/** Say an update to `to` is about to install. */
export function markUpdating(from: string, to: string, now = Date.now()) {
  write({ from, to, at: now });
}

/** Renamed into place, so no reader sees half of it. */
function write(u: Updating) {
  try {
    mkdirSync(dirname(updatingFile()), { recursive: true });
    const temp = `${updatingFile()}.${process.pid}`;
    writeFileSync(temp, `${JSON.stringify(u)}\n`);
    renameSync(temp, updatingFile());
  } catch {}
}

/** The update installing right now, if one is. */
export function updating(now = Date.now()): Updating | null {
  const u = read();
  return u && now - u.at < UPDATING_WITHIN ? u : null;
}

/**
 * Whether a Ponzu at `version`, launched in the background, is the one an update is replacing:
 * starting would stop the install.
 */
export function replacedByUpdate(version: string, now = Date.now()): boolean {
  const u = updating(now);
  return Boolean(u && compareVersions(version, u.to) < 0);
}

/**
 * At launch: whether the update before it installed (this is the version it went to) or was
 * interrupted (this is still older), told once per install. Undefined when no update came before,
 * or a launch already told. Clears the marker, except while an install it interrupted may still be
 * going: the person opened the old Ponzu meanwhile, and if they quit it, agents still mustn't
 * start it under the installer.
 */
export function settleUpdate(
  version: string,
  now = Date.now(),
): "installed" | "interrupted" | undefined {
  const u = read();
  if (!u) return undefined;
  const installed = compareVersions(version, u.to) >= 0;
  if (installed || now - u.at >= UPDATING_WITHIN) clearUpdating();
  else if (!u.told) write({ ...u, told: true });
  if (u.told) return undefined;
  return installed ? "installed" : "interrupted";
}

export function clearUpdating() {
  try {
    rmSync(updatingFile(), { force: true });
  } catch {}
}
