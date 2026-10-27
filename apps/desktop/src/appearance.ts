import { execFile } from "node:child_process";
import { app, nativeTheme, powerMonitor, systemPreferences } from "electron";

/** How often Ponzu checks the Mac's appearance against Chromium's. */
const CHECK_EVERY = 60_000;
/** How long a disagreement must last before Ponzu takes the Mac's word over Chromium's. */
const SETTLE = 3000;

/**
 * Whether the Mac is in dark mode, as a fresh process reads it. Ponzu itself can't be asked: a
 * process that missed a switch keeps answering with the old mode, and only a relaunch put it
 * right. A new `defaults` reads what that relaunch would. Its key is missing in light mode.
 * Null when it can't be read, which says nothing about the mode.
 */
function macIsDark(): Promise<boolean | null> {
  return new Promise((resolve) => {
    execFile("defaults", ["read", "-g", "AppleInterfaceStyle"], (err, stdout, stderr) => {
      if (!err) resolve(stdout.trim() === "Dark");
      // The missing key: "Could not find key" now, "does not exist" on older macOS.
      else resolve(/could not find key|does not exist/i.test(stderr) ? false : null);
    });
  });
}

/**
 * Keeps Ponzu in the Mac's light or dark mode. Chromium follows the Mac on its own, but when
 * Auto switches the appearance while the person is away, Ponzu sometimes never hears of it and
 * stays in the old mode until it's reopened. So Ponzu also checks for itself: when they come
 * back, when they switch to Ponzu, and every minute. When Chromium has it wrong, Ponzu sets the
 * mode itself and keeps doing so for the rest of the run, since the switches Chromium missed
 * won't reach it later either.
 */
export function followAppearance() {
  if (process.platform !== "darwin") return;
  let checking = false;
  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      const first = await macIsDark();
      if (first === null || first === nativeTheme.shouldUseDarkColors) return;
      // Mid-switch, the two can disagree for a moment: only one that lasts is Chromium's miss.
      await new Promise((r) => setTimeout(r, SETTLE));
      const dark = await macIsDark();
      if (dark !== null && dark !== nativeTheme.shouldUseDarkColors)
        nativeTheme.themeSource = dark ? "dark" : "light";
    } finally {
      checking = false;
    }
  };
  setInterval(check, CHECK_EVERY);
  app.on("did-become-active", check);
  powerMonitor.on("resume", check);
  powerMonitor.on("unlock-screen", check);
  // While Ponzu sets the mode itself, Chromium's own updates stop; this brings a switch sooner.
  systemPreferences.subscribeNotification(
    "AppleInterfaceThemeChangedNotification",
    () => void check(),
  );
}
