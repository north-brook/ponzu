/*
 * The packaged apps electron-builder makes. The release's configuration is the `build` field of
 * package.json; Ponzu Preview's is derived from it here, so the two can only differ where this
 * says. scripts/package-preview.ts hands the result to electron-builder as a file of its own:
 * given as an object, electron-builder would merge it into the release's, joining their lists,
 * and the preview would claim `ponzu://` too.
 */

/** As much of electron-builder's configuration as this reads or changes. */
export interface BuildConfig {
  appId: string;
  productName?: string;
  extraMetadata?: Record<string, unknown>;
  directories?: { output?: string; buildResources?: string };
  protocols?: { name: string; schemes: string[] }[];
  publish?: unknown;
  mac?: Record<string, unknown>;
  linux?: Record<string, unknown>;
  [key: string]: unknown;
}

export const PREVIEW = {
  productName: "Ponzu Preview",
  appId: "design.ponzu.app.preview",
  scheme: "ponzu-preview",
  /** Beside the release's out/<platform>-unpacked, never over it. */
  output: "out/preview",
  /** The release's icon with a Preview mark (scripts/make-preview-icon.swift). */
  macIcon: "build/preview/icon.icns",
  linuxIcons: "build/preview/icons",
} as const;

/**
 * Ponzu Preview: the release under its own name, bundle id, link scheme and icon (and so its own
 * data folder, keychain item and single-instance lock, which Electron names after the product).
 * Everything else is the release's: the files, the fuses, the entitlements, the signing. It
 * publishes nowhere and has no update feed, and it builds only a folder (an .app on a Mac):
 * a disk image would offer to put it over Ponzu in Applications.
 */
export function previewBuild(release: BuildConfig): BuildConfig {
  const { publish: _feed, win: _windows, nsis: _installer, dmg: _image, ...rest } = release;
  return {
    ...rest,
    // An explicit config file: no preset from the dependencies is mixed in.
    extends: null,
    appId: PREVIEW.appId,
    productName: PREVIEW.productName,
    extraMetadata: {
      ...release.extraMetadata,
      name: "ponzu-preview",
      productName: PREVIEW.productName,
    },
    directories: { ...release.directories, output: PREVIEW.output },
    protocols: [{ name: PREVIEW.productName, schemes: [PREVIEW.scheme] }],
    publish: null,
    mac: {
      ...release.mac,
      icon: PREVIEW.macIcon,
      target: [{ target: "dir" }],
    },
    linux: {
      ...release.linux,
      executableName: "ponzu-preview",
      icon: PREVIEW.linuxIcons,
      target: [{ target: "dir" }],
    },
  };
}
