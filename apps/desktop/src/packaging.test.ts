import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import manifest from "../package.json";
import { type BuildConfig, PREVIEW, previewBuild } from "./packaging.ts";

const release = manifest.build as unknown as BuildConfig;
const preview = previewBuild(structuredClone(release));
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

test("Ponzu Preview is an app of its own: its own name, bundle id and links, never ponzu://", () => {
  expect(preview).toMatchObject({
    appId: "design.ponzu.app.preview",
    productName: "Ponzu Preview",
    extraMetadata: { name: "ponzu-preview", productName: "Ponzu Preview" },
    protocols: [{ name: "Ponzu Preview", schemes: ["ponzu-preview"] }],
    directories: { output: "out/preview" },
  });
  expect(preview.appId).not.toBe(release.appId);
  expect(JSON.stringify(preview.protocols)).not.toContain('"ponzu"');
  // A file of its own, not merged over the release's (which would join the schemes' lists).
  expect(preview.extends).toBeNull();
  // The release is left as it was.
  expect(release.appId).toBe("design.ponzu.app");
  expect(release.protocols).toEqual([{ name: "Ponzu", schemes: ["ponzu"] }]);
});

test("Ponzu Preview is otherwise the release: the same fuses, entitlements, files and signing", () => {
  for (const key of [
    "electronFuses",
    "files",
    "extraResources",
    "afterSign",
    "npmRebuild",
  ] as const) {
    expect(preview[key]).toEqual(release[key]);
  }
  const { icon: _icon, target: _target, ...mac } = preview.mac!;
  const { icon: _releaseIcon, target: _releaseTarget, ...releaseMac } = release.mac!;
  expect(mac).toEqual(releaseMac);
  expect(preview.mac).toMatchObject({ hardenedRuntime: true, target: [{ target: "dir" }] });
});

test("Ponzu Preview publishes nowhere and makes no installer", () => {
  expect(preview.publish).toBeNull();
  // No feed, and no disk image that would offer to put it over Ponzu in Applications.
  for (const key of ["dmg", "win", "nsis"]) expect(preview).not.toHaveProperty(key);
  expect(preview.linux).toMatchObject({ executableName: "ponzu-preview" });
});

test("Ponzu Preview's icon is its own, and there", () => {
  expect(PREVIEW.macIcon).not.toBe(release.mac!.icon);
  expect(existsSync(join(desktop, PREVIEW.macIcon))).toBe(true);
  expect(existsSync(join(desktop, PREVIEW.linuxIcons, "512x512.png"))).toBe(true);
});
