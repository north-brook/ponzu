import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import type { SessionState } from "@ponzu/client";
import {
  app,
  type BrowserWindow,
  dialog,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  Notification,
  protocol,
  safeStorage,
  session as sessions,
  shell,
} from "electron";
import { followAppearance } from "./appearance.ts";
import {
  type AnalyticsSetup,
  type BridgeError,
  CHANNELS,
  type DeepLink,
  type MenuCommand,
  STUDIO_ORIGIN,
} from "./bridge.ts";
import {
  adoptCheckoutFolder,
  awaitingSignIn,
  bringOverWindowState,
  carryOver,
  checkoutRunOpen,
  lockHeld,
  signedInOnce,
  skipWindowState,
} from "./carry-over.ts";
import {
  APP_NAMES,
  aboutVersion,
  bundleMismatch,
  claimsScheme,
  configFor,
  testBuild,
} from "./config.ts";
import { contentSecurityPolicy } from "./csp.ts";
import { dataFolder, removeOnceExited } from "./data-folder.ts";
import { linksIn, parseDeepLink } from "./deep-links.ts";
import { launchOnce, recordLaunch } from "./launches.ts";
import { removeLegacyFor, runProgram, takeWelcome1x } from "./legacy.ts";
import { registerAppImage } from "./linux.ts";
import { startMainTelemetry } from "./main-telemetry.ts";
import { buildMenu, setSignedIn } from "./menu.ts";
import { externalLink, isStudio } from "./navigation.ts";
import {
  createNotifier,
  deviceNameOf,
  installIdIn,
  type NotificationClass,
  type Notifier,
} from "./notifications.ts";
import { clientPlatform, type MainSession, mainSession } from "./session.ts";
import { sessionFileStorage } from "./session-file.ts";
import { blockNetwork, smoke, watchSmoke } from "./smoke.ts";
import { STUDIO_SCHEME, studioFile } from "./studio-files.ts";
import { requestIdOf, type SupportFacts } from "./support.ts";
import { telemetryOffBecause } from "./telemetry-consent.ts";
import { memoryStorage, tokenStorage } from "./token-store.ts";
import { checkForUpdatesNow, installUpdater, type Updates } from "./updater.ts";
import { createMainWindow } from "./window.ts";

/*
 * Ponzu's main process: a window onto the studio, the session, links and updates. There is no
 * local server: the studio talks to Ponzu Cloud itself, with an access token it borrows from here.
 */

/*
 * Where this build talks to was baked in by scripts/build.ts. A test build given an override it
 * can't use (PONZU_ENVIRONMENT_OVERRIDE) stops here rather than talk to the baked one instead.
 */
const config = (() => {
  try {
    return configFor(app.isPackaged, process.env);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    console.error(why);
    if (!smoke) dialog.showErrorBox("Ponzu can't start", why);
    process.exit(1);
  }
})();

/*
 * Ponzu Dev and Ponzu Local (a run from a checkout) are apps of their own: their own data folder,
 * keychain item ("Ponzu Dev Safe Storage", "Ponzu Local Safe Storage") and single-instance lock,
 * so none reads, refreshes or replaces another's session, nor quits because another is running.
 * The smoke check runs on a throwaway folder, whichever app it checks (data-folder.ts).
 * All of it before anything reads the name or the folder, and only once the bundle and the main
 * process agree on which app this is (`bundleMismatch`).
 */
const mismatch = bundleMismatch(app.isPackaged, app.name, config);
if (mismatch) {
  console.error(mismatch);
  // The smoke check's caller reads the exit code; a person needs to be told.
  if (!smoke) dialog.showErrorBox("Ponzu can't start", mismatch);
  process.exit(1);
}
if (app.name !== config.appName) app.setName(config.appName);
const userData = dataFolder(app.getPath("appData"), config.appName, { smoke });
app.setPath("userData", userData);
app.setPath("sessionData", userData);
// Removed by a shell once this process is gone, however the check ends: a verdict, a crash or
// the caller's timeout (data-folder.ts).
if (smoke) removeOnceExited(userData);

/*
 * The first launch after the rename (carry-over.ts): Ponzu Dev takes what it safely can from
 * Ponzu Preview, and each of it and Ponzu Local sees that a checkout run's old "Ponzu Dev" folder
 * ends up as Ponzu Local's. Before the instance lock, which lives in the folder; never in the
 * smoke check, which touches nobody's folders. A failure is logged and the app starts as new.
 */
const carryOverHost = { appData: app.getPath("appData"), running: lockHeld, now: () => new Date() };
const asPonzuDev = !smoke && app.isPackaged && config.appName === APP_NAMES.dev;
if (asPonzuDev && checkoutRunOpen(carryOverHost)) {
  // It would share Ponzu Dev's lock, folder and session; quitting it is the person's call.
  dialog.showErrorBox(
    "Quit the older Ponzu Dev first",
    "A Ponzu run from a checkout made before the rename is open, and it is also called Ponzu Dev. Quit it, update that checkout, and open Ponzu Dev again.",
  );
  process.exit(1);
}
/** Ponzu Preview was open at the first launch: its window state waits on the person (below). */
let previewOpen = false;
if (!smoke) {
  try {
    if (!app.isPackaged) {
      const adopted = adoptCheckoutFolder(carryOverHost);
      if (adopted) console.log(`Moved the checkout run's "Ponzu Dev" folder to ${adopted}.`);
    } else if (asPonzuDev) {
      const done = carryOver(carryOverHost);
      if (done) console.log(`First launch as Ponzu Dev: ${JSON.stringify(done)}`);
      previewOpen = done?.windowState === "running";
    }
  } catch (error) {
    console.error(`Couldn't carry over the earlier app's data: ${error}`);
  }
}
/** Window state carried over from Ponzu Preview, kept while signed out until the first sign-in. */
let keepCarriedOver = !smoke && awaitingSignIn(userData);

/**
 * Ponzu Preview is open, so its window state can't be copied mid-write: the person quits it and
 * tries again, or goes on without it. Before anything opens the studio's storage. Quitting Ponzu
 * Dev here instead asks again next time.
 */
async function waitForPonzuPreview(): Promise<void> {
  while (previewOpen) {
    const { response } = await dialog.showMessageBox({
      type: "info",
      message: "Ponzu Preview is open",
      detail:
        "Quit Ponzu Preview, then choose Try Again, and Ponzu Dev opens the way you left it: the same workspace and canvas, sidebar and filters.",
      buttons: ["Try Again", "Continue Without"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 1) {
      skipWindowState(userData);
      previewOpen = false;
      break;
    }
    try {
      previewOpen = bringOverWindowState(carryOverHost).windowState === "running";
    } catch (error) {
      console.error(`Couldn't carry over Ponzu Preview's window state: ${error}`);
      previewOpen = false;
    }
  }
  keepCarriedOver = awaitingSignIn(userData);
}

/*
 * A debugging port would hand the signed-in window, and the access tokens it can borrow, to any
 * program on the computer. A release refuses to start with one; the fuses (package.json) close
 * Node's own inspector and ELECTRON_RUN_AS_NODE the same way.
 */
if (
  !config.remoteDebugging &&
  (app.commandLine.hasSwitch("remote-debugging-port") ||
    app.commandLine.hasSwitch("remote-debugging-pipe"))
) {
  console.error("Ponzu doesn't open a remote debugging port.");
  process.exit(1);
}

/** The built main and preload live in <app>/dist, in development and inside the bundle. */
const here = join(app.getAppPath(), "dist");
const studioRoot = app.isPackaged
  ? join(process.resourcesPath, "studio")
  : join(app.getAppPath(), "../studio/dist");
const studioOrigins = [STUDIO_ORIGIN, ...(config.studioDevUrl ? [config.studioDevUrl] : [])];

/*
 * Usage analytics and error tracking (docs/analytics.md): only when this build has a PostHog
 * project, the smoke check isn't running, and the person hasn't said no the ways 1.x heard.
 * Otherwise nothing of PostHog loads here or in the studio, and the policy reaches none of it.
 */
const offBecause = telemetryOffBecause(process.env, homedir());
const posthog = config.posthog && !smoke && !offBecause ? config.posthog : null;
if (config.posthog && offBecause && !smoke) console.log(`Usage analytics off: ${offBecause}.`);
const csp = contentSecurityPolicy({ ...config, posthog });
/** This launch's facts, handed to the first window only (`launchOnce`). */
const takeLaunch = launchOnce(
  posthog
    ? recordLaunch(join(userData, "launches.json"), app.getVersion())
    : { first: false, updatedFrom: null },
);
/** What every event from this build carries, the main process's and the studio's. */
const buildProperties = {
  app_version: app.getVersion(),
  channel: config.appName,
  platform: process.platform,
  os_version: process.getSystemVersion(),
  environment: config.environment,
  app_commit: config.commit,
};
/** What a new window is told about analytics; the launch's facts go to the first one only. */
const analyticsFor = (): AnalyticsSetup | null =>
  posthog
    ? {
        key: posthog.key,
        host: posthog.host,
        replay: posthog.replay,
        channel: config.appName,
        osVersion: buildProperties.os_version,
        environment: config.environment,
        commit: config.commit,
        launch: takeLaunch(),
      }
    : null;
/** Who the main process's errors are put down to: set once the session is read. */
let signedInUser: () => string | null = () => null;
const telemetry = posthog
  ? startMainTelemetry({
      posthog,
      properties: buildProperties,
      userId: () => signedInUser(),
      home: homedir(),
    })
  : null;

/**
 * What this install is to the API, for the Mac's own notifications (notifications.ts): an id made
 * once in the app's data folder, and the computer's name. Read when the first window opens.
 */
let device: { installId: string; name: string | null } | null = null;
function deviceFacts() {
  device ??= {
    installId: installIdIn(join(userData, "install-id")),
    name: deviceNameOf(computerName()),
  };
  return device;
}

/**
 * The name the person gave this computer ("Maya's MacBook Pro", System Settings › General ›
 * About), which `os.hostname()` gives only as a host name ("Mayas-MacBook-Pro.local"). Read
 * once; the host name stands in when it can't be.
 */
function computerName(): string {
  if (process.platform === "darwin") {
    try {
      const name = execFileSync("/usr/sbin/scutil", ["--get", "ComputerName"], {
        encoding: "utf8",
        timeout: 1000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (name) return name;
    } catch {
      // No name kept, or scutil missing: the host name.
    }
  }
  return hostname();
}

let mainWindow: BrowserWindow | null = null;
/** Links that arrived before the studio listened for them. */
const pendingLinks: DeepLink[] = [];
/** The studio's listeners for links: none while signed out, when links wait here. */
let linkListeners = 0;

// A standard, secure scheme of our own: one origin for the studio's storage and the API's CORS.
protocol.registerSchemesAsPrivileged([
  {
    scheme: STUDIO_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
  },
]);

/*
 * GPU memory. Chromium sizes the tile budget from the whole screen, not the window: about 1.2 GB
 * per 2056×1329@2x screen, up to a quarter of RAM, so a big display hands one canvas several GB
 * of tiles it never needs. 4 GB keeps that in check while leaving room for a page of heavy
 * boards mid-zoom. The discardable limit caps Skia's glyph, path and image caches in the GPU
 * process. Skia Graphite stays on: on macOS, turning it off falls back to software compositing.
 */
app.commandLine.appendSwitch("force-gpu-mem-available-mb", "4096");
app.commandLine.appendSwitch("force-gpu-mem-discardable-limit-mb", "64");

/* ------------------------------------------------------------------ */
/* The studio                                                          */
/* ------------------------------------------------------------------ */

async function serveStudio(request: Request): Promise<Response> {
  const file = studioFile(studioRoot, request.url);
  if (!file) return new Response("Not found", { status: 404 });
  return new Response(await readFile(file.path), {
    headers: {
      "content-type": file.type,
      "content-security-policy": csp,
      "x-content-type-options": "nosniff",
      "cache-control": "no-cache",
    },
  });
}

function showWindow() {
  if (!app.isReady()) return;
  if (!mainWindow || mainWindow.isDestroyed()) {
    const analytics = analyticsFor();
    mainWindow = createMainWindow({
      url: config.studioDevUrl ?? `${STUDIO_ORIGIN}/`,
      preload: join(here, "preload.cjs"),
      studio: studioOrigins,
      hidden: smoke,
      devTools: config.remoteDebugging,
      args: {
        version: app.getVersion(),
        api: config.apiUrl,
        client: clientPlatform(),
        dev: app.isPackaged ? "0" : "1",
        scheme: config.linkScheme ?? "",
        ...(analytics ? { analytics: encodeURIComponent(JSON.stringify(analytics)) } : {}),
        // The Mac's own notifications: whether the system shows any, and this install.
        notify: !smoke && Notification.isSupported() ? "1" : "0",
        install: deviceFacts().installId,
        device: encodeURIComponent(deviceFacts().name ?? ""),
      },
    });
    const win = mainWindow;
    win.on("closed", () => {
      if (mainWindow === win) mainWindow = null;
    });
    // A reload or a crash starts the studio again; it asks for queued links when it listens.
    win.webContents.on("did-start-navigation", ({ isMainFrame, isSameDocument }) => {
      if (isMainFrame && !isSameDocument) linkListeners = 0;
    });
    win.webContents.on("render-process-gone", (_event, details) => {
      if (!smoke && details.reason !== "clean-exit") win.reload();
    });
    if (smoke) watchSmoke(win);
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/**
 * Ponzu in front of whatever the person was in (the browser, as a sign-in or an install comes
 * back). A Mac only lets an app take the focus from another when it asks to steal it.
 */
function comeForward() {
  if (process.platform === "darwin") app.focus({ steal: true });
  showWindow();
}

function send(channel: string, ...args: unknown[]) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
}

/** A link in this app's scheme: the studio acts on it once it's listening. Anything else is dropped. */
function openLink(url: string) {
  const link = config.linkScheme ? parseDeepLink(url, config.linkScheme) : null;
  if (link) followLink(link);
}

/** A link the studio acts on once it's listening: from a `ponzu://` link, or a banner clicked. */
function followLink(link: DeepLink) {
  // Its kind only: what a link names stays out of the log.
  console.log(`Link: ${link.kind}, ${linkListeners > 0 ? "to the studio" : "waiting for it"}`);
  showWindow();
  if (linkListeners > 0) send(CHANNELS.link, link);
  else pendingLinks.push(link);
}

/**
 * The Mac's own banners and the dock's badge (notifications.ts), shown as the studio asks. A
 * click brings Ponzu forward and hands the banner's link to the studio like any other link.
 * The smoke check shows none.
 */
let notifier: Notifier | null = null;
function notifications(): Notifier {
  notifier ??= createNotifier({
    Notification: Notification as unknown as NotificationClass,
    setBadge: (count) => {
      if (!smoke) app.setBadgeCount(count);
    },
    open: (link) => {
      comeForward();
      followLink(link);
    },
    failed: (id) => send(CHANNELS.notifyFailed, id),
  });
  return notifier;
}

/* ------------------------------------------------------------------ */
/* IPC: only the studio, in the main window's top frame                */
/* ------------------------------------------------------------------ */

function fromStudio(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  const top = event.sender.mainFrame;
  return (
    !!mainWindow &&
    !mainWindow.isDestroyed() &&
    event.sender.id === mainWindow.webContents.id &&
    frame !== null &&
    frame.processId === top.processId &&
    frame.routingId === top.routingId &&
    isStudio(frame.url, studioOrigins)
  );
}

function handle(channel: string, answer: (...args: unknown[]) => unknown) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!fromStudio(event)) {
      throw new Error(
        `Only the studio may ask that, not ${event.senderFrame?.url ?? "a closed frame"}.`,
      );
    }
    return answer(...args);
  });
}

function listen(channel: string, act: (...args: unknown[]) => void) {
  ipcMain.on(channel, (event, ...args) => {
    if (fromStudio(event)) act(...args);
  });
}

function registerIpc(session: MainSession, updater: Updates) {
  handle(CHANNELS.sessionState, () => session.session.getState());
  handle(CHANNELS.sessionPersistence, () => session.persistence());
  handle(CHANNELS.accessToken, (rejected) =>
    session.accessToken(typeof rejected === "string" ? rejected : undefined),
  );
  listen(CHANNELS.report, (error) => {
    if (isBridgeError(error)) session.report(error);
  });
  handle(CHANNELS.signIn, () => session.signIn());
  handle(CHANNELS.signOut, () => session.session.signOut());
  handle(CHANNELS.links, () => {
    linkListeners++;
    return pendingLinks.splice(0);
  });
  listen(CHANNELS.linksStop, () => {
    linkListeners = Math.max(0, linkListeners - 1);
  });
  handle(CHANNELS.updateState, () => updater.state());
  listen(CHANNELS.updateCheck, () => updater.check());
  listen(CHANNELS.updateInstall, () => updater.install());
  listen(CHANNELS.openExternal, (url) => {
    const link = typeof url === "string" ? externalLink(url) : null;
    if (link) void shell.openExternal(link);
  });
  listen(CHANNELS.comeForward, () => comeForward());
  listen(CHANNELS.notifyShow, (notice) => {
    if (!smoke) notifications().show(notice);
  });
  listen(CHANNELS.notifyRemove, (ids) => notifications().remove(ids));
  listen(CHANNELS.notifyBadge, (count) => notifications().setBadge(count));
  handle(CHANNELS.welcome1x, () => welcome1x());
}

function isBridgeError(value: unknown): value is BridgeError {
  const error = value as Partial<BridgeError> | null;
  return (
    typeof error?.status === "number" &&
    typeof error.code === "string" &&
    typeof error.message === "string"
  );
}

/* ------------------------------------------------------------------ */
/* The session                                                         */
/* ------------------------------------------------------------------ */

/**
 * Where the tokens live: nowhere for the smoke check (it must never touch the keychain), a
 * developer's saved session when a development or test build is given one, and otherwise the
 * keychain.
 */
function sessionStorage() {
  if (smoke) return { storage: memoryStorage(), persistence: () => "memory" as const };
  const file = config.sessionFile;
  if (file) {
    console.warn(`Using the developer session saved in ${file}, unencrypted.`);
    return { storage: sessionFileStorage(file), persistence: () => "file" as const };
  }
  return tokenStorage(join(app.getPath("userData"), "session.bin"), {
    available: () =>
      safeStorage.isEncryptionAvailable() &&
      // Linux without a keyring "encrypts" with a key in the clear: as good as plain text.
      !(process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text"),
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (data) => safeStorage.decryptString(data),
  });
}

/** Signed out, or let go until GitHub lets the person in again: nobody's canvases belong here. */
function endsSession(state: SessionState): boolean {
  return state.status === "signed_out" || state.status === "github_reauth";
}

/**
 * Everything the studio kept: the canvases last opened (whole documents, and the asset keys that
 * open their files) and the person's window state. The studio stops writing them as it signs
 * out (desktop-host.ts).
 */
async function forgetStudioData(): Promise<void> {
  for (const origin of studioOrigins) {
    await sessions.defaultSession
      .clearStorageData({
        origin,
        storages: ["localstorage", "indexdb", "cachestorage", "serviceworkers"],
      })
      .catch((error: unknown) => console.error(`Couldn't clear the studio's data: ${error}`));
  }
}

/* ------------------------------------------------------------------ */
/* Ponzu 1.x                                                           */
/* ------------------------------------------------------------------ */

/**
 * What the local app left on this computer, removed once, a moment after the release's first
 * launch. Ponzu Dev and Ponzu Local leave it all alone (`removeLegacyFor`).
 */
function removeLegacySoon() {
  if (!config.cleansUpLegacy || smoke) return;
  setTimeout(async () => {
    const steps = await removeLegacyFor(
      config,
      {
        platform: process.platform,
        home: homedir(),
        env: process.env,
        uid: process.getuid?.() ?? 0,
        exists: existsSync,
        run: runProgram,
      },
      join(app.getPath("userData"), "legacy-cleanup.json"),
      app.getVersion(),
    ).catch((error: unknown) => {
      console.error(`Ponzu 1.x cleanup failed: ${error}`);
      return null;
    });
    for (const step of steps ?? []) {
      console.log(
        `Ponzu 1.x cleanup: ${step.what}: ${step.outcome}${step.why ? ` (${step.why})` : ""}`,
      );
    }
  }, 3000);
}

/**
 * Whether the studio shows the welcome from 1.x: once, on a computer 1.x was on, in a release
 * someone is using (never the smoke check or a test build), recorded in welcome-1x.json.
 */
function welcome1x(): boolean {
  try {
    return takeWelcome1x({
      build: config,
      driven: smoke || testBuild,
      host: { home: homedir(), env: process.env, exists: existsSync },
      legacyRecord: join(app.getPath("userData"), "legacy-cleanup.json"),
      welcomeRecord: join(app.getPath("userData"), "welcome-1x.json"),
      version: app.getVersion(),
    });
  } catch (error) {
    console.error(`Couldn't tell whether Ponzu 1.x was here: ${error}`);
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Support                                                             */
/* ------------------------------------------------------------------ */

/** The id of the API's last answer to the studio, for Help › Contact Support. Only the id. */
let lastRequestId: string | null = null;

/** Hear each answer the API gives the window, for its request id; nothing else of it is kept. */
function watchRequestIds() {
  // Every http(s) answer, then only the API's: a pattern with a port in it (Ponzu Local's
  // localhost API) isn't one webRequest takes.
  const api = new URL(config.apiUrl).origin;
  sessions.defaultSession.webRequest.onCompleted(
    { urls: ["https://*/*", "http://*/*"] },
    (details) => {
      if (!URL.canParse(details.url) || new URL(details.url).origin !== api) return;
      // The latest answer's id, or none: an answer without one (a gateway's error) must not
      // leave an older request's id to be reported as the one that went wrong.
      lastRequestId = requestIdOf(details.responseHeaders);
    },
  );
}

function supportFacts(): SupportFacts {
  return {
    version: app.getVersion(),
    // The same facts About and analytics carry: what scripts/build.ts baked, as config.ts read it.
    commit: config.commit,
    environment: config.environment,
    lastRequestId,
  };
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Windows and Linux hand a second launch its link in argv; the first launch's is read below.
  app.on("second-instance", (_event, argv) => {
    const links = config.linkScheme ? linksIn(argv, config.linkScheme) : [];
    for (const link of links) openLink(link);
    if (!links.length) showWindow();
  });

  // macOS: a link, which can arrive before ready when it is what launched Ponzu.
  app.on("open-url", (event, url) => {
    event.preventDefault();
    openLink(url);
  });
  /*
   * Ponzu takes `ponzu:` links and Ponzu Dev `ponzu-dev:`, each declared in its bundle's
   * Info.plist (package.json's `protocols`, packaging.ts), which is what reaches a Mac's running
   * app, or starts it. Ponzu Local takes none: use Ponzu Dev for links. The smoke check claims
   * nothing (`claimsScheme`).
   */
  if (config.linkScheme && claimsScheme(config, smoke)) {
    app.setAsDefaultProtocolClient(config.linkScheme);
  }

  app.whenReady().then(async () => {
    await waitForPonzuPreview();
    if (smoke) blockNetwork();
    else watchRequestIds();
    protocol.handle(STUDIO_SCHEME, serveStudio);

    const { storage, persistence } = sessionStorage();
    const account = mainSession({
      config,
      version: app.getVersion(),
      storage,
      persistence,
      openBrowser: (url) => shell.openExternal(url),
      focus: comeForward,
    });
    const session = account.session;
    signedInUser = () => {
      const state = session.getState();
      return state.status === "signed_in" ? state.user.id : null;
    };
    let was = session.getState().status;
    session.subscribe(() => {
      const state = session.getState();
      if (state.status === "signed_in" && keepCarriedOver) {
        keepCarriedOver = false;
        signedInOnce(userData);
      }
      // A launch signed out forgets what the studio kept, except window state carried over from
      // Ponzu Preview, which waits here for the person's first sign-in (carry-over.ts).
      const launching = was === "loading" && keepCarriedOver;
      if (state.status !== was && endsSession(state) && !launching) void forgetStudioData();
      // Nobody's questions wait on the dock, nor their banners in Notification Center, once they
      // have signed out: whoever signs in next sees none of them. The smoke check touches neither.
      if (state.status !== was && endsSession(state) && !smoke) notifications().clear();
      was = state.status;
      send(CHANNELS.sessionChanged, state);
      setSignedIn(state.status === "signed_in");
    });
    // The smoke check never looks for updates: it touches no network. Ponzu Dev has no feed.
    const updates = installUpdater(
      (state) => send(CHANNELS.updateChanged, state),
      config.updates && !smoke,
    );
    registerIpc(account, updates);
    // A sign-in still waiting in the browser goes with the app, and only then.
    app.on("will-quit", () => account.closeSignIns());

    buildMenu({
      command: (command: MenuCommand) => {
        showWindow();
        send(CHANNELS.command, command);
      },
      // Ponzu Dev doesn't update itself, so its menus don't offer to.
      checkForUpdates: config.updates
        ? () => {
            showWindow();
            if (mainWindow) void checkForUpdatesNow(mainWindow);
          }
        : null,
      signOut: () => void session.signOut(),
      // Developer tools are a developer's: a release has no way to open them on someone's session.
      devTools: config.remoteDebugging,
      about: aboutVersion(config),
      supportFacts,
    });
    setSignedIn(session.getState().status === "signed_in");

    if (config.linkScheme) {
      for (const link of linksIn(process.argv, config.linkScheme)) openLink(link);
    }
    showWindow();
    if (!smoke) {
      followAppearance();
      // The AppImage's desktop entry claims `ponzu:` links: the release's alone.
      if (config.linkScheme === "ponzu") void registerAppImage().catch(() => {});
      removeLegacySoon();
    }
  });

  app.on("activate", () => showWindow());

  // What the main process has queued goes before it quits, for two seconds at most.
  let flushed = false;
  app.on("will-quit", (event) => {
    if (!telemetry || flushed) return;
    event.preventDefault();
    flushed = true;
    void telemetry.shutdown().finally(() => app.quit());
  });

  // The Mac keeps an app with no window in the dock; elsewhere closing the window quits.
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
