import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, shell } from "electron";
import { smoke, watchSmoke } from "./smoke";
import { checkForUpdatesNow, installUpdater } from "./updater";
import { markWhatsNewSeen, pendingWhatsNew } from "./whats-new";

const isDev = !app.isPackaged;
/** The built main/preload live in <app>/dist, in development and inside the bundle. */
const here = join(app.getAppPath(), "dist");

/** Paths inside the app bundle, or the monorepo during development. */
const paths = {
  server: isDev ? join(here, "server/ponzu") : join(process.resourcesPath, "server/ponzu"),
  studio: isDev ? join(here, "../../studio/dist") : join(process.resourcesPath, "studio"),
  preload: join(here, "preload.cjs"),
};

let server: ChildProcess | null = null;
let serverUrl: string | null = null;
let mainWindow: BrowserWindow | null = null;
const pendingOpens: string[] = [];
/**
 * Started by an agent (`ponzu mcp`), not the person: serve without a window
 * or dock icon until they open Ponzu themselves.
 */
const background = process.argv.includes("--background");
let updateReady = false;

/* ------------------------------------------------------------------ */
/* Offscreen renderer: the server asks us for screenshots              */
/* ------------------------------------------------------------------ */

interface Job {
  html: string;
  width: number;
  height: number;
  selector: string;
  scale: number;
  format: "png" | "jpeg" | "pdf";
  lint: boolean;
  lintScript: string;
  /** Holds animations at the requested time; evaluates to the motion summary. */
  prepareScript?: string;
}

const renderToken = randomBytes(24).toString("hex");
let renderDir: string | null = null;

/** Writes the page to disk and loads it: file URLs reach assets and fonts like the canvas does. */
async function loadPage(win: BrowserWindow, html: string) {
  renderDir ??= await mkdtemp(join(tmpdir(), "ponzu-render-"));
  const file = join(renderDir, `${randomBytes(6).toString("hex")}.html`);
  await writeFile(file, html);
  await win.loadFile(file);
  void rm(file, { force: true });
}

function renderWindow(width: number, height: number) {
  const win = new BrowserWindow({
    show: false,
    width: Math.ceil(width),
    height: Math.min(Math.ceil(height), 16000),
    useContentSize: true,
    webPreferences: {
      offscreen: true,
      javascript: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  // Seeking an animation waits for two frames, so frames have to come quickly.
  win.webContents.setFrameRate(60);
  return win;
}

async function renderJob(job: Job) {
  const win = renderWindow(job.width, job.height);
  try {
    await loadPage(win, job.html);
    win.webContents.setZoomFactor(job.scale);
    win.setContentSize(
      Math.ceil(job.width * job.scale),
      Math.min(Math.ceil(job.height * job.scale), 16000),
    );
    await win.webContents.executeJavaScript(
      "document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))",
    );
    const motion = job.prepareScript
      ? await win.webContents.executeJavaScript(job.prepareScript)
      : undefined;
    if (motion?.error) return { motion };
    const box = (await win.webContents.executeJavaScript(
      `(() => { const el = document.querySelector(${JSON.stringify(job.selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height, contentHeight: document.querySelector('[data-artboard]')?.scrollHeight ?? 0 }; })()`,
    )) as { x: number; y: number; width: number; height: number; contentHeight: number } | null;
    if (!box) throw new Error("That node isn't in this artboard.");
    const issues = job.lint ? await win.webContents.executeJavaScript(job.lintScript) : [];
    if (job.format === "pdf") {
      const pdf = await win.webContents.printToPDF({
        printBackground: true,
        pageSize: { width: box.width / 96, height: box.height / 96 },
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
      });
      return {
        data: pdf.toString("base64"),
        mime: "application/pdf",
        width: box.width,
        height: box.height,
        contentHeight: box.contentHeight,
        issues,
        motion,
      };
    }
    if (box.y + box.height > job.height)
      win.setContentSize(
        Math.ceil(job.width * job.scale),
        Math.min(Math.ceil((box.y + box.height) * job.scale), 16000),
      );
    const image = await win.webContents.capturePage({
      x: Math.round(box.x * job.scale),
      y: Math.round(box.y * job.scale),
      width: Math.round(box.width * job.scale),
      height: Math.round(box.height * job.scale),
    });
    const buf = job.format === "jpeg" ? image.toJPEG(85) : image.toPNG();
    return {
      data: buf.toString("base64"),
      mime: job.format === "jpeg" ? "image/jpeg" : "image/png",
      width: box.width,
      height: box.height,
      contentHeight: box.contentHeight,
      issues,
      motion,
    };
  } finally {
    win.destroy();
  }
}

/* Recording steps through an animation on one live page, so it keeps a window per session. */

type SessionOp =
  | { op: "open"; html: string; width: number; height: number }
  | { op: "eval"; session: string; expression: string }
  | {
      op: "capture";
      session: string;
      box: { x: number; y: number; width: number; height: number };
      scale: number;
    }
  | { op: "show"; session: string; html: string; width: number; height: number }
  | { op: "close"; session: string };

interface Session {
  win: BrowserWindow;
  timer: NodeJS.Timeout;
  /** The viewport in CSS px, and the zoom it's shown at. */
  width: number;
  height: number;
  zoom: number;
}

const sessions = new Map<string, Session>();

/** Abandoned sessions close themselves. */
function keepAlive(id: string) {
  const s = sessions.get(id);
  if (!s) throw new Error(`No render session ${id}.`);
  clearTimeout(s.timer);
  s.timer = setTimeout(() => closeSession(id), 60_000);
  return s;
}

function closeSession(id: string) {
  const s = sessions.get(id);
  if (!s) return;
  clearTimeout(s.timer);
  sessions.delete(id);
  s.win.destroy();
}

/** Sizes the viewport in CSS px; zoom renders it sharper, like a device pixel ratio. */
async function sizeTo(s: Session, width: number, height: number, zoom = s.zoom) {
  s.width = width;
  s.height = height;
  s.zoom = zoom;
  s.win.webContents.setZoomFactor(zoom);
  s.win.setContentSize(Math.ceil(width * zoom), Math.min(Math.ceil(height * zoom), 16000));
  await s.win.webContents.executeJavaScript(
    "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))",
  );
}

async function sessionOp(op: SessionOp) {
  switch (op.op) {
    case "open": {
      const id = randomBytes(8).toString("hex");
      const win = renderWindow(op.width, op.height);
      const s: Session = {
        win,
        timer: setTimeout(() => closeSession(id), 60_000),
        width: op.width,
        height: op.height,
        zoom: 1,
      };
      sessions.set(id, s);
      try {
        await loadPage(win, op.html);
        await win.webContents.executeJavaScript("document.fonts.ready.then(() => true)");
        // Tall artboards (height: fit-content) need the whole of themselves on screen.
        const tall = await win.webContents.executeJavaScript(
          "document.querySelector('[data-artboard]')?.getBoundingClientRect().bottom ?? 0",
        );
        if (tall > op.height) await sizeTo(s, op.width, tall);
      } catch (err) {
        closeSession(id);
        throw err;
      }
      return { session: id };
    }
    case "eval":
      return {
        value: await keepAlive(op.session).win.webContents.executeJavaScript(op.expression),
      };
    case "capture": {
      const s = keepAlive(op.session);
      // Enlarged frames render at that zoom so text stays sharp; smaller ones are scaled down.
      const zoom = Math.max(1, op.scale);
      if (zoom !== s.zoom) await sizeTo(s, s.width, s.height, zoom);
      const rect = {
        x: Math.round(op.box.x * zoom),
        y: Math.round(op.box.y * zoom),
        width: Math.max(1, Math.round(op.box.width * zoom)),
        height: Math.max(1, Math.round(op.box.height * zoom)),
      };
      let image = await s.win.webContents.capturePage(rect);
      const width = Math.max(1, Math.round(op.box.width * op.scale));
      if (image.getSize().width !== width)
        image = image.resize({ width, quality: op.scale < 1 ? "best" : "good" });
      return { data: image.toPNG().toString("base64") };
    }
    case "show": {
      const s = keepAlive(op.session);
      await loadPage(s.win, op.html);
      await s.win.webContents.executeJavaScript(
        "Promise.all([...document.images].map((i) => i.decode().catch(() => {})))",
      );
      await sizeTo(s, op.width, op.height, 1);
      return {};
    }
    case "close":
      closeSession(op.session);
      return {};
  }
}

function startRenderHost(): Promise<string> {
  return new Promise((resolve) => {
    const http = createServer(async (req, res) => {
      if (req.method !== "POST" || req.headers.authorization !== `Bearer ${renderToken}`) {
        res.writeHead(403).end();
        return;
      }
      try {
        const payload = JSON.parse(await body(req));
        const out = req.url === "/session" ? await sessionOp(payload) : await renderJob(payload);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
      } catch (err) {
        res.writeHead(500).end(err instanceof Error ? err.message : String(err));
      }
    });
    http.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(http.address() as AddressInfo).port}/render`),
    );
  });
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

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

function startServer(renderEndpoint: string, port: number): Promise<string> {
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
          PONZU_RENDER_ENDPOINT: renderEndpoint,
          PONZU_RENDER_TOKEN: renderToken,
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
 * What the window shows while the server starts: the juicing wedge, faded in
 * only if the start takes long enough to notice. Self-contained, so it paints
 * before anything else is up.
 */
function splashUrl() {
  const seg = (points: string, delay: number) =>
    `<polygon points="${points}" style="animation-delay:${delay}s"/>`;
  const html = `<!doctype html><meta charset="utf-8"><style>
:root{color-scheme:light dark;background:#e9e9e6}
@media (prefers-color-scheme:dark){:root{background:#0a0a0a}}
body{margin:0;height:100vh;display:grid;place-items:center;-webkit-app-region:drag}
svg{opacity:0;animation:in .3s ease-out .3s forwards}
g polygon{fill:#FFD23F;animation:juice 1.8s ease-in-out infinite}
@keyframes in{to{opacity:1}}
@keyframes juice{0%{opacity:.15}18%,42%{opacity:1}64%,100%{opacity:.15}}
@media (prefers-reduced-motion:reduce){svg{opacity:1;animation:none}g polygon{animation:none}}
</style><svg width="44" height="44" viewBox="0 0 64 64"><defs><clipPath id="c"><path d="M19.57 9.61A24.62 24.62 0 0 0 54.39 44.43Z"/></clipPath></defs>
<path fill="#F4B012" d="M12.96 3.00A33.96 33.96 0 0 0 61.00 51.04Z"/><path fill="#FFF3CF" d="M17.08 7.12A28.14 28.14 0 0 0 56.88 46.92Z"/>
<g clip-path="url(#c)">${seg("34.49,29.51 -30,41.2 -60,-60 60,-60", 0)}${seg("34.49,29.51 -30,41.2 -60,120 22.85,93.4", 0.3)}${seg("34.49,29.51 22.85,93.4 120,120 120,-60", 0.6)}</g>
<path fill="#FFF3CF" d="M17.08 7.12L56.88 46.92L54.39 49.41L14.59 9.61Z"/><path stroke="#FFF3CF" d="M34.49 29.51L30.61 50.80M34.49 29.51L13.20 33.39" stroke-width="3.4" stroke-linecap="round" fill="none"/></svg>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/** A window on the splash, until the server is up. */
let splashing = false;

function createWindow(url: string) {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 16, y: 13 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#e9e9e6",
    show: false,
    webPreferences: { preload: paths.preload, contextIsolation: true, sandbox: true },
  });
  // The smoke check only needs the window painted, never on screen.
  win.once("ready-to-show", () => !smoke && win.show());
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  watchSmoke(win, () => server?.kill("SIGTERM"));
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

async function openDesign(path: string) {
  if (!serverUrl) {
    pendingOpens.push(path);
    return;
  }
  showWindow();
  if (!mainWindow) return;
  await fetch(`${serverUrl}/api/files`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });
  await mainWindow.loadURL(`${serverUrl}/?file=${encodeURIComponent(path)}`);
  app.addRecentDocument(path);
  mainWindow.focus();
}

async function pickDesign(): Promise<string | null> {
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
ipcMain.handle("ponzu:whats-new", () => pendingWhatsNew());
ipcMain.on("ponzu:whats-new-seen", () => markWhatsNewSeen());
ipcMain.on("ponzu:close-window", (e) => BrowserWindow.fromWebContents(e.sender)?.close());

function buildMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { label: "Check for Updates…", click: () => void checkForUpdatesNow() },
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
      submenu: [{ label: "ponzu.design", click: () => shell.openExternal("https://ponzu.design") }],
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
  app.on("second-instance", (_e, argv) => {
    // Another agent asking for the app: it's already serving.
    if (argv.includes("--background")) return;
    const p = argv.find((a) => a.endsWith(".design"));
    if (p) void openDesign(p);
    else showWindow();
  });

  // macOS: double-clicking a .design or dropping it on the dock icon.
  app.on("open-file", (e, path) => {
    e.preventDefault();
    void openDesign(path);
  });

  app.whenReady().then(async () => {
    buildMenu();
    // Opened by the person: a window now, on the splash, rather than a bouncing dock icon.
    // The smoke check must see the studio itself paint, and agents start us without one.
    if (!smoke && !background) {
      mainWindow = createWindow(splashUrl());
      splashing = true;
    }
    const render = await startRenderHost();
    try {
      // Agents find the server through ~/.ponzu/host.json on any port. 7777 is
      // for anything pointed at a fixed URL.
      serverUrl = await startServer(render, 7777).catch(() => startServer(render, 0));
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
    const fromArgv = process.argv.find((a) => a.endsWith(".design"));
    if (fromArgv) pendingOpens.push(fromArgv);
    if (!background || pendingOpens.length || smoke) showWindow();
    else app.dock?.hide();
    if (!smoke) {
      installUpdater({ quiet: () => !mainWindow, onReady: () => (updateReady = true) });
      setupAgents();
      watchIdle();
    }
    for (const p of pendingOpens.splice(0)) await openDesign(p);
  });

  app.on("activate", () => showWindow());

  app.on("window-all-closed", () => {
    mainWindow = null;
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    server?.kill("SIGTERM");
  });
}
