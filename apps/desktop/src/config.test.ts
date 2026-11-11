import { expect, test } from "bun:test";
import { bundleMismatch, configFor, schemeRegistration } from "./config.ts";

const release = configFor(true, {}, false, "release");
const preview = configFor(true, {}, false, "preview");

test("a packaged app starts only when its bundle and its main process are the same app", () => {
  expect(bundleMismatch(true, "Ponzu", release)).toBeNull();
  expect(bundleMismatch(true, "Ponzu Preview", preview)).toBeNull();
  // A preview bundle holding a release's main process would take 1.x's folder and clean it up.
  expect(bundleMismatch(true, "Ponzu Preview", release)).toContain("Ponzu Preview");
  expect(bundleMismatch(true, "Ponzu", preview)).not.toBeNull();
  // A development build runs inside node_modules' Electron.app, named "Electron".
  expect(bundleMismatch(false, "Electron", configFor(false, {}))).toBeNull();
});

test("the smoke check claims no link scheme, on any platform", () => {
  for (const platform of ["darwin", "linux", "win32"] as const) {
    for (const packaged of [true, false]) {
      expect(schemeRegistration(packaged, platform, true)).toBeNull();
    }
    expect(schemeRegistration(true, platform, false)).toBe("bundle");
  }
  // A development build on a Mac runs inside a bare Electron.app that declares no schemes.
  expect(schemeRegistration(false, "darwin", false)).toBeNull();
  expect(schemeRegistration(false, "linux", false)).toBe("checkout");
});
