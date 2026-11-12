/*
 * Holds Expo's server SDK behind its seam: deps/push.ts is the only file in the repository that
 * imports it, and apps/api is the only package that depends on it. Everything else reaches
 * push through the `Push` interface, which FakePush also implements.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");
const SEAM = "apps/api/src/deps/push.ts";
const SDK = "expo-server-sdk";

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

test("only deps/push.ts imports expo-server-sdk", async () => {
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

test("only apps/api depends on expo-server-sdk, pinned exactly", async () => {
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
  expect(dependents).toEqual(["apps/api/package.json:dependencies:8.0.0"]);
});

test("the check catches every way of importing it", () => {
  for (const line of [
    `import { Expo } from "${SDK}";`,
    `import Expo from '${SDK}';`,
    `import type { ExpoPushMessage } from "${SDK}";`,
    `export { Expo } from "${SDK}";`,
    `import "${SDK}";`,
    `const sdk = await import("${SDK}");`,
    `const sdk = require('${SDK}');`,
    `import values from "${SDK}/build/ExpoClientValues.js";`,
  ]) {
    expect(IMPORTS_SDK.test(line)).toBe(true);
  }
  expect(IMPORTS_SDK.test(`import { Expo } from "${SDK}-other";`)).toBe(false);
  expect(IMPORTS_SDK.test(`// pushes go through ${SDK} in deps/push.ts`)).toBe(false);
});
