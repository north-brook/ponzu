import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, shell } from "electron";

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
}

const renderToken = randomBytes(24).toString("hex");
let renderDir: string | null = null;

async function renderJob(job: Job) {
  renderDir ??= await mkdtemp(join(tmpdir(), "ponzu-render-"));
  const file = join(renderDir, `${randomBytes(6).toString("hex")}.html`);
  await writeFile(file, job.html);
  const win = new BrowserWindow({
    show: false,
    width: Math.ceil(job.width),
    height: Math.min(Math.ceil(job.height), 16000),
    useContentSize: true,
    webPreferences: {
      offscreen: true,
      javascript: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  try {
    win.webContents.setFrameRate(1);
    await win.loadFile(file);
    win.webContents.setZoomFactor(job.scale);
    win.setContentSize(
      Math.ceil(job.width * job.scale),
      Math.min(Math.ceil(job.height * job.scale), 16000),
    );
    await win.webContents.executeJavaScript(
      "document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))",
    );
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
    };
  } finally {
    win.destroy();
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
        const job = JSON.parse(await body(req)) as Job;
        const out = await renderJob(job);
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
        cwd: app.getPath("documents"),
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
/* Windows                                                             */
/* ------------------------------------------------------------------ */

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
  win.once("ready-to-show", () => win.show());
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: "deny" };
  });
  void win.loadURL(url);
  return win;
}

async function openDesign(path: string) {
  if (!serverUrl || !mainWindow) {
    pendingOpens.push(path);
    return;
  }
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

function buildMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
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
        { role: "close" },
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
    const p = argv.find((a) => a.endsWith(".design"));
    if (p) void openDesign(p);
    mainWindow?.focus();
  });

  // macOS: double-clicking a .design or dropping it on the dock icon.
  app.on("open-file", (e, path) => {
    e.preventDefault();
    void openDesign(path);
  });

  app.whenReady().then(async () => {
    buildMenu();
    const render = await startRenderHost();
    try {
      // A stable port lets agents keep one MCP URL; fall back if it's taken.
      serverUrl = await startServer(render, 7777).catch(() => startServer(render, 0));
    } catch (err) {
      dialog.showErrorBox("Ponzu couldn't start", String(err));
      app.quit();
      return;
    }
    mainWindow = createWindow(serverUrl);
    const fromArgv = process.argv.find((a) => a.endsWith(".design"));
    if (fromArgv) pendingOpens.push(fromArgv);
    for (const p of pendingOpens.splice(0)) await openDesign(p);
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && serverUrl)
      mainWindow = createWindow(serverUrl);
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    server?.kill("SIGTERM");
  });
}
