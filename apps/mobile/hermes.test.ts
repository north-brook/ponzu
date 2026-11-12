import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/*
 * What Hermes, the engine the iPhone app runs on, does not have. The unit tests run on Bun,
 * which has all of it, so a method Hermes lacks passes every test here and then throws
 * "undefined is not a function" on the phone: `Array.prototype.toSorted` did exactly that to the
 * canvases list on 12 November 2026, and only a simulator run showed it. This reads every source
 * file the React Native bundle can load (the app's own, and the client and core packages it
 * imports) and refuses the array-by-copy methods, which arrived in engines together.
 * `.slice().sort()`, `.slice().reverse()` and a spread say the same and run everywhere.
 *
 * The rest were seen missing on the simulator the same day, by asking the engine itself in a
 * Debug build of Ponzu Dev (React Native 0.88): `Array.fromAsync`; `Intl.RelativeTimeFormat`,
 * `Intl.PluralRules`, `Intl.ListFormat` and `Intl.Segmenter` (Hermes has only `Collator`,
 * `DateTimeFormat` and `NumberFormat`, so `toLocale*String` is fine); and a global
 * `crypto.randomUUID` (expo-crypto's `Crypto.randomUUID` is the one to use). It does have
 * `Object.groupBy`, `Promise.withResolvers`, the new `Set` methods, `findLast`, `at`,
 * `Object.hasOwn`, `structuredClone` (Expo's), `TextEncoder`/`TextDecoder`, and RegExp
 * lookbehind, named groups and `\p{…}`, but not RegExp's `v` flag. It has no `crypto.subtle`
 * either: the client takes the app's (lib/cloud/crypto.ts) wherever it digests.
 */

const REPO = resolve(import.meta.dir, "../..");
const ROOTS = [
  "apps/mobile/app",
  "apps/mobile/lib",
  "apps/mobile/components",
  "packages/client/src",
  "packages/core/src",
];
const MISSING: [name: string, pattern: RegExp][] = [
  ["Array.prototype.toSorted", /\.toSorted\(/],
  ["Array.prototype.toReversed", /\.toReversed\(/],
  ["Array.prototype.toSpliced", /\.toSpliced\(/],
  ["Array.fromAsync", /\bArray\.fromAsync\b/],
  ["Intl.RelativeTimeFormat", /\bIntl\.RelativeTimeFormat\b/],
  ["Intl.PluralRules", /\bIntl\.PluralRules\b/],
  ["Intl.ListFormat", /\bIntl\.ListFormat\b/],
  ["Intl.Segmenter", /\bIntl\.Segmenter\b/],
  ["crypto.randomUUID", /\bcrypto\.randomUUID\b/],
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    if (!/\.tsx?$/.test(name) || /\.(test|rntest)\.tsx?$/.test(name)) return [];
    return [path];
  });
}

test("nothing the iPhone app can load uses a method Hermes does not have", () => {
  const found: string[] = [];
  for (const root of ROOTS) {
    for (const file of sources(join(REPO, root))) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        for (const [name, pattern] of MISSING) {
          if (pattern.test(line)) found.push(`${relative(REPO, file)}:${index + 1} uses ${name}`);
        }
      });
    }
  }
  expect(found).toEqual([]);
});
