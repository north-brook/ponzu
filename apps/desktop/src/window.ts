import { BrowserWindow, nativeTheme, shell } from "electron";
import { externalLink, isStudio } from "./navigation.ts";
import { shellGround } from "./shell-ground.ts";
import { trafficLights } from "./traffic-lights.ts";

/*
 * The main window. It shows the studio, which draws designs agents wrote and comments anyone
 * can leave, so it runs as a web page with nothing more: isolated, sandboxed, no Node, and
 * unable to leave the studio. A link out goes to the system browser once it checks out.
 */

/**
 * The frame. The Mac's traffic lights sit in the studio's 38px chrome, which leaves them room
 * (apps/studio/src/cloud/window/chrome.tsx); Windows and Linux keep their own title bar, since
 * the chrome's right end is the thread's.
 */
function frame(): Electron.BrowserWindowConstructorOptions {
  if (process.platform !== "darwin") return {};
  return {
    titleBarStyle: "hiddenInset",
    trafficLightPosition: trafficLights(process.getSystemVersion()),
  };
}

export function createMainWindow(opts: {
  url: string;
  preload: string;
  /** The studio's origins: its scheme, and Vite's dev server in a development build. */
  studio: readonly string[];
  /** Painted, but kept off screen (the smoke check). */
  hidden: boolean;
  /**
   * What the preload hands the studio: `--ponzu-<name>=<value>` on the renderer's command line.
   * The window adds `glass`: whether its ground is the Mac's material (shell-ground.ts).
   */
  args: Record<string, string>;
  /** Whether developer tools can open on the window at all: not in a release. */
  devTools: boolean;
}): BrowserWindow {
  const ground = shellGround(process.platform, nativeTheme.shouldUseDarkColors);
  const args = { ...opts.args, glass: ground.glass ? "1" : "0" };
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    // AppWindow's MIN_WINDOW: the sidebar, the thread rail and a canvas between them.
    minWidth: 1100,
    minHeight: 640,
    ...frame(),
    ...ground.options,
    show: false,
    webPreferences: {
      preload: opts.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      devTools: opts.devTools,
      additionalArguments: Object.entries(args).map(([name, value]) => `--ponzu-${name}=${value}`),
    },
  });
  win.once("ready-to-show", () => {
    if (!opts.hidden) win.show();
  });

  const leave = (event: Electron.Event, url: string) => {
    if (isStudio(url, opts.studio)) return;
    event.preventDefault();
    const link = externalLink(url);
    if (link) void shell.openExternal(link);
  };
  win.webContents.on("will-navigate", leave);
  win.webContents.on("will-redirect", leave);
  win.webContents.setWindowOpenHandler(({ url }) => {
    const link = externalLink(url);
    if (link) void shell.openExternal(link);
    return { action: "deny" };
  });
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  // Copying a canvas's link is the one permission the studio uses.
  const session = win.webContents.session;
  session.setPermissionRequestHandler((_contents, permission, grant) =>
    grant(permission === "clipboard-sanitized-write"),
  );
  session.setPermissionCheckHandler(
    (_contents, permission) => permission === "clipboard-sanitized-write",
  );

  void win.loadURL(opts.url);
  return win;
}
