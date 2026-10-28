import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Catalog, parseDesignLink } from "@ponzu/core";
import { cloneTarget, parseOpenUrl, spawnGit } from "@ponzu/server/clone";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  shell,
  Tray,
} from "electron";
import { followAppearance } from "./appearance";
import { associateDesigns, designPath, launchArgs } from "./designs";
import { renderToken, startRenderHost } from "./render-host";
import { smoke, watchSmoke } from "./smoke";
import { checkForUpdatesNow, installUpdater, relaunchedInBackground } from "./updater";

const isDev = !app.isPackaged;
/** The built main/preload live in <app>/dist, in development and inside the bundle. */
const here = join(app.getAppPath(), "dist");

/** The bundled CLI: `bun build --compile` names it ponzu.exe on Windows. */
const SERVER_BIN = process.platform === "win32" ? "server/ponzu.exe" : "server/ponzu";

/** Paths inside the app bundle, or the monorepo during development. */
const paths = {
  server: join(isDev ? here : process.resourcesPath, SERVER_BIN),
  studio: isDev ? join(here, "../../studio/dist") : join(process.resourcesPath, "studio"),
  preload: join(here, "preload.cjs"),
  /** Windows and Linux: the tray icon, tray.png and tray@2x.png. */
  tray: isDev ? join(here, "../build") : join(process.resourcesPath, "tray"),
};

let server: ChildProcess | null = null;
let serverUrl: string | null = null;
let mainWindow: BrowserWindow | null = null;
const pendingOpens: string[] = [];
/** ponzu:// links that arrived before the server was up. */
const pendingLinks: string[] = [];
/**
 * Started by an agent (`ponzu mcp`), not the person, or restarted into an
 * update while it had no window: serve without a window or dock icon until
 * they open Ponzu themselves.
 */
let background = process.argv.includes("--background");
let updateReady = false;

/*
 * GPU memory. Chromium sizes the tile budget from the whole screen, not the
 * window: about 1.2 GB per 2056×1329@2x screen, up to a quarter of RAM, so a
 * big display hands one canvas several GB of tiles it never needs (a tall
 * page can hold over 2 GB). 512 MB is Chromium's own floor and
 * still covers a full-screen 6K window's visible tiles. The discardable limit
 * caps Skia's glyph, path and image caches in the GPU process (256 MB by
 * default, and Graphite keeps a copy per backend).
 * Skia Graphite stays on: on macOS, turning it off doesn't fall back to GPU
 * raster but to software compositing, which halves frame rates on filters.
 */
app.commandLine.appendSwitch("force-gpu-mem-available-mb", "512");
app.commandLine.appendSwitch("force-gpu-mem-discardable-limit-mb", "64");

/* ------------------------------------------------------------------ */
/* The local Ponzu server                                             */
/* ------------------------------------------------------------------ */

/**
 * Where the server starts. Never a folder macOS guards (Documents, Desktop):
 * reading one asks "Ponzu would like to access files in your Documents
 * folder" before anyone has asked Ponzu for anything. The home screen finds
 * designs through Spotlight, wherever they are.
 */
function serverCwd(): string {
  return app.getPath("userData");
}

function startServer(
  renderEndpoint: string,
  port: number,
  updater: { endpoint: string; token: string } | null,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const bin = paths.server;
    const [cmd, args] = existsSync(bin)
      ? [bin, []]
      : ["bun", [join(here, "../../cli/src/index.ts")]];
    const child = spawn(
      cmd,
      [...args, "serve", "--no-open", "--port", String(port), "--studio", paths.studio],
      {
        cwd: serverCwd(),
        env: {
          ...process.env,
          PONZU_DESKTOP: "1",
          PONZU_LAUNCHED_BY: background ? "agent" : "person",
          // Development and the smoke check aren't anyone using Ponzu.
          ...(isDev || smoke ? { PONZU_TELEMETRY: "0" } : {}),
          // The smoke check proves the bundled server can open its catalog database.
          ...(smoke ? { PONZU_DB_STRICT: "1" } : {}),
          PONZU_RENDER_ENDPOINT: renderEndpoint,
          PONZU_RENDER_TOKEN: renderToken,
          ...(updater
            ? { PONZU_APP_ENDPOINT: updater.endpoint, PONZU_APP_TOKEN: updater.token }
            : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    server = child;
    let settled = false;
    child.stdout?.on("data", (d: Buffer) => {
      const m = /PONZU_READY (.+)/.exec(d.toString());
      if (m && !settled) {
        settled = true;
        resolve((JSON.parse(m[1]!) as { url: string }).url);
      }
    });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.once("exit", (code: number | null) => {
      if (!settled) {
        settled = true;
        reject(new Error(stderr || `server exited with ${code}`));
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/* Agents                                                              */
/* ------------------------------------------------------------------ */

/**
 * Register Ponzu with the agents on this Mac (`ponzu install --auto`): new
 * ones get it, and old fixed-URL setups move to the command that runs inside
 * this app. The command reaches the app through a shim, so it updates with it.
 */
function setupAgents() {
  if (isDev && !process.env.PONZU_SETUP_AGENTS) return;
  if (!existsSync(paths.server)) return;
  const child = spawn(paths.server, ["install", "--auto"], { stdio: "ignore" });
  child.on("error", () => {});
}

/**
 * The wake helper (`ponzu wake install`): a LaunchAgent, or on Linux a systemd user socket,
 * that starts Ponzu in the background when the iPhone app knocks on port 7778. Installed builds
 * only, on every launch, so it follows the app when it moves; unchanged, it's left alone.
 */
function setupWake() {
  if ((process.platform !== "darwin" && process.platform !== "linux") || isDev) return;
  if (!existsSync(paths.server)) return;
  const child = spawn(paths.server, ["wake", "install"], { stdio: "ignore" });
  child.on("error", () => {});
}

/**
 * Ponzu › Install Terminal Command…: `ponzu` in /usr/local/bin, which macOS asks
 * an admin's password to write. The launch check links it without asking where
 * the person's shell searches a folder of their own (apps/cli/src/command.ts);
 * this is for a Mac where none does. It links the shim that check writes, so
 * the command updates with the app.
 */
async function installCommand() {
  const shim = join(process.env.PONZU_HOME ?? join(homedir(), ".ponzu"), "bin/ponzu");
  const link = "/usr/local/bin/ponzu";
  const ours = (p: string) => {
    try {
      return realpathSync(p) === realpathSync(shim);
    } catch {
      return false;
    }
  };
  if (!existsSync(shim)) {
    dialog.showErrorBox(
      "Ponzu can't install its command yet",
      "Move Ponzu to your Applications folder and open it from there, then try again.",
    );
    return;
  }
  const installed = [join(homedir(), ".local/bin/ponzu"), join(homedir(), "bin/ponzu"), link].find(
    ours,
  );
  if (installed) {
    await dialog.showMessageBox({
      message: "The ponzu command is installed",
      detail: `It's at ${installed}. Open a new terminal window and run ponzu.`,
    });
    return;
  }
  if (lstatSync(link, { throwIfNoEntry: false })) {
    const { response } = await dialog.showMessageBox({
      type: "warning",
      message: `Replace ${link}?`,
      detail: "Another ponzu command is installed there.",
      buttons: ["Replace", "Cancel"],
      defaultId: 1,
      cancelId: 1,
    });
    if (response !== 0) return;
  }
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const command = `mkdir -p /usr/local/bin && ln -sf ${quote(shim)} ${link}`;
  const script = `do shell script "${command.replace(/[\\"]/g, "\\$&")}" with administrator privileges`;
  execFile("osascript", ["-e", script], async (err, _out, stderr) => {
    // -128: the person cancelled the password prompt.
    if (err && !stderr.includes("(-128)"))
      dialog.showErrorBox("Ponzu couldn't install its command", stderr || String(err));
    else if (!err)
      await dialog.showMessageBox({
        message: "The ponzu command is installed",
        detail: "Open a new terminal window and run ponzu.",
      });
  });
}

/** With no window open, quit once agents have been quiet a while. Updates install on quit. */
const IDLE_QUIT = 15 * 60_000;
const IDLE_QUIT_UPDATE = 60_000;
function watchIdle() {
  setInterval(async () => {
    if (mainWindow || !serverUrl) return;
    try {
      const res = await fetch(`${serverUrl}/api/info`);
      const { idle } = (await res.json()) as { idle?: number };
      if (idle !== undefined && idle * 1000 >= (updateReady ? IDLE_QUIT_UPDATE : IDLE_QUIT))
        app.quit();
    } catch {}
  }, 30_000);
}

/* ------------------------------------------------------------------ */
/* Windows                                                             */
/* ------------------------------------------------------------------ */

/**
 * What the window shows while the server starts: the slice, its segments
 * fading in turn, faded in only if the start takes long enough to notice.
 * Self-contained, so it paints before anything else is up. The segments are
 * `SLICE` from @ponzu/react.
 */
function splashUrl() {
  const segments = [
    "M36 25.07L36 4.99A27.3 27.3 0 0 1 53.39 15.03Z",
    "M40 32L57.39 21.96A27.3 27.3 0 0 1 57.39 42.04Z",
    "M36 38.93L53.39 48.97A27.3 27.3 0 0 1 36 59.01Z",
    "M28 38.93L28 59.01A27.3 27.3 0 0 1 10.61 48.97Z",
    "M24 32L6.61 42.04A27.3 27.3 0 0 1 6.61 21.96Z",
    "M28 25.07L10.61 15.03A27.3 27.3 0 0 1 28 4.99Z",
  ]
    .map((d, i) => `<path d="${d}" style="animation-delay:${i * 0.2 - 1.2}s"/>`)
    .join("");
  const html = `<!doctype html><meta charset="utf-8"><style>
:root{color-scheme:light dark;background:#e8e6e0}
@media (prefers-color-scheme:dark){:root{background:#0e0e0d}}
body{margin:0;height:100vh;display:grid;place-items:center;-webkit-app-region:drag}
svg{opacity:0;animation:in .3s ease-out .3s forwards}
path{animation:juice 1.2s linear infinite both}
@keyframes in{to{opacity:1}}
@keyframes juice{0%,100%{opacity:1}70%{opacity:.16}}
@media (prefers-reduced-motion:reduce){svg{opacity:1;animation:none}path{animation:none}}
</style><svg width="44" height="44" viewBox="0 0 64 64"><g fill="#FFC81E" stroke="#FFC81E" stroke-width="3.4" stroke-linejoin="round">${segments}</g></svg>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/** A window on the splash, until the server is up. */
let splashing = false;

/**
 * Windows draws its caption buttons over the studio's title bar, in its colours: the studio's
 * `--background` and `--foreground`, and its header's 40px.
 */
const titleBarOverlay = (): Electron.TitleBarOverlayOptions => ({
  color: nativeTheme.shouldUseDarkColors ? "#0e0e0d" : "#e8e6e0",
  symbolColor: nativeTheme.shouldUseDarkColors ? "#f4f3ef" : "#111110",
  height: 40,
});

/**
 * The window's frame. The Mac's traffic lights and Windows' caption buttons sit in the
 * studio's title bar, which leaves room for them; Linux keeps its own title bar and menus.
 */
function chrome(): Electron.BrowserWindowConstructorOptions {
  if (process.platform === "darwin")
    return { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 13 } };
  if (process.platform === "win32")
    return { titleBarStyle: "hidden", titleBarOverlay: titleBarOverlay() };
  return {};
}

function createWindow(url: string) {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    ...chrome(),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0e0e0d" : "#e8e6e0",
    show: false,
    webPreferences: { preload: paths.preload, contextIsolation: true, sandbox: true },
  });
  // The smoke check only needs the window painted, never on screen.
  win.once("ready-to-show", () => !smoke && win.show());
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  watchSmoke(win, () => server?.kill("SIGTERM"));
  // A file dropped where nothing takes it would load in place of the studio.
  if (process.platform !== "darwin")
    win.webContents.on("will-navigate", (e, target) => {
      if (target.startsWith("file:")) e.preventDefault();
    });
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: "deny" };
  });
  void win.loadURL(url);
  return win;
}

/** Bring up the canvas, and the dock icon if an agent started us in the background. */
function showWindow() {
  if (!serverUrl) return;
  if (process.platform === "darwin") void app.dock?.show();
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow(serverUrl);
  else if (splashing) void mainWindow.loadURL(serverUrl);
  else mainWindow.show();
  splashing = false;
  mainWindow.focus();
}

/**
 * Ponzu › Pair iPhone… before the studio could hear it: a window just created, or still
 * on the splash. The studio claims it as it starts listening.
 */
let pairPending = false;

/** Ponzu › Pair iPhone…: the studio shows a code the phone app scans. */
function pairIphone() {
  showWindow();
  const win = mainWindow;
  if (serverUrl && win && !splashing && !win.webContents.isLoading())
    win.webContents.send("ponzu:pair-iphone");
  else pairPending = true;
}

async function openDesign(path: string, artboard?: string) {
  if (!serverUrl) {
    pendingOpens.push(path);
    return;
  }
  showWindow();
  if (!mainWindow) return;
  await fetch(`${serverUrl}/api/files`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, by: "person" }),
  });
  const focus = artboard ? `&artboard=${encodeURIComponent(artboard)}` : "";
  await mainWindow.loadURL(`${serverUrl}/?file=${encodeURIComponent(path)}${focus}`);
  app.addRecentDocument(path);
  mainWindow.focus();
}

/**
 * A design on another of the person's Macs, in a tab through this Mac's relay to it: the studio
 * names those tabs `/peers/<name>` and the path, a line apart.
 */
async function openPeerDesign(mac: string, path: string, artboard?: string) {
  showWindow();
  if (!mainWindow) return;
  const tab = `/peers/${encodeURIComponent(mac)}\n${path}`;
  const focus = artboard ? `&artboard=${encodeURIComponent(artboard)}` : "";
  await mainWindow.loadURL(`${serverUrl}/?file=${encodeURIComponent(tab)}${focus}`);
  mainWindow.focus();
}

/**
 * Which Mac a link's design is on: "local" for this one, another's tailnet name, or null when
 * none Ponzu can reach has it. A link names its Mac; one from before links did is looked for here
 * first, then on the person's other Macs. `reached` says whether the named Mac answered: this
 * one, or one listed in the catalog.
 */
async function locate(
  mac: string | undefined,
  path: string,
): Promise<{ at: string | null; reached: boolean }> {
  const here = existsSync(join(path, "design.json"));
  const get = <T>(route: string) =>
    fetch(`${serverUrl}${route}`)
      .then((r) => r.json() as Promise<T>)
      .catch(() => null);
  const [catalog, info] = await Promise.all([
    get<Catalog>("/api/catalog"),
    get<{ machine?: { name?: string | null } }>("/api/info"),
  ]);
  const reached =
    !mac || mac === info?.machine?.name || Boolean(catalog?.machines.some((m) => m.id === mac));
  const on = new Set(catalog?.files.filter((f) => f.key === path).map((f) => f.machine));
  if (mac && on.has(mac)) return { at: mac, reached };
  if (here) return { at: "local", reached };
  // Its Mac is off or not on this tailnet: another of the person's Macs may have the same folder.
  return { at: [...on].find((m) => m !== "local") ?? null, reached };
}

/**
 * A ponzu:// link. `ponzu://open?mac=<name>&file=<path>.design&artboard=<id>`, from an agent
 * handing over its work: open that design, on that artboard, from the Mac it's on: this one, or
 * another of the person's over Tailscale. Only one that's already there: a link never makes a
 * folder.
 *
 * `ponzu://open?repo=<owner>/<repo>&ref=<ref>&path=<path>.design`, from ponzu.design's Open in
 * Ponzu button: clone the repo into ~/Ponzu (or fetch the clone there), check out the ref, and
 * open the design. The link is checked in @ponzu/server/clone before git sees any of it.
 */
async function openLink(url: string) {
  const local = parseDesignLink(url);
  if (local) {
    if (!serverUrl) {
      pendingLinks.push(url);
      return;
    }
    const { at, reached } = await locate(local.mac, local.path);
    if (at === "local") await openDesign(local.path, local.artboard);
    else if (at) await openPeerDesign(at, local.path, local.artboard);
    // Only a Mac that didn't answer is unreachable; one that did just doesn't have it.
    else if (local.mac && !reached)
      dialog.showErrorBox(
        `Ponzu can't reach ${local.mac}`,
        `${local.path} is on ${local.mac}. Open it once that Mac is on and running Tailscale.`,
      );
    else
      dialog.showErrorBox(
        "Ponzu can't find that design",
        local.mac ? `${local.path} isn't on ${local.mac}.` : local.path,
      );
    return;
  }
  const target = parseOpenUrl(url);
  if (!target) {
    dialog.showErrorBox("Ponzu can't open that link", url);
    return;
  }
  showWindow();
  try {
    const { path } = await cloneTarget(target, spawnGit("ignore"));
    await openDesign(path);
  } catch (err) {
    dialog.showErrorBox(
      `Ponzu couldn't open ${target.owner}/${target.repo}`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function pickDesign(): Promise<string | null> {
  // Windows and Linux pick a file or a folder, not either: a design is a folder.
  if (process.platform !== "darwin") {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: "Open a .design folder",
      properties: ["openDirectory"],
    });
    const p = res.filePaths[0];
    return p ? designPath(p) : null;
  }
  const res = await dialog.showOpenDialog(mainWindow!, {
    title: "Open a .design",
    properties: ["openFile", "openDirectory"],
    filters: [{ name: "Ponzu Design", extensions: ["design"] }],
  });
  const p = res.filePaths[0];
  return p && p.endsWith(".design") ? p : null;
}

async function newDesign(): Promise<string | null> {
  const res = await dialog.showSaveDialog(mainWindow!, {
    title: "New design",
    defaultPath: join(app.getPath("documents"), "Untitled.design"),
    buttonLabel: "Create",
  });
  if (res.canceled || !res.filePath) return null;
  return res.filePath.endsWith(".design") ? res.filePath : `${res.filePath}.design`;
}

ipcMain.handle("ponzu:open-folder", () => pickDesign());
ipcMain.handle("ponzu:new-file", () => newDesign());
ipcMain.on("ponzu:reveal", (_e, path: string) => shell.showItemInFolder(path));
/** Windows and Linux: which of the paths dropped on the window are designs (preload.ts). */
ipcMain.on("ponzu:designs", (e, paths: string[]) => {
  e.returnValue = paths.map(designPath).filter((p): p is string => Boolean(p));
});
/** Then open them, one after another: each loads in the same window. */
ipcMain.on("ponzu:open-designs", (_e, designs: string[]) => void openAll(designs));

async function openAll(designs: readonly string[]) {
  for (const design of designs) await openDesign(design);
}
ipcMain.handle("ponzu:pair-iphone-pending", () => {
  const pending = pairPending;
  pairPending = false;
  return pending;
});
ipcMain.on("ponzu:close-window", (e) => BrowserWindow.fromWebContents(e.sender)?.close());

/** Check for Updates… and Pair iPhone…: the Mac's app menu, and Help and the tray elsewhere. */
function appItems(): Electron.MenuItemConstructorOptions[] {
  return [
    {
      label: "Check for Updates…",
      click: () => {
        showWindow();
        if (mainWindow) void checkForUpdatesNow(mainWindow);
      },
    },
    { label: "Pair iPhone…", click: () => pairIphone() },
  ];
}

/**
 * Windows and Linux: Ponzu in the tray. Closing its last window leaves it serving agents, the
 * iPhone and the person's other computers, as the Mac's dock does, until they quit it here or
 * agents go quiet (watchIdle).
 */
let tray: Tray | null = null;
function createTray() {
  if (process.platform === "darwin" || tray) return;
  // Linux's trays scale the icon to the panel themselves; Windows' takes 16px, and @2x beside it.
  const icon = nativeImage.createFromPath(
    join(paths.tray, process.platform === "win32" ? "tray.png" : "tray@2x.png"),
  );
  tray = new Tray(icon);
  tray.setToolTip("Ponzu");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Ponzu", click: () => showWindow() },
      { type: "separator" },
      ...appItems(),
      { type: "separator" },
      { label: "Quit Ponzu", click: () => app.quit() },
    ]),
  );
  // Windows: a click opens the window, as the right-click menu's first item does.
  tray.on("click", () => showWindow());
}

function buildMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              ...appItems(),
              { label: "Install Terminal Command…", click: () => void installCommand() },
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "New Design…",
          accelerator: "CmdOrCtrl+N",
          click: async () => {
            const p = await newDesign();
            if (p) await openDesign(p);
          },
        },
        {
          label: "Open…",
          accelerator: "CmdOrCtrl+O",
          click: async () => {
            const p = await pickDesign();
            if (p) await openDesign(p);
          },
        },
        {
          role: "recentDocuments",
          submenu: [{ role: "clearRecentDocuments" }],
        } as Electron.MenuItemConstructorOptions,
        { type: "separator" },
        {
          label: "Copy MCP URL",
          click: () => serverUrl && clipboard.writeText(`${serverUrl}/mcp`),
        },
        { type: "separator" },
        {
          label: "Close Tab",
          accelerator: "CmdOrCtrl+W",
          click: (_item, win) => {
            if (win instanceof BrowserWindow) win.webContents.send("ponzu:close-tab");
          },
        },
        { role: "close", accelerator: "CmdOrCtrl+Shift+W" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "ponzu.design", click: () => shell.openExternal("https://ponzu.design") },
        // Off the Mac, there's no app menu to hold these.
        ...(process.platform === "darwin" ? [] : [{ type: "separator" as const }, ...appItems()]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv, cwd) => {
    // Another agent asking for the app: it's already serving.
    if (argv.includes("--background")) return;
    // Linux and Windows hand a second launch its ponzu:// link, or the design it opens, in argv.
    const { links, designs } = launchArgs(argv, cwd);
    if (links[0]) void openLink(links[0]);
    else if (designs.length) void openAll(designs);
    else showWindow();
  });

  // macOS: double-clicking a .design or dropping it on the dock icon.
  app.on("open-file", (e, path) => {
    e.preventDefault();
    void openDesign(path);
  });

  // macOS: a ponzu:// link. It can arrive before ready, when it's what launched us: hold it
  // until the server is up.
  app.setAsDefaultProtocolClient("ponzu");
  app.on("open-url", (e, url) => {
    e.preventDefault();
    if (serverUrl) void openLink(url);
    else pendingLinks.push(url);
  });

  app.whenReady().then(async () => {
    if (!smoke && relaunchedInBackground()) background = true;
    buildMenu();
    // Opened by the person: a window now, on the splash, rather than a bouncing dock icon.
    // The smoke check must see the studio itself paint, and agents start us without one.
    if (!smoke && !background) {
      mainWindow = createWindow(splashUrl());
      splashing = true;
    }
    const render = await startRenderHost();
    // The server lists what the updater has and asks it to install, so it starts first.
    const updater = smoke
      ? null
      : await installUpdater({
          window: () => mainWindow,
          onReady: () => (updateReady = true),
          agentWorking: async () => {
            if (!serverUrl) return false;
            const res = await fetch(`${serverUrl}/api/info`, { signal: AbortSignal.timeout(2000) });
            return Boolean(((await res.json()) as { working?: string }).working);
          },
        });
    try {
      // Agents find the server through ~/.ponzu/host.json on any port. 7777 is
      // for anything pointed at a fixed URL.
      serverUrl = await startServer(render, 7777, updater).catch(() =>
        startServer(render, 0, updater),
      );
    } catch (err) {
      if (smoke) {
        console.error(`smoke: server failed to start (${err})`);
        app.exit(1);
        return;
      }
      dialog.showErrorBox("Ponzu couldn't start", String(err));
      app.quit();
      return;
    }
    // Windows and Linux launch Ponzu with the design or link to open on its command line.
    const { links, designs } = launchArgs(process.argv, process.cwd());
    pendingOpens.push(...designs);
    pendingLinks.push(...links);
    if (!background || pendingOpens.length || pendingLinks.length || smoke) showWindow();
    else app.dock?.hide();
    createTray();
    if (!smoke) {
      setupAgents();
      setupWake();
      if (!isDev) void associateDesigns(process.execPath).catch(() => {});
      watchIdle();
      followAppearance();
    }
    for (const p of pendingOpens.splice(0)) await openDesign(p);
    for (const url of pendingLinks.splice(0)) await openLink(url);
  });

  app.on("activate", () => showWindow());

  // Ponzu keeps serving with no window: in the dock on a Mac, in the tray elsewhere.
  app.on("window-all-closed", () => {
    mainWindow = null;
  });

  // Windows' caption buttons follow the light or dark mode, as the studio does.
  nativeTheme.on("updated", () => {
    if (process.platform !== "win32") return;
    for (const win of BrowserWindow.getAllWindows()) win.setTitleBarOverlay(titleBarOverlay());
  });

  app.on("before-quit", () => {
    server?.kill("SIGTERM");
  });
}
