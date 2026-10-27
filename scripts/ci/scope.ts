#!/usr/bin/env bun
/**
 * Which of CI's suites a pull request can affect, so the rest report success
 * without holding a runner. The phone's suites are the reason: a desktop
 * change shouldn't wait on an iOS export or a Mac with a simulator, and a
 * phone change shouldn't package Electron.
 *
 *   bun scripts/ci/scope.ts <base>   name=true|false per suite, for $GITHUB_OUTPUT
 *
 * A changed file belongs to the workspace package whose directory holds it
 * (packages/* and apps/*); a package is affected when it changed or a
 * workspace package it depends on did. Each suite runs when a package it
 * builds or tests is affected. Prose (Markdown, docs/) affects nothing, and
 * neither does a manifest whose only change is its version: that is what a
 * release pull request is, told by its diff, never its branch name. Any
 * other file outside the packages (the lockfile, root configuration, this
 * script, CI) runs everything. The workflow runs everything on a push to main.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type Suite = "desktop" | "mobile";

/** The workspace packages (by directory name) each suite builds or tests. */
const SUITES: Record<Suite, string[]> = {
  // The packaged Electron app, which bundles the CLI's server and the studio.
  desktop: ["desktop", "cli", "studio"],
  // The iPhone app: its checks, export and simulator flows. It can't depend on @ponzu/react,
  // but its canvas and icons import that package's source by path (apps/mobile/canvas).
  mobile: ["mobile", "react"],
};

/** Changes that run every suite: what decides how they all run. */
const EVERYTHING = [/^\.github\/workflows\/ci\.yml$/, /^scripts\/ci\/scope\.ts$/];

/** Changes that run nothing beyond the checks every pull request gets. */
const IGNORED = [
  /\.md$/,
  /^docs\//,
  /^\.github\//,
  /^\.release-please-manifest\.json$/,
  /^release-please-config\.json$/,
  /^commitlint\.config\.mjs$/,
  /^(design|examples|plugin)\//,
  /^\.claude-plugin\//,
  /^\.agents\/plugins\//,
  /(^|\/)CHANGELOG\.md$/,
];

export interface Workspace {
  /** The directory's name: `packages/core` is `core`. */
  name: string;
  dir: string;
  /** The workspace packages it depends on, by directory name. */
  dependencies: string[];
}

/** Every workspace package under apps/ and packages/. */
export function workspaces(root: string): Workspace[] {
  const found: { dir: string; manifest: Record<string, any> }[] = [];
  for (const parent of ["apps", "packages"]) {
    for (const entry of readdirSync(join(root, parent))) {
      const path = join(root, parent, entry, "package.json");
      if (existsSync(path)) {
        found.push({ dir: `${parent}/${entry}`, manifest: JSON.parse(readFileSync(path, "utf8")) });
      }
    }
  }
  const byPackage = new Map(found.map(({ dir, manifest }) => [manifest.name, dir]));
  const short = (dir: string) => dir.slice(dir.indexOf("/") + 1);
  return found.map(({ dir, manifest }) => ({
    name: short(dir),
    dir,
    dependencies: Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
    })
      .map((name) => byPackage.get(name))
      .filter((dep): dep is string => !!dep)
      .map(short),
  }));
}

const VERSION_LINE = /^[+-]\s*"version":\s*"[^"]*",?\s*$/;

/**
 * Whether a file's `git diff -U0` changes nothing but a `"version"` line, as
 * Release Please does to a package's manifest and the phone's app.json.
 */
export function onlyVersionChanged(patch: string): boolean {
  const changes = patch
    .split("\n")
    .filter(
      (line) =>
        (line.startsWith("+") || line.startsWith("-")) &&
        !(line.startsWith("+++") || line.startsWith("---")),
    );
  return changes.length > 0 && changes.every((line) => VERSION_LINE.test(line));
}

/** Which suites these changed files call for. */
export function scope(
  files: readonly string[],
  packages: readonly Workspace[],
): Record<Suite, boolean> {
  const affected = new Set<string>();
  let everything = false;
  for (const file of files) {
    if (EVERYTHING.some((pattern) => pattern.test(file))) {
      everything = true;
      continue;
    }
    if (IGNORED.some((pattern) => pattern.test(file))) continue;
    const owner = packages.find(({ dir }) => file.startsWith(`${dir}/`));
    if (owner) affected.add(owner.name);
    else everything = true;
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const { dependencies, name } of packages) {
      if (!affected.has(name) && dependencies.some((d) => affected.has(d))) {
        affected.add(name);
        grew = true;
      }
    }
  }
  const result = {} as Record<Suite, boolean>;
  for (const [suite, needs] of Object.entries(SUITES)) {
    result[suite as Suite] = everything || needs.some((name) => affected.has(name));
  }
  return result;
}

if (import.meta.main) {
  const [base] = process.argv.slice(2);
  if (!base) throw new Error("usage: bun scripts/ci/scope.ts <base>");
  const root = resolve(import.meta.dir, "../..");
  const git = (...args: string[]) => {
    const out = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (out.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${out.stderr}`);
    return out.stdout;
  };
  // No rename detection: a file moved between packages lists both its old and its new path.
  const files = git("diff", "--name-only", "--no-renames", `${base}...HEAD`)
    .split("\n")
    .filter(Boolean)
    .filter(
      (file) =>
        !file.endsWith(".json") ||
        !onlyVersionChanged(git("diff", "-U0", `${base}...HEAD`, "--", file)),
    );
  for (const [suite, run] of Object.entries(scope(files, workspaces(root)))) {
    console.log(`${suite}=${run}`);
  }
}
