/*
 * The studio built once for every Chromium test that serves it, instead of once per test file.
 * `scripts/prebuild-tests.ts <root>` builds the gallery, the app with Ponzu Cloud in memory and
 * the app as it ships into `<root>/<kind>`, each with a stamp of what vite read for it
 * (scripts/prebuild.vite.config.ts). With PONZU_PREBUILT_STUDIO=<root> set, buildGallery and
 * buildApp hand each test file its own copy of that build; unset, they build for themselves as
 * before. A build that isn't there, or whose sources changed, appeared or went after it was made,
 * throws: a test never runs on old code.
 */
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Kind = "gallery" | "e2e" | "production";
export const KINDS: Kind[] = ["gallery", "e2e", "production"];
export const PREBUILT_ENV = "PONZU_PREBUILT_STUDIO";
export const STAMP = ".ponzu-prebuilt.json";

export interface Stamp {
  kind: Kind;
  /** The environment the build read (buildEnv). */
  env: Record<string, string>;
  /** Directories every file of which is in `sources`, so a new one there is a change too. */
  scanned: string[];
  /** Every file the build read, with its size and modification time once it was built. */
  sources: Record<string, [size: number, mtimeMs: number]>;
  /** Vite's .env files for the build's mode (envFiles), as they were: null for one not there. */
  envFiles: Record<string, [size: number, mtimeMs: number] | null>;
}

/** The .env files Vite reads from `dir` for `mode`, there or not. */
export function envFiles(dir: string, mode: string): string[] {
  return [".env", ".env.local", `.env.${mode}`, `.env.${mode}.local`].map((f) => join(dir, f));
}

/**
 * What of the environment a build reads: Vite's own variables, and whether it writes source maps
 * (vite.config.ts). NODE_ENV is each kind's own (scripts/prebuild-tests.ts).
 */
export function buildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of Object.keys(process.env).sort()) {
    if (key.startsWith("VITE_")) env[key] = process.env[key]!;
  }
  env.sourcemap = String(
    Boolean(process.env.POSTHOG_CLI_API_KEY && process.env.POSTHOG_CLI_PROJECT_ID),
  );
  return env;
}

/** What a source file is now, as a stamp records it; null once it is gone. */
export function describe(path: string): [number, number] | null {
  try {
    const stat = statSync(path);
    return [stat.size, stat.mtimeMs];
  } catch {
    return null;
  }
}

export function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

/**
 * A fresh copy of the prebuilt `kind`, for the caller to serve and delete; null when
 * PONZU_PREBUILT_STUDIO isn't set. Throws when the build is missing or stale.
 */
export function prebuilt(kind: Kind): string | null {
  const root = process.env[PREBUILT_ENV];
  if (!root) return null;
  const dir = join(root, kind);
  const stale = (why: string) =>
    new Error(
      `${PREBUILT_ENV} is set, but the prebuilt ${kind} in ${dir} ${why}. Rebuild it ` +
        `(bun apps/studio/scripts/prebuild-tests.ts ${root}) or unset ${PREBUILT_ENV}.`,
    );
  const stampPath = join(dir, STAMP);
  if (!existsSync(stampPath)) throw stale("isn't there");
  const stamp = JSON.parse(readFileSync(stampPath, "utf8")) as Stamp;
  if (stamp.kind !== kind || Object.keys(stamp.sources).length === 0 || !stamp.envFiles) {
    throw stale("has a stamp for something else");
  }
  if (JSON.stringify(stamp.env) !== JSON.stringify(buildEnv())) {
    throw stale("was built with other VITE_ variables than these");
  }
  for (const [path, [size, mtimeMs]] of Object.entries(stamp.sources)) {
    const now = describe(path);
    if (!now) throw stale(`was built from ${path}, which is gone`);
    if (now[0] !== size || now[1] !== mtimeMs) throw stale(`is older than ${path}`);
  }
  for (const [path, then] of Object.entries(stamp.envFiles)) {
    if (JSON.stringify(describe(path)) !== JSON.stringify(then)) {
      throw stale(`was built before ${path} was made, changed or removed`);
    }
  }
  for (const path of stamp.scanned.flatMap(filesUnder)) {
    if (!stamp.sources[path]) throw stale(`was built before ${path} was made`);
  }
  const copy = mkdtempSync(join(tmpdir(), `ponzu-${kind}-`));
  cpSync(dir, copy, { recursive: true });
  return copy;
}
