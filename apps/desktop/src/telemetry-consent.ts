import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/*
 * Whether this person has said no to usage reporting on this computer: `PONZU_TELEMETRY=0`,
 * `DO_NOT_TRACK`, a CI machine, or `"enabled": false` in ~/.ponzu/telemetry.json. The file is
 * the one Ponzu 1.x's `ponzu telemetry off` wrote, so someone who turned it off for 1.x stays
 * off; the app writes it too, when the person turns Settings › Account › Share usage data off
 * or on (`writeUsageSharing`). The account's switch itself lives on the API (`users.share_usage`)
 * and stops the server's and the agent's analytics; this file is what the shell reads at launch,
 * before anyone is signed in (docs/analytics.md, "Turning it off").
 */

const falsy = (v?: string) => v !== undefined && /^(0|false|off|no)$/i.test(v.trim());
const truthy = (v?: string) => v !== undefined && v.trim() !== "" && !falsy(v);

/** Where the switch is kept on this computer. */
export function telemetryFile(home: string): string {
  return join(home, ".ponzu", "telemetry.json");
}

/** Why usage reporting is off for this person, or null when nothing says so. */
export function telemetryOffBecause(
  env: NodeJS.ProcessEnv,
  home: string,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): string | null {
  if (falsy(env.PONZU_TELEMETRY)) return "PONZU_TELEMETRY is off";
  if (truthy(env.DO_NOT_TRACK)) return "DO_NOT_TRACK is set";
  if (truthy(env.CI)) return "running in CI";
  let text: string;
  try {
    text = read(telemetryFile(home));
  } catch (error) {
    // No file: nothing was ever said here. One that is there but can't be read, 1.x took as
    // off, and so does this.
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? null
      : "~/.ponzu/telemetry.json can't be read";
  }
  try {
    const saved = JSON.parse(text) as { enabled?: unknown } | null;
    return saved?.enabled === false
      ? "turned off in Settings › Account, or with `ponzu telemetry off`"
      : null;
  } catch {
    return "~/.ponzu/telemetry.json can't be read";
  }
}

/** The file system `writeUsageSharing` uses: Node's, or a test's. */
export interface ConsentFiles {
  read(path: string): string;
  write(path: string, text: string): void;
  rename(from: string, to: string): void;
  mkdir(path: string): void;
}

const nodeFiles: ConsentFiles = {
  read: (path) => readFileSync(path, "utf8"),
  write: (path, text) => writeFileSync(path, text, { mode: 0o600 }),
  rename: (from, to) => renameSync(from, to),
  mkdir: (path) => mkdirSync(path, { recursive: true }),
};

/**
 * Says in ~/.ponzu/telemetry.json whether this person shares usage data, keeping whatever else
 * 1.x kept there (its anonymous id). Written whole to a file beside it and moved into place, so
 * a crash halfway leaves the old file, never half of one. A file that can't be read as JSON is
 * replaced.
 */
export function writeUsageSharing(
  home: string,
  enabled: boolean,
  files: ConsentFiles = nodeFiles,
): void {
  const path = telemetryFile(home);
  let kept: Record<string, unknown> = {};
  try {
    const saved = JSON.parse(files.read(path)) as unknown;
    if (saved && typeof saved === "object" && !Array.isArray(saved)) {
      kept = saved as Record<string, unknown>;
    }
  } catch {}
  files.mkdir(join(home, ".ponzu"));
  const next = `${path}.${process.pid}.tmp`;
  files.write(next, `${JSON.stringify({ ...kept, enabled }, null, 2)}\n`);
  files.rename(next, path);
}
