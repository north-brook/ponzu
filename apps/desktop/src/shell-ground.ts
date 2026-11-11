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
 * The material, by appearance, chosen from measurements (a probe on macOS 27.2, 11 Nov 2026:
 * every material over black, white, grey and coloured backdrops, in both appearances, with the
 * studio's tint over it).
 *
 * Dark is `hud`: its own base is dark (about 25) and over half of what is behind it comes
 * through, so under a dark tint the shell is an off-black that still lets the desktop bleed in.
 * `sidebar`, which this was, has a grey base near 39 and passes a fifth: tinted dark enough to
 * read as off-black it showed almost nothing, and tinted lightly it was a flat mid grey.
 * Light is `header`: neutral, and lighter than `hud` in light, so the shell stays an off-white
 * rather than a grey.
 */
export const MATERIAL = { light: "header", dark: "hud" } as const satisfies Record<
  "light" | "dark",
  BrowserWindowConstructorOptions["vibrancy"]
>;

/**
 * Always live. `followWindow` (what a native sidebar does) turns every material into one flat
 * colour whenever the window is not the key one, which read as a shell with no glass at all.
 */
export const MATERIAL_STATE =
  "active" satisfies BrowserWindowConstructorOptions["visualEffectState"];

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
  if (platform === "darwin") {
    return {
      glass: true,
      options: { vibrancy: MATERIAL[dark ? "dark" : "light"], visualEffectState: MATERIAL_STATE },
    };
  }
  return { glass: false, options: { backgroundColor: SHELL[dark ? "dark" : "light"] } };
}
