import { app, type BrowserWindow } from "electron";

/**
 * CI launches the packaged, signed app with PONZU_SMOKE set and expects it to
 * exit 0 once the studio has painted. That proves the bundled server started
 * (the window loads from it) and the renderer loaded. A main process that
 * fails to load hangs on Electron's error dialog until the caller's timeout;
 * a server or renderer failure exits 1.
 */
export const smoke = Boolean(process.env.PONZU_SMOKE);

/** `cleanup` runs before exiting: app.exit skips before-quit, which stops the server. */
export function watchSmoke(window: BrowserWindow, cleanup: () => void) {
  if (!smoke) return;
  const exit = (code: number) => {
    cleanup();
    app.exit(code);
  };
  // Exit on the next tick: the window's own ready-to-show listener still has to run.
  window.once("ready-to-show", () => {
    console.error("smoke: window painted, exiting 0");
    setImmediate(() => exit(0));
  });
  window.webContents.once("did-fail-load", (_event, code, description) => {
    console.error(`smoke: studio failed to load (${code} ${description})`);
    exit(1);
  });
  window.webContents.once("render-process-gone", (_event, details) => {
    console.error(`smoke: renderer process gone (${details.reason})`);
    exit(1);
  });
}
