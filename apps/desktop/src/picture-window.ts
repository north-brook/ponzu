import { BrowserWindow, type Session, session as sessions } from "electron";
import { CHANNELS, type PictureRequest } from "./bridge.ts";
import { isStudio } from "./navigation.ts";
import type { PictureWindow } from "./pictures.ts";

/*
 * The hidden window comments' pictures are drawn in (pictures.ts): the studio, never shown, with
 * a preload that gives it nothing but pictures to draw (picture-preload.ts). It can't leave the
 * studio or open anything. It keeps running hidden: its timers and frames are not slowed, since
 * a picture waits on them.
 *
 * It has a session of its own, kept in memory only. That is what makes Chromium give it a
 * renderer of its own: windows of one session showing one site may share a renderer, and with it
 * a main thread, and then drawing a picture would hold up the person's window all the same. (In
 * headless Chromium, a picture page sharing the window's renderer held the window up for 3 to 5 s
 * per comment; in a context of its own, not at all.) It also keeps the picture window away from
 * everything the person's window keeps: its storage, cookies and permissions.
 */

/** The picture window's session: in memory, nothing written to disk. */
export const PICTURE_PARTITION = "ponzu-pictures";

let prepared: Session | null = null;

/**
 * The picture window's session, set up once: the studio's scheme served in it as in the
 * window's (`serve`), and every permission refused.
 */
function pictureSession(scheme: Scheme | null): Session {
  if (prepared) return prepared;
  const session = sessions.fromPartition(PICTURE_PARTITION, { cache: false });
  if (scheme) session.protocol.handle(scheme.name, scheme.serve);
  session.setPermissionRequestHandler((_contents, _permission, grant) => grant(false));
  session.setPermissionCheckHandler(() => false);
  prepared = session;
  return session;
}

/** The studio's scheme (studio-files.ts's STUDIO_SCHEME) and how main.ts serves it. */
type Scheme = { name: string; serve: (request: Request) => Promise<Response> };

export function createPictureWindow(opts: {
  url: string;
  preload: string;
  studio: readonly string[];
  devTools: boolean;
  /** The studio's scheme and how it is served; null when it comes from Vite's dev server. */
  scheme: Scheme | null;
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
      session: pictureSession(opts.scheme),
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
