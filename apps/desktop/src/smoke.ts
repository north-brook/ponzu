import { app, type BrowserWindow, session } from "electron";

/*
 * CI and the release launch the packaged app with PONZU_SMOKE set and expect it to exit 0 once
 * the studio has drawn its sign-in screen on the shell's bridge. That proves the main process
 * loaded, the preload exposed `window.ponzuDesktop` and it answers over IPC (signed out), the
 * studio came off its own scheme, and React ran far enough to put the first screen up. It never
 * touches the keychain (the session lives in memory, so it starts signed out), the network
 * (every request that would leave the computer is refused, and each is logged) or the person's
 * data: Chromium's profile goes in a throwaway folder (data-folder.ts), so checking a
 * packaged app on someone's Mac leaves their Ponzu as it was. A main process that fails to load
 * hangs on Electron's error dialog until the caller's timeout; a studio that fails, or comes up
 * without the bridge, exits 1.
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

/**
 * Asked in the page: "waiting" until a first screen is up, "signed out" once it is the sign-in
 * screen and the bridge says so over IPC, and anything else is why the check fails.
 */
const SEE = `(async () => {
  if (document.querySelector('[data-screen="cant-start"]')) return "the studio found no bridge";
  if (!document.querySelector('[data-screen="sign-in"]')) return "waiting";
  if (typeof window.ponzuDesktop !== "object") return "the sign-in screen is up without the bridge";
  const state = await window.ponzuDesktop.session.state();
  return state.status === "signed_out" ? "signed out" : "the bridge says " + state.status;
})()`;

/** `cleanUp` runs just before the check exits, whichever way: the throwaway folder goes. */
export function watchSmoke(window: BrowserWindow, cleanUp: () => void = () => {}): void {
  const exit = (code: number, why: string) => {
    console.error(`smoke: ${why}, exiting ${code}`);
    try {
      cleanUp();
    } catch (error) {
      console.error(`smoke: couldn't clean up (${error})`);
    }
    app.exit(code);
  };
  const started = Date.now();
  const look = async () => {
    const seen: string = await window.webContents.executeJavaScript(SEE).catch(() => "waiting");
    if (seen === "signed out") return exit(0, "the sign-in screen is up, on the bridge");
    if (seen !== "waiting") return exit(1, seen);
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
