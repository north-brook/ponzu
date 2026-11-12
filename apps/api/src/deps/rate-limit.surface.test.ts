/*
 * Holds Vercel's firewall SDK behind its seam: deps/rate-limit.ts is the only file in the
 * repository that imports it, and apps/api is the only package that depends on it, pinned
 * exactly. Everything else reaches rate limits through the `RateLimit` interface, which
 * FakeRateLimit also implements.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");
const SEAM = "apps/api/src/deps/rate-limit.ts";
const SDK = "@vercel/firewall";

const IMPORTS_SDK = new RegExp(
  [
    String.raw`\bfrom\s+["']${SDK}(\/[^"']*)?["']`,
    String.raw`\bimport\s+["']${SDK}(\/[^"']*)?["']`,
    String.raw`\bimport\(\s*["']${SDK}`,
    String.raw`\brequire\(\s*["']${SDK}`,
  ].join("|"),
);

function trackedFiles(): string[] {
  const listed = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: ROOT,
  });
  expect(listed.exitCode).toBe(0);
  return listed.stdout.toString().split("\n").filter(Boolean);
}

test("only deps/rate-limit.ts imports @vercel/firewall", async () => {
  const offenders: string[] = [];
  let seamImports = false;
  for (const file of trackedFiles()) {
    if (!/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(file)) continue;
    const handle = Bun.file(join(ROOT, file));
    if (!(await handle.exists())) continue;
    const imports = IMPORTS_SDK.test(await handle.text());
    if (file === SEAM) seamImports = imports;
    else if (imports) offenders.push(file);
  }
  expect(offenders).toEqual([]);
  // The check can see an import: the seam's own is found.
  expect(seamImports).toBe(true);
});

test("only apps/api depends on @vercel/firewall, pinned exactly", async () => {
  const dependents: string[] = [];
  for (const file of trackedFiles()) {
    if (!file.endsWith("package.json")) continue;
    const handle = Bun.file(join(ROOT, file));
    if (!(await handle.exists())) continue;
    const manifest = (await handle.json()) as Record<string, Record<string, string> | undefined>;
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      if (manifest[field]?.[SDK]) dependents.push(`${file}:${field}:${manifest[field][SDK]}`);
    }
  }
  expect(dependents).toEqual(["apps/api/package.json:dependencies:1.2.6"]);
});

test("the check catches every way of importing it", () => {
  for (const line of [
    `import { checkRateLimit } from "${SDK}";`,
    `import { unstable_checkRateLimit as check } from '${SDK}';`,
    `export { checkRateLimit } from "${SDK}";`,
    `import "${SDK}";`,
    `const sdk = await import("${SDK}");`,
    `const sdk = require('${SDK}');`,
    `import { checkRateLimit } from "${SDK}/dist/rate-limit.js";`,
  ]) {
    expect(IMPORTS_SDK.test(line)).toBe(true);
  }
  expect(IMPORTS_SDK.test(`import { x } from "${SDK}-other";`)).toBe(false);
  expect(IMPORTS_SDK.test(`// limits go through ${SDK} in deps/rate-limit.ts`)).toBe(false);
});
