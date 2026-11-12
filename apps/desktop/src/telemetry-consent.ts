import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * Whether this person has said no to usage reporting, the ways Ponzu 1.x let them say it
 * (its CLI's telemetry.ts): `PONZU_TELEMETRY=0`, `DO_NOT_TRACK`, a CI machine, or
 * `ponzu telemetry off`, which wrote `"enabled": false` to ~/.ponzu/telemetry.json. Someone who
 * turned it off for 1.x stays off in the cloud app. There is no switch of its own in the app's
 * settings yet (docs/analytics.md, "Turning it off").
 */

const falsy = (v?: string) => v !== undefined && /^(0|false|off|no)$/i.test(v.trim());
const truthy = (v?: string) => v !== undefined && v.trim() !== "" && !falsy(v);

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
    text = read(join(home, ".ponzu", "telemetry.json"));
  } catch (error) {
    // No file: 1.x was never told anything here. One that is there but can't be read, 1.x
    // took as off, and so does this.
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? null
      : "~/.ponzu/telemetry.json can't be read";
  }
  try {
    const saved = JSON.parse(text) as { enabled?: unknown } | null;
    return saved?.enabled === false ? "turned off with `ponzu telemetry off`" : null;
  } catch {
    return "~/.ponzu/telemetry.json can't be read";
  }
}
