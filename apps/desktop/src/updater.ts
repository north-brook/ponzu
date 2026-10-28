import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  changelogNotes,
  compareVersions,
  type MachineUpdate,
  notesBetween,
  releaseNotesUrl,
} from "@ponzu/core";
import {
  app,
  type BrowserWindow,
  dialog,
  type MessageBoxOptions,
  autoUpdater as nativeUpdater,
  powerMonitor,
} from "electron";
import electronUpdater, { type AppUpdater, type UpdateInfo } from "electron-updater";
import { type Installer, installerOf } from "./installer";

const { AppImageUpdater, DebUpdater } = electronUpdater;
/** This build's updater, once installUpdater has made one: none for a build that can't update. */
let updater: AppUpdater | null = null;
const FOUR_HOURS = 4 * 60 * 60 * 1000;
/** How long nobody has touched this Mac before Ponzu restarts into an update on its own. */
const AWAY_SECONDS = 5 * 60;
/** Time for the answer to reach the server, and the other Macs, before this one restarts. */
const RESTART_DELAY = 500;
/** How often a restart held for a working agent asks again whether it's done. */
const AGENT_CHECK_EVERY = 2000;
/**
 * How long the server may fail to say whether an agent is working before the restart goes ahead
 * anyway: a server that can't answer for this long has no agent working through it.
 */
const AGENT_CHECK_GIVE_UP = 60_000;

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
 * What's new between this Ponzu and an update, for the title bar's popover: the release notes its
 * pull requests wrote, from the release-notes.json each release publishes beside its build
 * (docs/release-notes.md), or, for a release without one, its changelog. A release whose file
 * lists no notes shows none: no section means no note.
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

/**
 * Checks this repo's GitHub Releases for a newer build on launch and
 * every four hours, and downloads it in the background. Nothing interrupts
 * the person: the server it starts lists what's ready on this computer's machine
 * in the catalog, the studio's title bar offers Update, and that installs it
 * here and on the person's other computers (@ponzu/core's update.ts). It also
 * installs the next time Ponzu quits; with no window open, main quits on its
 * own once agents go idle.
 *
 * The server reaches it on a local port with a token (`PONZU_APP_ENDPOINT`,
 * `PONZU_APP_TOKEN`): GET for what it has, POST /install to install. Only a
 * build that can install an update checks (installer.ts): development and an
 * unpacked folder have no feed or nothing to replace, and list no updater, so
 * no title bar offers them one.
 *
 * The .deb installs through dpkg, which asks for an admin's password. So it
 * never installs on quit or on Ponzu's own idea, only when the person clicks
 * Update on this computer, where they can answer.
 */
export async function installUpdater(opts: {
  window: () => BrowserWindow | null;
  onReady: () => void;
  /** Whether an agent is mid-change on this Mac, from its server: a restart waits for it. */
  agentWorking: () => Promise<boolean>;
}): Promise<{ endpoint: string; token: string } | null> {
  const installer = app.isPackaged ? installerOf(process.resourcesPath) : null;
  if (!installer) return null;
  const autoUpdater = updaterFor(installer);
  updater = autoUpdater;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = installer !== "deb";
  let ready: MachineUpdate["ready"];
  /** The person asked for it: restart as soon as it's downloaded. */
  let installing = false;
  /** The version they asked for: a download older than it isn't the one to restart into. */
  let target: string | undefined;
  const readyFor = (version?: string) =>
    Boolean(ready && (!version || compareVersions(ready.version, version) >= 0));
  const state = (): MachineUpdate => ({
    version: app.getVersion(),
    ...(ready ? { ready } : {}),
    ...(installing ? { installing } : {}),
  });

  /** A restart on its way: waiting for an agent, or for its answer to get out. */
  let restarting = false;
  /**
   * Restart into the update, as Ponzu was: a window open comes back with one, none comes back in
   * the background, still serving agents, the phone and the person's other computers. Always
   * through quitAndInstall: `update-downloaded` fires before Squirrel has unpacked the update, and
   * it waits for that where a plain quit would leave a half-unpacked bundle and nothing to reopen
   * it. Never while an agent is mid-change here, even one that started while the update
   * downloaded: it waits until the agent is done.
   */
  const restart = () => {
    if (restarting) return;
    restarting = true;
    /** When the server last answered: a check that fails isn't an agent that's done. */
    let answered = Date.now();
    const go = async () => {
      const working = await opts.agentWorking().catch(() => null);
      if (working !== null) answered = Date.now();
      if (working || (working === null && Date.now() - answered < AGENT_CHECK_GIVE_UP)) {
        setTimeout(go, AGENT_CHECK_EVERY);
        return;
      }
      setTimeout(() => {
        if (!opts.window()) markBackgroundRelaunch();
        quitAndInstall(autoUpdater, installer);
      }, RESTART_DELAY);
    };
    void go();
  };

  /** Fetch the newest release: one newer than what's downloaded replaces it. */
  const fetchNewest = () =>
    void autoUpdater.checkForUpdates().catch(() => {
      installing = false;
    });

  /**
   * Install `version`, or a newer one: restart into it once it's downloaded, fetching it first
   * when what's here is older. `quiet`: Ponzu's own idea, for a Mac that was off when the person
   * updated the others. Only once it's downloaded, and only with nobody at this Mac: no window,
   * or untouched a while. (The server holds an install the person asked for while an agent is
   * mid-change here, so a restart never cuts one off.)
   */
  const install = (o: { quiet?: boolean; version?: string }): MachineUpdate => {
    // dpkg's password prompt needs the person here: their click in this computer's window.
    if (installer === "deb" && (o.quiet || !opts.window()?.isFocused())) return state();
    if (o.quiet) {
      if (installing) return state();
      if (!readyFor(o.version)) {
        // What the other Macs moved on to isn't here yet: fetch it, and install on a later turn.
        if (ready) fetchNewest();
        return state();
      }
      const away = !opts.window() || powerMonitor.getSystemIdleTime() >= AWAY_SECONDS;
      if (!away) return state();
    }
    installing = true;
    target = o.version;
    if (readyFor(target)) restart();
    else fetchNewest();
    return state();
  };

  autoUpdater.on("update-downloaded", async (info) => {
    ready = { version: info.version, notes: await notesOf(info) };
    opts.onReady();
    if (installing && readyFor(target)) restart();
  });
  autoUpdater.on("update-not-available", () => {
    installing = false;
  });
  // A failed check (offline, rate limited) is not worth a word; the next one retries. A failed
  // install (the .deb's password prompt dismissed) leaves Ponzu running, to try again.
  autoUpdater.on("error", () => {
    installing = false;
    restarting = false;
  });
  // An AppImage the person renamed with a version in it is installed beside, under the new name.
  autoUpdater.on("appimage-filename-updated", (path) => {
    appImage = path;
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => undefined);
  check();
  setInterval(check, FOUR_HOURS);

  const token = randomBytes(24).toString("hex");
  return new Promise((resolve) => {
    const http = createServer(async (req, res) => {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(403).end();
        return;
      }
      let out: MachineUpdate;
      if (req.method === "POST" && req.url === "/update/install") {
        const body = await read(req)
          .then((text) => JSON.parse(text || "{}") as { quiet?: unknown; version?: unknown } | null)
          .catch(() => null);
        out = install({
          quiet: body?.quiet === true,
          ...(typeof body?.version === "string" ? { version: body.version } : {}),
        });
      } else if (req.method === "GET" && req.url === "/update") out = state();
      else {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
    });
    http.listen(0, "127.0.0.1", () => {
      const { port } = http.address() as AddressInfo;
      resolve({ endpoint: `http://127.0.0.1:${port}/update`, token });
    });
  });
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
 * Quit, install and reopen. Squirrel reopens Ponzu itself. The Windows installer runs silently
 * and starts the new Ponzu once it's done; dpkg asks for the password, then Electron relaunches.
 * The AppImage's file is replaced while this one still runs from it, and the new one is started
 * once this one has gone: any sooner, it would find this one holding the single-instance lock and
 * quit.
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

/**
 * Squirrel reopens Ponzu after an update with no arguments, so a Ponzu that had no window says so
 * in a file the next launch reads (`relaunchedInBackground`). Only a launch soon after counts: one
 * whose install failed, and the person opening Ponzu later, opens as usual.
 */
const relaunchMarker = () => join(app.getPath("userData"), "relaunch-in-background");
const RELAUNCH_WITHIN = 2 * 60_000;

function markBackgroundRelaunch() {
  try {
    writeFileSync(relaunchMarker(), "");
  } catch {}
}

/** Whether this launch is the restart into an update of a Ponzu with no window. Reads it once. */
export function relaunchedInBackground(): boolean {
  try {
    const fresh = Date.now() - statSync(relaunchMarker()).mtimeMs < RELAUNCH_WITHIN;
    rmSync(relaunchMarker(), { force: true });
    return fresh;
  } catch {
    return false;
  }
}

function read(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * The menu's Check for Updates: unlike the scheduled check, it reports nothing new. An update
 * it finds shows in the title bar once it's downloaded.
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
        detail: "It's downloading. Click the dot in the title bar once it's ready.",
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
