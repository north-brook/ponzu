import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

interface Release {
  version: string;
  notes: string[];
}

/**
 * What's new after an update, once. The build bundles every tagged release's
 * notes (scripts/release-notes.ts, docs/release-notes.md); this compares them
 * with the version whose notes Ponzu last showed, kept in userData. A first
 * install shows nothing and starts counting from here. The renderer marks the
 * notes seen when they're dismissed, so a crash before then shows them again.
 * PONZU_WHATS_NEW_SINCE=<version> previews the notes as if updating from it.
 */
const seenFile = () => join(app.getPath("userData"), "whats-new.json");

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function bundled(): Release[] {
  const file = readJson(join(app.getAppPath(), "dist/release-notes.json")) as {
    releases?: unknown;
  } | null;
  if (!Array.isArray(file?.releases)) return [];
  return file.releases.filter(
    (r): r is Release =>
      typeof r?.version === "string" &&
      Array.isArray(r.notes) &&
      r.notes.every((n: unknown) => typeof n === "string"),
  );
}

function compareVersions(a: string, b: string): number {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) {
    const d = (x![i] || 0) - (y![i] || 0);
    if (d) return d;
  }
  return 0;
}

export function markWhatsNewSeen() {
  try {
    writeFileSync(seenFile(), JSON.stringify({ version: app.getVersion() }));
  } catch {
    // Unwritable userData: the notes show again next launch, which is harmless.
  }
}

export function pendingWhatsNew(): { version: string; notes: string[] } | null {
  const stored = (readJson(seenFile()) as { version?: unknown } | null)?.version;
  const seen = process.env.PONZU_WHATS_NEW_SINCE ?? (typeof stored === "string" ? stored : null);
  if (!seen) {
    markWhatsNewSeen();
    return null;
  }
  const version = app.getVersion();
  const notes = bundled()
    .filter((r) => compareVersions(r.version, seen) > 0 && compareVersions(r.version, version) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version))
    .flatMap((r) => r.notes);
  if (!notes.length) {
    if (compareVersions(version, seen) > 0) markWhatsNewSeen();
    return null;
  }
  return { version, notes };
}
