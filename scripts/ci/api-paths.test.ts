/**
 * api-paths.ts against what the bundles really read: the API's entry as apps/api/scripts/build.ts
 * builds it, and the runner's three entries as apps/runner/scripts/build.ts does, each with Bun's
 * metafile, which lists every input file. Nothing is written: the outputs stay in memory.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { API_PACKAGES, changesApi, DEPLOY_FILES, isInert } from "./api-paths.ts";

const ROOT = resolve(import.meta.dir, "../..");

const BUILDS: { entry: string; target: "node" | "bun"; external: string[] }[] = [
  { entry: "apps/api/src/index.ts", target: "node", external: ["hono", "hono/*"] },
  { entry: "apps/runner/src/main.ts", target: "bun", external: ["playwright-core"] },
  { entry: "apps/runner/src/supervise.ts", target: "bun", external: ["playwright-core"] },
  { entry: "apps/runner/src/credential.ts", target: "bun", external: ["playwright-core"] },
];

/** Every file of the repository's own that went into a bundle, from the repository's root. */
async function bundledFiles(): Promise<string[]> {
  const files = new Set<string>();
  for (const { entry, target, external } of BUILDS) {
    const built = await Bun.build({
      entrypoints: [join(ROOT, entry)],
      target,
      format: "esm",
      external,
      metafile: true,
    });
    if (!built.success) throw new Error(`${entry} did not build: ${built.logs.join("\n")}`);
    const metafile = (built as unknown as { metafile?: { inputs: Record<string, unknown> } })
      .metafile;
    if (!metafile) throw new Error("This Bun writes no metafile.");
    for (const input of Object.keys(metafile.inputs)) {
      const absolute = isAbsolute(input) ? input : resolve(process.cwd(), input);
      const path = relative(ROOT, absolute);
      // Installed packages are pinned by bun.lock, which is listed.
      if (path.includes("node_modules/") || path.startsWith("..")) continue;
      files.add(path);
    }
  }
  return [...files].sort();
}

describe("what the API is made from", () => {
  test("every file the bundles read is listed, and every listed package gives them one", async () => {
    const files = await bundledFiles();
    expect(files.length).toBeGreaterThan(100);
    expect(files.filter((file) => !changesApi(file))).toEqual([]);
    expect(files.filter(isInert)).toEqual([]);
    const packages = new Set(
      files.map((file) => API_PACKAGES.find((dir) => file.startsWith(`${dir}/`))),
    );
    expect([...API_PACKAGES].filter((dir) => !packages.has(dir))).toEqual([]);
  }, 120_000);

  test("every file the deploy names exists", () => {
    for (const file of DEPLOY_FILES) expect(existsSync(join(ROOT, file))).toBe(true);
    for (const dir of API_PACKAGES) expect(existsSync(join(ROOT, dir, "package.json"))).toBe(true);
  });

  test("a test, Markdown or another package's change deploys nothing", () => {
    expect(changesApi("apps/api/src/routes/canvases.ts")).toBe(true);
    expect(changesApi("packages/db/migrations/0032_billing.sql")).toBe(true);
    expect(changesApi("packages/db/migrations/meta/_journal.json")).toBe(true);
    expect(changesApi("packages/tools/src/local/x.ts")).toBe(true);
    expect(changesApi("apps/runner/image/current.json")).toBe(true);
    expect(changesApi("bun.lock")).toBe(true);
    expect(changesApi(".github/workflows/deploy-api.yml")).toBe(true);
    expect(changesApi("scripts/ci/canary.ts")).toBe(true);
    expect(changesApi("apps/api/src/routes/canvases.test.ts")).toBe(false);
    expect(changesApi("apps/api/README.md")).toBe(false);
    expect(changesApi("apps/studio/src/app/main-window.tsx")).toBe(false);
    expect(changesApi("apps/mobile/app/index.tsx")).toBe(false);
    expect(changesApi("packages/client/src/api.ts")).toBe(false);
    expect(changesApi("docs/production.md")).toBe(false);
    expect(changesApi(".github/workflows/ci.yml")).toBe(false);
    // A directory whose name starts like a listed one is not it.
    expect(changesApi("apps/api-docs/x.ts")).toBe(false);
  });
});
