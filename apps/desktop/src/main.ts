import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { SessionState } from "@ponzu/client";
import {
  app,
  type BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  protocol,
  safeStorage,
  session as sessions,
  shell,
} from "electron";
import { followAppearance } from "./appearance.ts";
import {
  type BridgeError,
  CHANNELS,
  type DeepLink,
  type MenuCommand,
  STUDIO_ORIGIN,
} from "./bridge.ts";
import { configFor } from "./config.ts";
import { contentSecurityPolicy } from "./csp.ts";
import { linksIn, parseDeepLink } from "./deep-links.ts";
import { removeLegacyOnce, runProgram } from "./legacy.ts";
import { registerAppImage } from "./linux.ts";
import { buildMenu, setSignedIn } from "./menu.ts";
import { externalLink, isStudio } from "./navigation.ts";
import { clientPlatform, type MainSession, mainSession } from "./session.ts";
import { sessionFileStorage } from "./session-file.ts";
import { blockNetwork, smoke, watchSmoke } from "./smoke.ts";
import { STUDIO_SCHEME, studioFile } from "./studio-files.ts";
import { memoryStorage, tokenStorage } from "./token-store.ts";
import { checkForUpdatesNow, installUpdater, type Updates } from "./updater.ts";
import { createMainWindow } from "./window.ts";

/*
 * Ponzu's main process: a window onto the studio, the session, links and updates. There is no
 * local server: the studio talks to Ponzu Cloud itself, with an access token it borrows from here.
 */

const config = configFor(app.isPackaged, process.env);

/*
 * A development build is an app of its own: its own data folder, keychain item ("Ponzu Dev Safe
 * Storage") and single-instance lock, so it never reads, refreshes or replaces an installed
 * Ponzu's session, nor quits because one is running. Both before anything reads either.
 */
if (app.name !== config.appName) {
  app.setName(config.appName);
  app.setPath("userData", join(app.getPath("appData"), config.appName));
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
const csp = contentSecurityPolicy(config);

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

function send(channel: string, ...args: unknown[]) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
}

/** A `ponzu://` link: the studio acts on it once it's listening. Anything else is dropped. */
function openLink(url: string) {
  const link = parseDeepLink(url, config.linkScheme);
  if (!link) return;
  showWindow();
  if (linkListeners > 0) send(CHANNELS.link, link);
  else pendingLinks.push(link);
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
  listen(CHANNELS.cancelSignIn, () => session.cancelSignIn());
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

/** Signed out, or let go until GitHub lets the person in again: nobody's designs belong here. */
function endsSession(state: SessionState): boolean {
  return state.status === "signed_out" || state.status === "github_reauth";
}

/**
 * Everything the studio kept: the designs last opened (whole documents, and the asset keys that
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

/** What the local app left on this computer, removed once, a moment after the first launch. */
function removeLegacySoon() {
  if (!app.isPackaged || smoke) return;
  setTimeout(async () => {
    const steps = await removeLegacyOnce(
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

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Windows and Linux hand a second launch its link in argv; the first launch's is read below.
  app.on("second-instance", (_event, argv) => {
    const links = linksIn(argv, config.linkScheme);
    for (const link of links) openLink(link);
    if (!links.length) showWindow();
  });

  // macOS: a link, which can arrive before ready when it is what launched Ponzu.
  app.on("open-url", (event, url) => {
    event.preventDefault();
    openLink(url);
  });
  // A development build takes `ponzu-dev:` links, through this checkout, and leaves an installed
  // Ponzu's alone.
  if (app.isPackaged) app.setAsDefaultProtocolClient(config.linkScheme);
  else
    app.setAsDefaultProtocolClient(config.linkScheme, process.execPath, [
      resolve(app.getAppPath()),
    ]);

  app.whenReady().then(() => {
    if (smoke) blockNetwork();
    protocol.handle(STUDIO_SCHEME, serveStudio);

    const { storage, persistence } = sessionStorage();
    const account = mainSession({
      config,
      version: app.getVersion(),
      storage,
      persistence,
      openBrowser: (url) => shell.openExternal(url),
      focus: () => {
        if (process.platform === "darwin") app.focus({ steal: true });
        showWindow();
      },
    });
    const session = account.session;
    let was = session.getState().status;
    session.subscribe(() => {
      const state = session.getState();
      if (state.status !== was && endsSession(state)) void forgetStudioData();
      was = state.status;
      send(CHANNELS.sessionChanged, state);
      setSignedIn(state.status === "signed_in");
    });
    // The smoke check never looks for updates: it touches no network.
    const updates = installUpdater((state) => send(CHANNELS.updateChanged, state), !smoke);
    registerIpc(account, updates);

    buildMenu({
      command: (command: MenuCommand) => {
        showWindow();
        send(CHANNELS.command, command);
      },
      checkForUpdates: () => {
        showWindow();
        if (mainWindow) void checkForUpdatesNow(mainWindow);
      },
      signOut: () => void session.signOut(),
      // Developer tools are a developer's: a release has no way to open them on someone's session.
      devTools: config.remoteDebugging,
    });
    setSignedIn(session.getState().status === "signed_in");

    for (const link of linksIn(process.argv, config.linkScheme)) openLink(link);
    showWindow();
    if (!smoke) {
      followAppearance();
      void registerAppImage().catch(() => {});
      removeLegacySoon();
    }
  });

  app.on("activate", () => showWindow());

  // The Mac keeps an app with no window in the dock; elsewhere closing the window quits.
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
