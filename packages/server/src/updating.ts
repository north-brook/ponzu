import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    return { from: u.from, to: u.to, at: u.at };
  } catch {
    return null;
  }
}

/** Say an update to `to` is about to install. */
export function markUpdating(from: string, to: string, now = Date.now()) {
  try {
    mkdirSync(dirname(updatingFile()), { recursive: true });
    writeFileSync(updatingFile(), `${JSON.stringify({ from, to, at: now })}\n`);
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
 * interrupted (this is still older). Clears the marker. Undefined when no update came before.
 */
export function settleUpdate(version: string): "installed" | "interrupted" | undefined {
  const u = read();
  if (!u) return undefined;
  clearUpdating();
  return compareVersions(version, u.to) >= 0 ? "installed" : "interrupted";
}

export function clearUpdating() {
  try {
    rmSync(updatingFile(), { force: true });
  } catch {}
}
