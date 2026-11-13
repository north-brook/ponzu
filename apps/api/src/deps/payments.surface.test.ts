/*
 * Holds Stripe's SDK behind its seam: deps/payments.ts is the only file in the repository that
 * imports it, and apps/api is the only package that depends on it, pinned exactly. Everything
 * else reaches Stripe through the `Payments` interface, which FakePayments also implements; the
 * setup script calls the seam's `ensureStripeCatalog`.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");
const SEAM = "apps/api/src/deps/payments.ts";
const SDK = "stripe";

const IMPORTS_SDK = new RegExp(
  [
    String.raw`\bfrom\s+["']${SDK}(\/[^"']*)?["']`,
    String.raw`\bimport\s+["']${SDK}(\/[^"']*)?["']`,
    String.raw`\bimport\(\s*["']${SDK}(\/[^"']*)?["']`,
    String.raw`\brequire\(\s*["']${SDK}(\/[^"']*)?["']`,
  ].join("|"),
);

function trackedFiles(): string[] {
  const listed = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: ROOT,
  });
  expect(listed.exitCode).toBe(0);
  return listed.stdout.toString().split("\n").filter(Boolean);
}

test("only deps/payments.ts imports stripe", async () => {
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

test("only apps/api depends on stripe, pinned exactly at 23.1.0", async () => {
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
  expect(dependents).toEqual(["apps/api/package.json:dependencies:23.1.0"]);
});

test("the check catches every way of importing it, and nothing that only names it", () => {
  for (const line of [
    `import Stripe from "${SDK}";`,
    `import { Stripe } from '${SDK}';`,
    `import type { Stripe } from "${SDK}";`,
    `export { Stripe } from "${SDK}";`,
    `import "${SDK}";`,
    `const sdk = await import("${SDK}");`,
    `const sdk = require('${SDK}');`,
    `import x from "${SDK}/esm/stripe.esm.node.js";`,
  ]) {
    expect(IMPORTS_SDK.test(line)).toBe(true);
  }
  expect(IMPORTS_SDK.test(`import x from "${SDK}-mock";`)).toBe(false);
  expect(IMPORTS_SDK.test(`import x from "@${SDK}/stripe-js";`)).toBe(false);
  expect(IMPORTS_SDK.test(`// payments go through ${SDK} in deps/payments.ts`)).toBe(false);
});
