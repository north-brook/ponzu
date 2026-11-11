import { app, type BrowserWindow, session } from "electron";

/*
 * CI and the release launch the packaged app with PONZU_SMOKE set and expect it to exit 0 once
 * the studio has drawn its sign-in screen. That proves the main process loaded, the studio came
 * off its own scheme, and React ran far enough to put the first screen up. It never touches the
 * keychain (the session lives in memory, so it starts signed out) or the network (every request
 * that would leave the computer is refused, and each is logged). A main process that fails to
 * load hangs on Electron's error dialog until the caller's timeout; a studio that fails exits 1.
 */
export const smoke = Boolean(process.env.PONZU_SMOKE);

/** How long the studio has to draw the sign-in screen. */
const PAINT_WITHIN_MS = 60_000;

export function blockNetwork(): void {
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
    (details, callback) => {
      console.error(`smoke: refused ${details.url}`);
      callback({ cancel: true });
    },
  );
}

export function watchSmoke(window: BrowserWindow): void {
  const exit = (code: number, why: string) => {
    console.error(`smoke: ${why}, exiting ${code}`);
    app.exit(code);
  };
  const started = Date.now();
  const look = async () => {
    const drawn = await window.webContents
      .executeJavaScript(`Boolean(document.querySelector('[data-screen="sign-in"]'))`)
      .catch(() => false);
    if (drawn) return exit(0, "the sign-in screen is up");
    if (Date.now() - started > PAINT_WITHIN_MS) return exit(1, "no sign-in screen");
    setTimeout(look, 100);
  };
  window.webContents.once("did-finish-load", () => void look());
  window.webContents.once("did-fail-load", (_event, code, description) =>
    exit(1, `the studio failed to load (${code} ${description})`),
  );
  window.webContents.once("render-process-gone", (_event, details) =>
    exit(1, `the renderer is gone (${details.reason})`),
  );
}
