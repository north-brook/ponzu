import { expect, test } from "bun:test";
import { bundleMismatch, claimsScheme, configFor } from "./config.ts";

const release = configFor(true, {}, false, "release");
const dev = configFor(true, {}, false, "dev");
const local = configFor(false, {});

test("a packaged app starts only when its bundle and its main process are the same app", () => {
  expect(bundleMismatch(true, "Ponzu", release)).toBeNull();
  expect(bundleMismatch(true, "Ponzu Dev", dev)).toBeNull();
  // A Ponzu Dev bundle holding a release's main process would take 1.x's folder and clean it up.
  expect(bundleMismatch(true, "Ponzu Dev", release)).toContain("Ponzu Dev");
  expect(bundleMismatch(true, "Ponzu", dev)).not.toBeNull();
  // Ponzu Local runs inside node_modules' Electron.app, named "Electron".
  expect(bundleMismatch(false, "Electron", local)).toBeNull();
});

test("the smoke check claims no link scheme, and Ponzu Local has none to claim", () => {
  for (const app of [release, dev, local]) expect(claimsScheme(app, true)).toBe(false);
  expect(claimsScheme(release, false)).toBe(true);
  expect(claimsScheme(dev, false)).toBe(true);
  expect(local.linkScheme).toBeNull();
  expect(claimsScheme(local, false)).toBe(false);
});
