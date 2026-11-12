/*
 * The packaged apps electron-builder makes. The release's configuration is the `build` field of
 * package.json; Ponzu Dev's is derived from it here, so the two can only differ where this says.
 * scripts/package-dev.ts hands the result to electron-builder as a file of its own:
 * given as an object, electron-builder would merge it into the release's, joining their lists,
 * and Ponzu Dev would claim `ponzu://` too.
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

export const DEV = {
  productName: "Ponzu Dev",
  appId: "design.ponzu.app.dev",
  scheme: "ponzu-dev",
  /** Its executable on Linux, and its name in package metadata. */
  name: "ponzu-dev",
  /** Beside the release's out/<platform>-unpacked, never over it. */
  output: "out/dev",
  /** The release's icon on a grey tile (scripts/make-dev-icon.swift). */
  macIcon: "build/dev/icon.icns",
  linuxIcons: "build/dev/icons",
} as const;

/**
 * Ponzu Dev: the release under its own name, bundle id, link scheme and icon (and so its own
 * data folder, keychain item and single-instance lock, which Electron names after the product).
 * Everything else is the release's: the files, the fuses, the entitlements, the signing. It
 * publishes nowhere and has no update feed, and it builds only a folder (an .app on a Mac):
 * a disk image would offer to put it over Ponzu in Applications.
 */
export function devBuild(release: BuildConfig): BuildConfig {
  const { publish: _feed, win: _windows, nsis: _installer, dmg: _image, ...rest } = release;
  return {
    ...rest,
    // An explicit config file: no preset from the dependencies is mixed in.
    extends: null,
    appId: DEV.appId,
    productName: DEV.productName,
    extraMetadata: {
      ...release.extraMetadata,
      name: DEV.name,
      productName: DEV.productName,
    },
    directories: { ...release.directories, output: DEV.output },
    protocols: [{ name: DEV.productName, schemes: [DEV.scheme] }],
    publish: null,
    mac: {
      ...release.mac,
      icon: DEV.macIcon,
      target: [{ target: "dir" }],
    },
    linux: {
      ...release.linux,
      executableName: DEV.name,
      icon: DEV.linuxIcons,
      target: [{ target: "dir" }],
    },
  };
}
