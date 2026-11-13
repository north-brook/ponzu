import { BrowserWindow } from "electron";
import { CHANNELS, type PictureRequest } from "./bridge.ts";
import { isStudio } from "./navigation.ts";
import type { PictureWindow } from "./pictures.ts";

/*
 * The hidden window comments' pictures are drawn in (pictures.ts): the studio, never shown, in
 * its own renderer, with a preload that gives it nothing but pictures to draw (picture-preload.ts).
 * It can't leave the studio or open anything. It keeps running hidden: its timers and frames are
 * not slowed, since a picture waits on them.
 */
export function createPictureWindow(opts: {
  url: string;
  preload: string;
  studio: readonly string[];
  devTools: boolean;
  events: { ready: () => void; gone: () => void };
}): { window: BrowserWindow; handle: PictureWindow } {
  const win = new BrowserWindow({
    // The picture's own size: the studio lays its scene out at that, off screen.
    width: 480,
    height: 320,
    show: false,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      preload: opts.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      backgroundThrottling: false,
      spellcheck: false,
      devTools: opts.devTools,
    },
  });
  let ended = false;
  const gone = () => {
    if (ended) return;
    ended = true;
    opts.events.gone();
  };
  win.once("closed", gone);
  win.webContents.on("render-process-gone", () => {
    gone();
    if (!win.isDestroyed()) win.destroy();
  });
  const stay = (event: Electron.Event, url: string) => {
    if (!isStudio(url, opts.studio)) event.preventDefault();
  };
  win.webContents.on("will-navigate", stay);
  win.webContents.on("will-redirect", stay);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  void win.loadURL(opts.url).catch(() => {
    gone();
    if (!win.isDestroyed()) win.destroy();
  });
  return {
    window: win,
    handle: {
      send: (id: number, request: PictureRequest) => {
        if (!win.isDestroyed()) win.webContents.send(CHANNELS.pictureHostRequest, id, request);
      },
      destroy: () => {
        // Asked to close: not `gone`.
        ended = true;
        if (!win.isDestroyed()) win.destroy();
      },
    },
  };
}
