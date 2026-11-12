import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEnv,
  describe,
  envFiles,
  PREBUILT_ENV,
  prebuilt,
  STAMP,
  type Stamp,
} from "./prebuilt.ts";

let root: string;
let src: string;
const before = process.env[PREBUILT_ENV];

/** A prebuilt e2e app made from one source file under a scanned `src`. */
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ponzu-prebuilt-test-"));
  src = join(root, "src");
  mkdirSync(src);
  mkdirSync(join(root, "e2e"));
  writeFileSync(join(src, "app.tsx"), "export {};");
  writeFileSync(join(root, "e2e", "index.html"), "<!doctype html>");
  const stamp: Stamp = {
    kind: "e2e",
    env: buildEnv(),
    scanned: [src],
    sources: { [join(src, "app.tsx")]: describe(join(src, "app.tsx"))! },
    envFiles: Object.fromEntries(envFiles(root, "e2e").map((file) => [file, describe(file)])),
  };
  writeFileSync(join(root, "e2e", STAMP), JSON.stringify(stamp));
  process.env[PREBUILT_ENV] = root;
});
afterEach(() => {
  if (before === undefined) delete process.env[PREBUILT_ENV];
  else process.env[PREBUILT_ENV] = before;
  rmSync(root, { recursive: true, force: true });
});

test("unset, every helper builds for itself", () => {
  delete process.env[PREBUILT_ENV];
  expect(prebuilt("e2e")).toBeNull();
});

test("a fresh build is handed out as a copy the caller may delete", () => {
  const copy = prebuilt("e2e")!;
  expect(copy).not.toBe(join(root, "e2e"));
  expect(existsSync(join(copy, "index.html"))).toBe(true);
  rmSync(copy, { recursive: true, force: true });
  expect(existsSync(join(root, "e2e", "index.html"))).toBe(true);
});

test("a missing build fails, naming how to make it", () => {
  expect(() => prebuilt("gallery")).toThrow(/prebuilt gallery .* isn't there\. Rebuild it/);
});

test("a source changed after the build fails", () => {
  const file = join(src, "app.tsx");
  writeFileSync(file, "export const changed = 1;");
  expect(() => prebuilt("e2e")).toThrow(/is older than .*app\.tsx/);
  // The same size and a later time is a change too.
  writeFileSync(file, "export {};");
  utimesSync(file, new Date(), new Date(Date.now() + 5_000));
  expect(() => prebuilt("e2e")).toThrow(/is older than/);
});

test("a source gone, or a new one where the build scanned, fails", () => {
  writeFileSync(join(src, "new.tsx"), "export {};");
  expect(() => prebuilt("e2e")).toThrow(/built before .*new\.tsx was made/);
  rmSync(join(src, "app.tsx"));
  expect(() => prebuilt("e2e")).toThrow(/app\.tsx, which is gone/);
});

test("a .env file made, changed or removed after the build fails", () => {
  const file = join(root, ".env.e2e");
  writeFileSync(file, "VITE_PREBUILT_TEST=1");
  expect(() => prebuilt("e2e")).toThrow(/built before .*\.env\.e2e was made, changed or removed/);
  rmSync(file);
  const copy = prebuilt("e2e")!;
  expect(existsSync(join(copy, "index.html"))).toBe(true);
  rmSync(copy, { recursive: true, force: true });
});

test("a build made with other VITE_ variables fails", () => {
  process.env.VITE_PREBUILT_TEST = "1";
  try {
    expect(() => prebuilt("e2e")).toThrow(/other VITE_ variables/);
  } finally {
    delete process.env.VITE_PREBUILT_TEST;
  }
});
