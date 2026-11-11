import type { BrowserWindowConstructorOptions } from "electron";

/*
 * The window's ground: the shell around the canvas (the chrome, the sidebar, the thread pane).
 * On a Mac it is the system's own material, with the studio's tint laid over it
 * (`--c-chrome-glass` in apps/studio/src/cloud/styles/tokens.css), so a little of what is behind
 * the window bleeds through, as it does through a native sidebar. Elsewhere it is the solid
 * shell colour the tint stands for.
 */

/** The studio's `--c-chrome`: the solid shell, and the window's ground where it has no material. */
export const SHELL = { light: "#f4f3f0", dark: "#1a1a19" } as const;

/**
 * The material. `sidebar` is what a native sidebar is made of, and most of the shell is the
 * sidebar and the thread pane. `followWindow` does as native windows do: the material goes
 * still and flat while the window is in the background, under a tint that keeps the change
 * small.
 */
export const MATERIAL = {
  vibrancy: "sidebar",
  visualEffectState: "followWindow",
} as const satisfies BrowserWindowConstructorOptions;

export interface ShellGround {
  /** Whether the window has a material behind the page: the studio lays its tint over it. */
  glass: boolean;
  options: BrowserWindowConstructorOptions;
}

/**
 * The window options for the shell's ground. With the material there is no `backgroundColor`:
 * Electron then leaves the page's own ground clear over the material, and the studio's first
 * paint (the tint, on <html>) is what the window shows, since it stays hidden until that paint.
 * Without it, the solid shell, so the window never shows another colour before the studio paints.
 */
export function shellGround(platform: NodeJS.Platform, dark: boolean): ShellGround {
  if (platform === "darwin") return { glass: true, options: { ...MATERIAL } };
  return { glass: false, options: { backgroundColor: SHELL[dark ? "dark" : "light"] } };
}
