import { app, dialog } from "electron";
import electronUpdater from "electron-updater";

const { autoUpdater } = electronUpdater;
const FOUR_HOURS = 4 * 60 * 60 * 1000;

/**
 * Checks this repo's GitHub Releases for a newer signed build on launch and
 * every four hours. It downloads in the background and installs the next
 * time Ponzu quits; a dialog offers to restart now, unless no window is open
 * (`quiet`), in which case main quits on its own once agents go idle. Only a
 * packaged build checks: development has no feed to compare against.
 */
export function installUpdater(opts: { quiet: () => boolean; onReady: () => void }) {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  let offered: string | null = null;
  autoUpdater.on("update-downloaded", async (info) => {
    opts.onReady();
    if (offered === info.version || opts.quiet()) return;
    offered = info.version;
    const { response } = await dialog.showMessageBox({
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
export async function checkForUpdatesNow() {
  if (!app.isPackaged) {
    await dialog.showMessageBox({ message: "Updates are checked in the packaged app." });
    return;
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    if (result?.isUpdateAvailable) return;
    await dialog.showMessageBox({
      type: "info",
      message: "You're up to date",
      detail: `Ponzu ${app.getVersion()} is the latest version.`,
    });
  } catch {
    await dialog.showMessageBox({
      type: "error",
      message: "Couldn't check for updates",
      detail: "Check your connection and try again.",
    });
  }
}
