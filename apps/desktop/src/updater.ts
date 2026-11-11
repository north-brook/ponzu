import { spawn } from "node:child_process";
import { changelogNotes, compareVersions, notesBetween, releaseNotesUrl } from "@ponzu/core";
import {
  app,
  type BrowserWindow,
  dialog,
  type MessageBoxOptions,
  autoUpdater as nativeUpdater,
} from "electron";
import electronUpdater, { type AppUpdater, type UpdateInfo } from "electron-updater";
import type { UpdateState } from "./bridge.ts";
import { type Installer, installerOf } from "./installer.ts";

const { AppImageUpdater, DebUpdater } = electronUpdater;
const FOUR_HOURS = 4 * 60 * 60 * 1000;

/** This build's updater, once `installUpdater` has made one: none for a build that can't update. */
let updater: AppUpdater | null = null;

/**
 * What's new between this Ponzu and an update, for the update mark's popover: the release notes
 * its pull requests wrote, from the release-notes.json each release publishes beside its build
 * (docs/release-notes.md), or, for a release without one, its changelog.
 */
async function notesOf(info: UpdateInfo): Promise<string[]> {
  try {
    const res = await fetch(releaseNotesUrl(info.version), { signal: AbortSignal.timeout(10_000) });
    if (res.ok) {
      const notes = notesBetween(await res.json(), app.getVersion(), info.version);
      if (notes) return notes;
    }
  } catch {}
  const changelog = info.releaseNotes;
  return typeof changelog === "string"
    ? changelogNotes(changelog)
    : (changelog ?? []).flatMap((n) => (n.note ? changelogNotes(n.note) : []));
}

export interface Updates {
  state(): UpdateState;
  /** Look now, as well as at launch and every four hours. */
  check(): void;
  /** Restart into the update, fetching it first when it isn't downloaded yet. */
  install(): void;
}

/**
 * Checks this repo's GitHub Releases for a newer build on launch and every four hours, and
 * downloads it in the background. Nothing interrupts the person: the studio's title bar shows
 * that one is ready (`onState`), and its Restart installs it. It also installs the next time
 * Ponzu quits. Restarting interrupts nothing that matters: the agent runs in the cloud.
 *
 * The .deb installs through dpkg, which asks for an admin's password, so it installs only when
 * the person clicks Restart, never on quit.
 */
export function installUpdater(onState: (state: UpdateState) => void, enabled = true): Updates {
  const installer = enabled && app.isPackaged ? installerOf(process.resourcesPath) : null;
  let ready: UpdateState["ready"] = null;
  let installing = false;
  const state = (): UpdateState => ({
    version: app.getVersion(),
    canUpdate: installer !== null,
    ready,
    installing,
  });
  if (!installer) return { state, check: () => {}, install: () => {} };

  const autoUpdater = updaterFor(installer);
  updater = autoUpdater;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = installer !== "deb";
  const changed = () => onState(state());
  const check = () => void autoUpdater.checkForUpdates().catch(() => undefined);

  autoUpdater.on("update-downloaded", async (info) => {
    // An older download than one already here (a check that crossed a release) changes nothing.
    if (ready && compareVersions(info.version, ready.version) < 0) return;
    ready = { version: info.version, notes: await notesOf(info) };
    changed();
    if (installing) quitAndInstall(autoUpdater, installer);
  });
  autoUpdater.on("update-not-available", () => {
    if (!installing) return;
    installing = false;
    changed();
  });
  // A failed check (offline, rate limited) is not worth a word; the next one retries. A failed
  // install (the .deb's password prompt dismissed) leaves Ponzu running, to try again.
  autoUpdater.on("error", () => {
    if (!installing) return;
    installing = false;
    changed();
  });
  // An AppImage the person renamed with a version in it is installed beside, under the new name.
  autoUpdater.on("appimage-filename-updated", (path) => {
    appImage = path;
  });
  check();
  setInterval(check, FOUR_HOURS);

  return {
    state,
    check,
    install() {
      installing = true;
      changed();
      if (ready) quitAndInstall(autoUpdater, installer);
      else check();
    },
  };
}

/**
 * electron-updater's own pick reads the package type from the resources, which an AppImage can
 * share with the .deb (installer.ts), so each is made by the installer this build has.
 */
function updaterFor(installer: Installer): AppUpdater {
  if (installer === "appimage") return new AppImageUpdater();
  if (installer === "deb") return new DebUpdater();
  return electronUpdater.autoUpdater;
}

/**
 * Quit, install and reopen. Always through quitAndInstall: `update-downloaded` fires before
 * Squirrel has unpacked the update, and it waits for that where a plain quit would leave a
 * half-unpacked bundle. The Windows installer runs silently and starts the new Ponzu; dpkg asks
 * for the password, then Electron relaunches. The AppImage's file is replaced while this one
 * still runs from it, and the new one is started once this one has gone: any sooner, it would
 * find this one holding the single-instance lock and quit.
 */
function quitAndInstall(updater: AppUpdater, installer: Installer) {
  if (installer === "squirrel") return updater.quitAndInstall();
  if (installer !== "appimage") return updater.quitAndInstall(true, true);
  // Only once it's installed: electron-updater says so just before it quits.
  nativeUpdater.removeListener("before-quit-for-update", reopenAppImage);
  nativeUpdater.once("before-quit-for-update", reopenAppImage);
  updater.quitAndInstall(true, false);
}

/** The AppImage, as the update left it: its name has no version, so it keeps its path. */
let appImage = process.env.APPIMAGE;

/** Start the AppImage again once this process has exited, from a shell outside its mount. */
function reopenAppImage() {
  if (!appImage) return;
  const env = { ...process.env };
  for (const name of ["APPIMAGE", "APPDIR", "ARGV0", "OWD"]) delete env[name];
  const wait = 'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; exec "$0"';
  spawn("/bin/sh", ["-c", wait, appImage, String(process.pid)], {
    detached: true,
    stdio: "ignore",
    env,
  }).unref();
}

/** A message as a sheet on `win`, once it's on screen: never a free-standing alert. */
async function ask(win: BrowserWindow, options: MessageBoxOptions) {
  if (!win.isVisible()) await new Promise<void>((resolve) => win.once("show", () => resolve()));
  return dialog.showMessageBox(win, options);
}

/**
 * The menu's Check for Updates: unlike the scheduled check, it says when there is nothing new.
 * An update it finds shows in the title bar once it's downloaded.
 */
export async function checkForUpdatesNow(win: BrowserWindow) {
  if (!app.isPackaged) {
    await ask(win, { message: "Updates are checked in the packaged app." });
    return;
  }
  if (!updater) {
    await ask(win, {
      type: "info",
      message: "This copy of Ponzu doesn't update itself",
      detail: "Download the newest Ponzu from ponzu.design to install it.",
    });
    return;
  }
  try {
    const result = await updater.checkForUpdates();
    if (result?.isUpdateAvailable) {
      await ask(win, {
        type: "info",
        message: `Ponzu ${result.updateInfo.version} is on its way`,
        detail: "It's downloading. Click the yellow dot beside Ponzu's name once it's ready.",
      });
      return;
    }
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
