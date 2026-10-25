import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { changelogNotes, compareVersions, type MachineUpdate } from "@ponzu/core";
import { app, type BrowserWindow, dialog, type MessageBoxOptions, powerMonitor } from "electron";
import electronUpdater, { type UpdateInfo } from "electron-updater";
import { markWhatsNewSeen } from "./whats-new";

const { autoUpdater } = electronUpdater;
const FOUR_HOURS = 4 * 60 * 60 * 1000;
/** How long nobody has touched this Mac before Ponzu restarts into an update on its own. */
const AWAY_SECONDS = 5 * 60;
/** Time for the answer to reach the server, and the other Macs, before this one restarts. */
const RESTART_DELAY = 500;

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

const REPO = "https://github.com/north-brook/ponzu";

/**
 * What's new between this Ponzu and an update: the release notes its pull requests wrote, from
 * the release-notes.json each release publishes beside its build (docs/release-notes.md), or,
 * for a release without one, its changelog. A release whose file lists no notes shows none: no
 * section means no note. `complete` when they cover every release since this one: a changelog
 * may have only the newest's.
 */
async function notesOf(info: UpdateInfo): Promise<{ notes: string[]; complete: boolean }> {
  try {
    const res = await fetch(`${REPO}/releases/download/v${info.version}/release-notes.json`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const { releases } = (await res.json()) as {
        releases?: { version: string; notes: string[] }[];
      };
      const current = app.getVersion();
      const notes = (releases ?? [])
        .filter(
          (r) =>
            compareVersions(r.version, current) > 0 &&
            compareVersions(r.version, info.version) <= 0,
        )
        .flatMap((r) => r.notes);
      if (Array.isArray(releases)) return { notes, complete: true };
    }
  } catch {}
  const changelog = info.releaseNotes;
  const notes =
    typeof changelog === "string"
      ? changelogNotes(changelog)
      : (changelog ?? []).flatMap((n) => (n.note ? changelogNotes(n.note) : []));
  return { notes, complete: false };
}

/**
 * Checks this repo's GitHub Releases for a newer signed build on launch and
 * every four hours, and downloads it in the background. Nothing interrupts
 * the person: the server it starts lists what's ready on this Mac's machine
 * in the catalog, the studio's title bar offers Update, and that installs it
 * here and on the person's other Macs (@ponzu/core's update.ts). It also
 * installs the next time Ponzu quits; with no window open, main quits on its
 * own once agents go idle.
 *
 * The server reaches it on a local port with a token (`PONZU_APP_ENDPOINT`,
 * `PONZU_APP_TOKEN`): GET for what it has, POST /install to install. Only a
 * packaged build checks: development has no feed to compare against, and
 * lists no updater.
 */
export async function installUpdater(opts: {
  window: () => BrowserWindow | null;
  onReady: () => void;
}): Promise<{ endpoint: string; token: string } | null> {
  if (!app.isPackaged) return null;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  let ready: MachineUpdate["ready"];
  /** Whether `ready`'s notes cover every release since this one. */
  let readyComplete = false;
  /** The person asked for it: restart as soon as it's downloaded. */
  let installing = false;
  /** The version they asked for: a download older than it isn't the one to restart into. */
  let target: string | undefined;
  /** Ponzu's own idea rather than the person's: nobody saw Update's notes. */
  let quiet = false;
  const readyFor = (version?: string) =>
    Boolean(ready && (!version || compareVersions(ready.version, version) >= 0));
  const state = (): MachineUpdate => ({
    version: app.getVersion(),
    ...(ready ? { ready } : {}),
    ...(installing ? { installing } : {}),
  });

  /**
   * A window open restarts into it; with none, quitting installs it and nothing reopens. Update's
   * popover listed what's new in the version asked for, so What's new needn't again, unless the
   * install was quiet or the notes missed releases.
   */
  const restart = () => {
    const seen = target ?? ready?.version;
    if (seen && !quiet && readyComplete) markWhatsNewSeen(seen);
    setTimeout(() => {
      if (opts.window()) autoUpdater.quitAndInstall();
      else app.quit();
    }, RESTART_DELAY);
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
   * or untouched a while.
   */
  const install = (o: { quiet?: boolean; version?: string }): MachineUpdate => {
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
    quiet = Boolean(o.quiet);
    if (readyFor(target)) restart();
    else fetchNewest();
    return state();
  };

  autoUpdater.on("update-downloaded", async (info) => {
    const { notes, complete } = await notesOf(info);
    ready = { version: info.version, notes };
    readyComplete = complete;
    opts.onReady();
    if (installing && readyFor(target)) restart();
  });
  autoUpdater.on("update-not-available", () => {
    installing = false;
  });
  // A failed check (offline, rate limited) is not worth a word; the next one retries.
  autoUpdater.on("error", () => {
    installing = false;
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
 * it finds shows as Update in the title bar once it's downloaded.
 */
export async function checkForUpdatesNow(win: BrowserWindow) {
  if (!app.isPackaged) {
    await ask(win, { message: "Updates are checked in the packaged app." });
    return;
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    if (result?.isUpdateAvailable) {
      await ask(win, {
        type: "info",
        message: `Ponzu ${result.updateInfo.version} is on its way`,
        detail: "It's downloading. Click Update in the title bar once it's ready.",
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
