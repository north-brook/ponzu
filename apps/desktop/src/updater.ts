import { app, type BrowserWindow, dialog, type MessageBoxOptions } from "electron";
import electronUpdater from "electron-updater";

const { autoUpdater } = electronUpdater;
const FOUR_HOURS = 4 * 60 * 60 * 1000;

/**
 * A message as a sheet on `win`, once it's on screen. Never a free-standing
 * alert: on macOS that, like a sheet on a hidden window, runs a modal loop
 * that holds up the main process until it's answered, and the render host
 * with it, so no screenshot or preview draws meanwhile.
 */
async function ask(win: BrowserWindow, options: MessageBoxOptions) {
  if (!win.isVisible()) await new Promise<void>((resolve) => win.once("show", () => resolve()));
  return dialog.showMessageBox(win, options);
}

/**
 * Checks this repo's GitHub Releases for a newer signed build on launch and
 * every four hours. It downloads in the background and installs the next
 * time Ponzu quits; a sheet on the window offers to restart now. With no
 * window open, main quits on its own once agents go idle. Only a packaged
 * build checks: development has no feed to compare against.
 */
export function installUpdater(opts: { window: () => BrowserWindow | null; onReady: () => void }) {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  let offered: string | null = null;
  autoUpdater.on("update-downloaded", async (info) => {
    opts.onReady();
    const win = opts.window();
    if (offered === info.version || !win || win.isDestroyed()) return;
    offered = info.version;
    const { response } = await ask(win, {
      type: "info",
      message: `Ponzu ${info.version} is ready`,
      detail: "Restart to update now, or it installs the next time you quit.",
      buttons: ["Restart", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });
  // A failed check (offline, rate limited) is not worth a word; the next one retries.
  autoUpdater.on("error", () => {});
  const check = () => autoUpdater.checkForUpdates().catch(() => undefined);
  check();
  setInterval(check, FOUR_HOURS);
}

/** The menu's Check for Updates: unlike the scheduled check, it reports nothing new. */
export async function checkForUpdatesNow(win: BrowserWindow) {
  if (!app.isPackaged) {
    await ask(win, { message: "Updates are checked in the packaged app." });
    return;
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    if (result?.isUpdateAvailable) return;
    await ask(win, {
      type: "info",
      message: "You're up to date",
      detail: `Ponzu ${app.getVersion()} is the latest version.`,
    });
  } catch {
    await ask(win, {
      type: "error",
      message: "Couldn't check for updates",
      detail: "Check your connection and try again.",
    });
  }
}
