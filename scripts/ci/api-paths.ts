#!/usr/bin/env bun
/**
 * What the deployed API is made from, so a merge that changes none of it deploys nothing
 * (.github/workflows/deploy-api.yml, its `plan` job, through deploy-plan.ts).
 *
 * The API is one bundle (apps/api/scripts/build.ts) with the runner's bundle inlined in it
 * (apps/runner/scripts/build.ts), installed by Vercel with `bun install --filter @ponzu/api
 * --filter @ponzu/runner`, and migrated by packages/db before it deploys. So it is made from:
 *
 * - the workspace packages either bundle reads a file of (`API_PACKAGES`);
 * - what installs them: the lockfile, the root manifest and bunfig.toml;
 * - the deploy itself: this workflow and the scripts its steps run (`DEPLOY_FILES`), so a change
 *   to how the API is deployed or checked is tried at once rather than at the next API change.
 *
 * Inside those packages a test file or a Markdown file changes nothing that ships.
 * api-paths.test.ts builds both bundles, reads which files went into them (Bun's metafile), and
 * fails when a bundled file is outside this list, when a listed package gives the bundles no
 * file, or when a bundled file is one this list calls a test.
 *
 *   bun scripts/ci/api-paths.ts <file>...    prints the files that change the API
 */

/** Every workspace package a bundle reads, by directory. */
export const API_PACKAGES = [
  "apps/api",
  "apps/runner",
  "packages/core",
  "packages/db",
  "packages/email",
  "packages/render",
  "packages/sandbox",
  "packages/tools",
] as const;

/** Files outside those packages that decide what is installed, built or run by the deploy. */
export const DEPLOY_FILES = [
  "bun.lock",
  "package.json",
  "bunfig.toml",
  ".github/workflows/deploy-api.yml",
  "scripts/ci/api-paths.ts",
  "scripts/ci/canary.ts",
  "scripts/ci/deploy-plan.ts",
  "scripts/ci/deploy-report.ts",
  "scripts/ci/health.ts",
  "scripts/ci/production.ts",
  "scripts/ci/schedules.ts",
  "scripts/ci/selfcheck.ts",
] as const;

/** Inside a package, files that never reach a bundle or a migration. */
const INERT = [/\.test\.tsx?$/, /\.live\.test\.tsx?$/, /\.md$/];

/** Whether a changed file (a path from the repository's root) changes the deployed API. */
export function changesApi(file: string): boolean {
  if ((DEPLOY_FILES as readonly string[]).includes(file)) return true;
  if (!API_PACKAGES.some((dir) => file.startsWith(`${dir}/`))) return false;
  return !INERT.some((pattern) => pattern.test(file));
}

/** Whether a bundled file is one `changesApi` would ignore: a test or Markdown. */
export function isInert(file: string): boolean {
  return INERT.some((pattern) => pattern.test(file));
}

if (import.meta.main) {
  for (const file of process.argv.slice(2)) if (changesApi(file)) console.log(file);
}
