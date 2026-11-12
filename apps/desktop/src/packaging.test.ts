import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import manifest from "../package.json";
import { type BuildConfig, DEV, devBuild } from "./packaging.ts";

const release = manifest.build as unknown as BuildConfig;
const dev = devBuild(structuredClone(release));
const desktop = join(import.meta.dir, "..");

test("the packaged app can't be run as Node or opened to an inspector, and loads only its own asar", () => {
  // Each of these would hand another program on the computer the signed-in session.
  expect(manifest.build.electronFuses).toMatchObject({
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
  });
});

test("Ponzu Dev is an app of its own: its own name, bundle id and links, never ponzu://", () => {
  expect(dev).toMatchObject({
    appId: "design.ponzu.app.dev",
    productName: "Ponzu Dev",
    extraMetadata: { name: "ponzu-dev", productName: "Ponzu Dev" },
    protocols: [{ name: "Ponzu Dev", schemes: ["ponzu-dev"] }],
    directories: { output: "out/dev" },
  });
  expect(dev.appId).not.toBe(release.appId);
  expect(JSON.stringify(dev.protocols)).not.toContain('"ponzu"');
  // A file of its own, not merged over the release's (which would join the schemes' lists).
  expect(dev.extends).toBeNull();
  // The release is left as it was.
  expect(release.appId).toBe("design.ponzu.app");
  expect(release.protocols).toEqual([{ name: "Ponzu", schemes: ["ponzu"] }]);
});

test("Ponzu Dev is otherwise the release: the same fuses, entitlements, files and signing", () => {
  for (const key of [
    "electronFuses",
    "files",
    "extraResources",
    "afterSign",
    "npmRebuild",
  ] as const) {
    expect(dev[key]).toEqual(release[key]);
  }
  const { icon: _icon, target: _target, ...mac } = dev.mac!;
  const { icon: _releaseIcon, target: _releaseTarget, ...releaseMac } = release.mac!;
  expect(mac).toEqual(releaseMac);
  expect(dev.mac).toMatchObject({ hardenedRuntime: true, target: [{ target: "dir" }] });
});

test("Ponzu Dev publishes nowhere and makes no installer", () => {
  expect(dev.publish).toBeNull();
  // No feed, and no disk image that would offer to put it over Ponzu in Applications.
  for (const key of ["dmg", "win", "nsis"]) expect(dev).not.toHaveProperty(key);
  expect(dev.linux).toMatchObject({ executableName: "ponzu-dev" });
});

test("Ponzu Dev's icon is its own, and there", () => {
  expect(DEV.macIcon).not.toBe(release.mac!.icon);
  expect(existsSync(join(desktop, DEV.macIcon))).toBe(true);
  expect(existsSync(join(desktop, DEV.linuxIcons, "512x512.png"))).toBe(true);
});
