/*
 * Holds Resend's SDK behind its seam: deps/mail.ts is the only file in the repository that
 * imports it, and apps/api is the only package that depends on it. Everything else reaches
 * email through the `Mail` interface, which FakeMail also implements.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");
const SEAM = "apps/api/src/deps/mail.ts";
const SDK = "resend";

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

test("only deps/mail.ts imports resend", async () => {
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

test("only apps/api depends on resend, pinned exactly", async () => {
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
  expect(dependents).toEqual(["apps/api/package.json:dependencies:6.37.0"]);
});

test("the check catches every way of importing it", () => {
  for (const line of [
    `import { Resend } from "${SDK}";`,
    `import Resend from '${SDK}';`,
    `import type { CreateEmailOptions } from "${SDK}";`,
    `export { Resend } from "${SDK}";`,
    `import "${SDK}";`,
    `const sdk = await import("${SDK}");`,
    `const sdk = require('${SDK}');`,
    `import values from "${SDK}/dist/index.mjs";`,
  ]) {
    expect(IMPORTS_SDK.test(line)).toBe(true);
  }
  expect(IMPORTS_SDK.test(`import { Resend } from "${SDK}-other";`)).toBe(false);
  expect(IMPORTS_SDK.test(`// email goes through ${SDK} in deps/mail.ts`)).toBe(false);
});
