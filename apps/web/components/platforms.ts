/**
 * The desktops Ponzu ships for. Every release carries all three, and each installer keeps one name
 * across versions (apps/desktop/package.json), so `/releases/latest/download/<file>` is always the
 * newest build. Pages pick the visitor's with `data-os` on `<html>` (components/device.ts).
 */
export type Os = "mac" | "windows" | "linux";

export const OSES: Os[] = ["mac", "windows", "linux"];

const LATEST = "https://github.com/north-brook/ponzu/releases/latest/download";

export interface Platform {
  os: Os;
  name: string;
  /** What the main Download button says. */
  label: string;
  /** The machine it runs on, under the button and in the menu. */
  needs: string;
  /** The installer the install steps download. */
  file: string;
  /** Linux's other package. */
  alt?: string;
  /** What a phone's handoff sends the link to: "Send to my Mac". */
  machine: string;
  beta: boolean;
}

export const PLATFORMS: Record<Os, Platform> = {
  mac: {
    os: "mac",
    name: "Mac",
    label: "Download for Mac",
    needs: "Apple silicon · macOS 12+",
    file: "Ponzu-arm64.dmg",
    machine: "Mac",
    beta: false,
  },
  windows: {
    os: "windows",
    name: "Windows",
    label: "Download for Windows",
    needs: "x64 · Windows 10+",
    file: "Ponzu-x64.exe",
    machine: "PC",
    beta: true,
  },
  linux: {
    os: "linux",
    name: "Linux",
    label: "Download for Linux",
    needs: "x64 · AppImage or .deb",
    file: "Ponzu-x64.AppImage",
    alt: "Ponzu-x64.deb",
    machine: "machine",
    beta: true,
  },
};

/** The newest build of a release file. */
export const asset = (file: string) => `${LATEST}/${file}`;

/** A desktop's install steps, which start its download as they open. */
export const guide = (os: Os) => `/download/${os}?start=1`;
